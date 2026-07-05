use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::provider::{
    get_provider, CreateOutcome, GenerateRequest, PollOutcome, DEFAULT_PROVIDER,
};

/// Kick off a generation with the chosen provider. Async providers return a
/// `pending` record with a poll URL (advanced later by `refresh_generation`);
/// synchronous providers return the image immediately, which we save and record
/// as `succeeded`. The chosen `provider_id` is persisted on the record so a
/// later refresh knows which backend to poll.
pub async fn create_prediction(
    db: &Db,
    data_uri: &str,
    prompt: &str,
    provider_id: &str,
) -> Result<Generation, String> {
    match do_create(db, data_uri, prompt, provider_id).await {
        Ok(gen) => Ok(gen),
        Err(err) => {
            let record = new_generation(
                prompt,
                data_uri,
                provider_id,
                "failed",
                None,
                None,
                Some(err.clone()),
            );
            let _ = db.upsert_generation(&record);
            Err(err)
        }
    }
}

async fn do_create(
    db: &Db,
    data_uri: &str,
    prompt: &str,
    provider_id: &str,
) -> Result<Generation, String> {
    let provider =
        get_provider(provider_id).ok_or_else(|| format!("Unknown provider: {}", provider_id))?;

    let api_key = db
        .read_api_key(provider_id)
        .ok_or_else(|| format!("No API key set for {}", provider_id))?;

    let outcome = provider
        .create(GenerateRequest {
            prompt: prompt.to_string(),
            image_data_uri: data_uri.to_string(),
            api_key,
        })
        .await?;

    match outcome {
        CreateOutcome::Pending { poll_url } => {
            let record = new_generation(
                prompt,
                data_uri,
                provider_id,
                "pending",
                Some(poll_url),
                None,
                None,
            );
            let _ = db.upsert_generation(&record);
            Ok(record)
        }
        CreateOutcome::Done { image_bytes, ext } => {
            let mut record =
                new_generation(prompt, data_uri, provider_id, "pending", None, None, None);
            save_generated_image(db, &mut record, &image_bytes, &ext)?;
            Ok(record)
        }
    }
}

/// Poll a stored `pending` generation once and advance it if the provider has
/// reached a terminal state. Downloads and saves the image on success. Records
/// that are already terminal are returned unchanged.
pub async fn refresh_generation(db: &Db, id: &str) -> Result<Generation, String> {
    let mut record = db.load_generation(id).ok_or("Generation not found")?;

    if record.status != "pending" {
        return Ok(record);
    }

    let provider = get_provider(&record.provider)
        .ok_or_else(|| format!("Unknown provider: {}", record.provider))?;

    let api_key = db
        .read_api_key(&record.provider)
        .ok_or_else(|| format!("No API key set for {}", record.provider))?;

    let poll_url = record
        .poll_url
        .clone()
        .ok_or("This generation has no poll URL to refresh")?;

    match provider.poll(&poll_url, &api_key).await? {
        PollOutcome::Pending => {}
        PollOutcome::Done { image_bytes, ext } => {
            save_generated_image(db, &mut record, &image_bytes, &ext)?;
        }
        PollOutcome::Failed { error } => {
            record.status = "failed".to_string();
            record.error = Some(error);
            let _ = db.upsert_generation(&record);
        }
    }

    Ok(record)
}

/// Write finished image bytes to the storage dir as `{id}.{ext}`, mark the
/// generation `succeeded`, and insert the matching image row. Shared by the
/// synchronous create path and the async poll path.
fn save_generated_image(
    db: &Db,
    record: &mut Generation,
    bytes: &[u8],
    ext: &str,
) -> Result<(), String> {
    let images_dir = db.storage_dir();
    let filename = format!("{}.{}", record.id, ext);
    let filepath = images_dir.join(&filename);

    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create images directory: {}", e))?;
    std::fs::write(&filepath, bytes).map_err(|e| format!("Failed to save image: {}", e))?;

    record.status = "succeeded".to_string();
    record.output_path = Some(filepath.to_string_lossy().to_string());
    record.error = None;
    let _ = db.upsert_generation(record);

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
    let _ = db.insert_image(&entry);

    Ok(())
}

/// The storage directory used the first time the app runs, before the user has
/// chosen one. Kept as the fallback so existing installs (and their seeded
/// files) keep working without any migration.
pub fn default_storage_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join("Pictures").join("catalog-gen"))
}

/// Return the currently configured storage directory as a string.
pub fn get_storage_dir(db: &Db) -> String {
    db.storage_dir().to_string_lossy().to_string()
}

/// Persist a new storage directory. Creates it if missing and canonicalizes so
/// later path-safety checks in `delete_image` line up. Returns the resolved
/// absolute path. Registering it with the asset protocol scope is the caller's
/// job (see `commands::set_storage_dir`), since that needs the `AppHandle`.
pub fn set_storage_dir(db: &Db, dir: &str) -> Result<String, String> {
    let path = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create storage directory: {}", e))?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Invalid storage directory: {}", e))?;
    db.set_storage_dir(&canonical)?;
    Ok(canonical.to_string_lossy().to_string())
}

/// Delete a saved image file and its associated generation record.
/// The path is canonicalized and required to sit directly inside the images
/// directory, so a path coming back from the frontend can't remove sidecar
/// records or escape the directory via `..`/symlinks.
pub fn delete_image(db: &Db, path: &str) -> Result<(), String> {
    let canonical_dir = db
        .storage_dir()
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

    let images_dir = db.storage_dir();
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

    std::fs::write(&filepath, &bytes).map_err(|e| format!("Failed to save image: {}", e))?;

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

fn default_provider() -> String {
    DEFAULT_PROVIDER.to_string()
}

/// A generation attempt, stored as a JSON sidecar so the user can re-run it or
/// poll its status. The source image is kept inline as a data URI (the same
/// value that was sent to the model), so re-generating needs no extra decoding
/// on either side.
///
/// `provider` records which backend produced it, so a later refresh polls the
/// right one; it defaults to `replicate` when absent (legacy sidecars/rows).
///
/// `status` is one of:
/// - `"pending"`  — created in async mode, awaiting a `refresh_generation` poll.
///   `poll_url` holds the provider's status URL; `output_path`/`error` are `None`.
/// - `"succeeded"` — `output_path` points at the saved image.
/// - `"failed"`   — `error` is set; can be retried from the source.
#[derive(Debug, Serialize, Deserialize)]
pub struct Generation {
    pub id: String,
    pub prompt: String,
    pub input_data_uri: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    pub status: String,
    #[serde(default)]
    pub poll_url: Option<String>,
    pub output_path: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
}

#[allow(clippy::too_many_arguments)]
fn new_generation(
    prompt: &str,
    input_data_uri: &str,
    provider: &str,
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
        provider: provider.to_string(),
        status: status.to_string(),
        poll_url,
        output_path,
        error,
        created_at,
    }
}
