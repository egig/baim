use serde::{Deserialize, Serialize};

use crate::db::Db;

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
    db: &Db,
    data_uri: &str,
    prompt: &str,
    api_key: &str,
) -> Result<Generation, String> {
    match do_create(db, data_uri, prompt, api_key).await {
        Ok(gen) => Ok(gen),
        Err(err) => {
            let record = new_generation(prompt, data_uri, "failed", None, None, Some(err.clone()));
            let _ = db.upsert_generation(&record);
            Err(err)
        }
    }
}

async fn do_create(
    db: &Db,
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
    record.id = prediction.id;
    apply_prediction_status(&mut record, &prediction.status, prediction.error);
    let _ = db.upsert_generation(&record);

    Ok(record)
}

/// Poll a stored `pending` generation once and advance it if the prediction has
/// reached a terminal state. Downloads and saves the image on success. Records
/// that are already terminal are returned unchanged.
pub async fn refresh_generation(
    db: &Db,
    id: &str,
    api_key: &str,
) -> Result<Generation, String> {
    let mut record = db.load_generation(id).ok_or("Generation not found")?;

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

        let _ = db.upsert_generation(&record);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let entry = ImageEntry {
            path: filepath.to_string_lossy().to_string(),
            filename,
            created_at: now,
            size_bytes: img_bytes.len() as u64,
        };
        println!("inserting image {}", entry.path);
        let _ = db.insert_image(&entry);
    } else {
        apply_prediction_status(&mut record, &prediction.status, prediction.error);
        let _ = db.upsert_generation(&record);
    }

    Ok(record)
}

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

pub fn get_images_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join("Pictures").join("catalog-gen"))
}

/// Delete a saved image file and its associated generation record.
/// The path is canonicalized and required to sit directly inside the images
/// directory, so a path coming back from the frontend can't remove sidecar
/// records or escape the directory via `..`/symlinks.
pub fn delete_image(db: &Db, path: &str) -> Result<(), String> {
    let canonical_dir = get_images_dir()?
        .canonicalize()
        .map_err(|e| format!("Images directory unavailable: {}", e))?;
    let canonical_target = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Image not found: {}", e))?;

    if canonical_target.parent() != Some(canonical_dir.as_path()) {
        return Err("Refusing to delete a file outside the images directory".to_string());
    }

    let path_str = canonical_target.to_string_lossy().to_string();

    std::fs::remove_file(&canonical_target)
        .map_err(|e| format!("Failed to delete image: {}", e))?;

    db.delete_image_by_path(&path_str)?;
    if let Some(gen_id) = db.find_generation_by_output_path(&path_str) {
        db.delete_generation_by_id(&gen_id)?;
    }

    Ok(())
}

pub fn list_saved_images(db: &Db) -> Result<Vec<ImageEntry>, String> {
    db.list_images()
}

pub fn list_generations(db: &Db) -> Result<Vec<Generation>, String> {
    db.list_generations()
}

/// Accept a client-side normalized PNG data URI, decode it, save the file, and
/// insert a row into the images table. Returns the new ImageEntry so the
/// frontend can select it immediately.
pub fn save_uploaded_image(db: &Db, data_uri: &str) -> Result<ImageEntry, String> {
    use base64::Engine;

    let images_dir = get_images_dir()?;
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create images directory: {}", e))?;

    let encoded = data_uri
        .split(',')
        .nth(1)
        .ok_or_else(|| "Invalid data URI".to_string())?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Failed to decode image data: {}", e))?;

    let filename = format!("{}.png", uuid::Uuid::new_v4());
    let filepath = images_dir.join(&filename);

    std::fs::write(&filepath, &bytes)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let entry = ImageEntry {
        path: filepath.to_string_lossy().to_string(),
        filename,
        created_at: now,
        size_bytes: bytes.len() as u64,
    };

    db.insert_image(&entry)?;
    Ok(entry)
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
