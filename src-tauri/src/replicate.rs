use serde::{Deserialize, Serialize};

/// Model output format. Kept as a constant so the request payload and the saved
/// file extension can never drift apart.
const OUTPUT_FORMAT: &str = "jpg";

#[derive(Debug, Deserialize)]
struct Prediction {
    id: String,
    status: String,
    output: Option<serde_json::Value>,
    error: Option<String>,
    urls: Option<PredictionUrls>,
}

#[derive(Debug, Deserialize)]
struct PredictionUrls {
    get: Option<String>,
}

/// Create a prediction in Replicate's async mode (no `Prefer: wait` header):
/// the request returns immediately with a prediction id and `status:
/// "starting"`. We store the generation as `pending` (keyed by the Replicate
/// prediction id) along with the `urls.get` poll URL, and let the frontend call
/// `refresh_generation` later to advance it to `succeeded`/`failed`.
pub async fn create_prediction(
    data_uri: &str,
    prompt: &str,
    api_key: &str,
) -> Result<Generation, String> {
    match do_create(data_uri, prompt, api_key).await {
        Ok(gen) => Ok(gen),
        Err(err) => {
            // Record the failed attempt so the user can retry from the same
            // source image and prompt.
            let record = new_generation(prompt, data_uri, "failed", None, None, Some(err.clone()));
            write_generation(&record);
            Err(err)
        }
    }
}

async fn do_create(
    data_uri: &str,
    prompt: &str,
    api_key: &str,
) -> Result<Generation, String> {
    let client = reqwest::Client::new();

    let model = "google/nano-banana-2";
    let payload = serde_json::json!({
        "input": {
            "prompt": prompt,
            "resolution": "1K",
            "image_input": [data_uri],
            "aspect_ratio": "1:1",
            "output_format": OUTPUT_FORMAT,
        }
    });
    let url = format!(
        "https://api.replicate.com/v1/models/{}/predictions",
        model
    );

    // Async mode: no `Prefer: wait` header, so this returns as soon as the
    // prediction is queued rather than blocking until it finishes.
    let create_resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to create prediction: {}", e))?;

    let status = create_resp.status();
    if !status.is_success() {
        let body = create_resp
            .text()
            .await
            .unwrap_or_else(|_| "unknown".to_string());
        return Err(match status.as_u16() {
            402 => "API quota exceeded or payment required".to_string(),
            429 => format!(
                "Rate limited by Replicate (429). Accounts without a payment method are \
                 capped at ~6 requests/min; add billing at replicate.com/account/billing. \
                 Response: {}",
                body
            ),
            _ => format!("Replicate API error ({}): {}", status, body),
        });
    }

    let prediction: Prediction = create_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let poll_url = prediction.urls.and_then(|u| u.get);

    let mut record = new_generation(prompt, data_uri, "pending", poll_url, None, None);
    // Key the record by Replicate's prediction id so `refresh_generation` can
    // find it, and reflect any status/error the create response already carried.
    record.id = prediction.id;
    apply_prediction_status(&mut record, &prediction.status, prediction.error);
    write_generation(&record);

    Ok(record)
}

/// Poll a stored `pending` generation once and advance it if the prediction has
/// reached a terminal state. Downloads and saves the image on success. Records
/// that are already terminal are returned unchanged.
pub async fn refresh_generation(id: &str, api_key: &str) -> Result<Generation, String> {
    let mut record = load_generation(id).ok_or("Generation not found")?;

    if record.status != "pending" {
        return Ok(record);
    }

    let poll_url = record
        .poll_url
        .clone()
        .ok_or("This generation has no poll URL to refresh")?;

    let client = reqwest::Client::new();
    let resp = client
        .get(&poll_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch prediction status: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_else(|_| "unknown".to_string());
        return Err(format!(
            "Failed to fetch prediction status ({}): {}",
            status, body
        ));
    }

    let prediction: Prediction = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse status response: {}", e))?;

    if prediction.status == "succeeded" {
        let output = prediction.output.ok_or("No output from model")?;
        let image_url = output
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|v| v.as_str())
            .or_else(|| output.as_str())
            .ok_or("Unexpected output format")?
            .to_string();

        let images_dir = get_images_dir()?;
        let filename = format!("{}.{}", record.id, OUTPUT_FORMAT);
        let filepath = images_dir.join(&filename);

        let img_bytes = client
            .get(&image_url)
            .send()
            .await
            .map_err(|e| format!("Failed to download image: {}", e))?
            .bytes()
            .await
            .map_err(|e| format!("Failed to read image bytes: {}", e))?;

        std::fs::create_dir_all(&images_dir)
            .map_err(|e| format!("Failed to create images directory: {}", e))?;
        std::fs::write(&filepath, &img_bytes)
            .map_err(|e| format!("Failed to save image: {}", e))?;

        record.status = "succeeded".to_string();
        record.output_path = Some(filepath.to_string_lossy().to_string());
        record.error = None;
    } else {
        apply_prediction_status(&mut record, &prediction.status, prediction.error);
    }

    write_generation(&record);
    Ok(record)
}

/// Map a Replicate prediction status onto our stored record. `starting` and
/// `processing` stay `pending`; `failed`/`canceled` become `failed`.
fn apply_prediction_status(record: &mut Generation, status: &str, error: Option<String>) {
    match status {
        "failed" | "canceled" => {
            record.status = "failed".to_string();
            record.error = Some(error.unwrap_or_else(|| status.to_string()));
        }
        _ => {
            record.status = "pending".to_string();
        }
    }
}

fn get_images_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join("Pictures").join("catalog-gen"))
}

/// Delete a saved image file and its associated generation sidecar.
/// The path is canonicalized and required to sit directly inside the images
/// directory, so a path coming back from the frontend can't remove the
/// `generations` sidecars or escape the directory via `..`/symlinks and
/// delete arbitrary files.
pub fn delete_image(path: &str) -> Result<(), String> {
    let canonical_dir = get_images_dir()?
        .canonicalize()
        .map_err(|e| format!("Images directory unavailable: {}", e))?;
    let canonical_target = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Image not found: {}", e))?;

    // Must be a file living directly in the images dir (not the generations
    // subdirectory, not anything outside the scope).
    if canonical_target.parent() != Some(canonical_dir.as_path()) {
        return Err("Refusing to delete a file outside the images directory".to_string());
    }

    let path_str = canonical_target.to_string_lossy().to_string();

    std::fs::remove_file(&canonical_target).map_err(|e| format!("Failed to delete image: {}", e))?;

    // Clean up the corresponding generation sidecar, if any.
    if let Ok(gens) = list_generations() {
        for gen in gens {
            if gen.output_path.as_deref() == Some(&path_str) {
                if is_safe_id(&gen.id) {
                    if let Ok(dir) = get_generations_dir() {
                        let _ = std::fs::remove_file(dir.join(format!("{}.json", gen.id)));
                    }
                }
                break;
            }
        }
    }

    Ok(())
}

pub fn list_saved_images() -> Result<Vec<ImageEntry>, String> {
    let dir = get_images_dir()?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut entries = vec![];
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read images directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "png" || ext == "jpg" || ext == "jpeg")
                .unwrap_or(false)
        })
        .collect();

    paths.sort_by_key(|e| {
        std::cmp::Reverse(
            e.metadata()
                .and_then(|m| m.created())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        )
    });

    for entry in paths {
        let path = entry.path();
        let created = entry
            .metadata()
            .ok()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let size = entry
            .metadata()
            .ok()
            .map(|m| m.len())
            .unwrap_or(0);

        entries.push(ImageEntry {
            path: path.to_string_lossy().to_string(),
            filename: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            created_at: created,
            size_bytes: size,
        });
    }

    Ok(entries)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImageEntry {
    pub path: String,
    pub filename: String,
    pub created_at: i64,
    pub size_bytes: u64,
}

/// A generation attempt, stored as a JSON sidecar so the user can re-run it or
/// poll its status. The source image is kept inline as a data URI (the same
/// value that was sent to the model), so re-generating needs no extra decoding
/// on either side.
///
/// `status` is one of:
/// - `"pending"`  — created in async mode, awaiting a `refresh_generation` poll.
///   `poll_url` holds Replicate's `urls.get`; `output_path`/`error` are `None`.
/// - `"succeeded"` — `output_path` points at the saved image.
/// - `"failed"`   — `error` is set; can be retried from the source.
#[derive(Debug, Serialize, Deserialize)]
pub struct Generation {
    pub id: String,
    pub prompt: String,
    pub input_data_uri: String,
    pub status: String,
    #[serde(default)]
    pub poll_url: Option<String>,
    pub output_path: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
}

/// Sidecar records live in a subdirectory so `list_saved_images` (which scans
/// only the top-level directory for image files) never picks them up.
fn get_generations_dir() -> Result<std::path::PathBuf, String> {
    Ok(get_images_dir()?.join("generations"))
}

/// Build an in-memory record with a fresh uuid id and the current timestamp.
/// Callers may overwrite `id` (e.g. with a Replicate prediction id) before
/// persisting with `write_generation`.
fn new_generation(
    prompt: &str,
    input_data_uri: &str,
    status: &str,
    poll_url: Option<String>,
    output_path: Option<String>,
    error: Option<String>,
) -> Generation {
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    Generation {
        id: uuid::Uuid::new_v4().to_string(),
        prompt: prompt.to_string(),
        input_data_uri: input_data_uri.to_string(),
        status: status.to_string(),
        poll_url,
        output_path,
        error,
        created_at,
    }
}

/// Reject ids that aren't a plain uuid / Replicate prediction id, so a record
/// id coming back from the frontend can't escape the generations directory.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn write_generation(record: &Generation) {
    if !is_safe_id(&record.id) {
        return;
    }
    let dir = match get_generations_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_string(record) {
        let _ = std::fs::write(dir.join(format!("{}.json", record.id)), json);
    }
}

fn load_generation(id: &str) -> Option<Generation> {
    if !is_safe_id(id) {
        return None;
    }
    let path = get_generations_dir().ok()?.join(format!("{}.json", id));
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

pub fn list_generations() -> Result<Vec<Generation>, String> {
    let dir = get_generations_dir()?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut records: Vec<Generation> = std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read generations directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .filter(|e| e.path().extension().map(|ext| ext == "json").unwrap_or(false))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|s| serde_json::from_str::<Generation>(&s).ok())
        .collect();

    records.sort_by_key(|r| std::cmp::Reverse(r.created_at));
    Ok(records)
}
