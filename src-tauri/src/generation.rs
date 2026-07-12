use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::provider::{
    get_provider, CreateOutcome, GenerateRequest, PollOutcome, DEFAULT_PROVIDER,
};

/// Enqueue a single generation. Inserts a `queued` row referencing its source
/// image by `source_id` (no inline image data — the bytes are read from disk at
/// submit time). The queue drainer (`submit_queued`) later submits it to the
/// provider. Returns the persisted record.
pub fn create_prediction(
    db: &Db,
    prompt: &str,
    provider_id: &str,
    source_id: Option<&str>,
) -> Result<Generation, String> {
    let record = new_generation(prompt, "", provider_id, "queued", None, None, None, source_id);
    db.upsert_generation(&record)?;
    Ok(record)
}

/// Enqueue one generation per prompt against the same source image and provider.
/// Each becomes its own `queued` row, drained later by `submit_queued`. Returns
/// every record in prompt order.
pub fn create_predictions(
    db: &Db,
    prompts: &[String],
    provider_id: &str,
    source_id: Option<&str>,
) -> Result<Vec<Generation>, String> {
    if prompts.is_empty() {
        return Err("No prompts provided".to_string());
    }
    let mut out = Vec::with_capacity(prompts.len());
    for prompt in prompts {
        out.push(create_prediction(db, prompt, provider_id, source_id)?);
    }
    Ok(out)
}

/// Re-enqueue an existing generation (typically a `failed` one) as a fresh
/// `queued` row cloning its source, prompt and provider. Powers per-row Retry.
pub fn requeue_generation(db: &Db, id: &str) -> Result<Generation, String> {
    let existing = db.load_generation(id).ok_or("Generation not found")?;
    create_prediction(
        db,
        &existing.prompt,
        &existing.provider,
        existing.source_id.as_deref(),
    )
}

/// Drop every `queued` generation (the "Clear queue" action). Already-submitted
/// (`pending`) jobs are left to finish.
pub fn clear_queue(db: &Db) -> Result<(), String> {
    db.clear_queued()
}

/// Drain the queue: promote up to `limit` of the oldest `queued` rows to
/// `pending` by submitting them to their provider. Called each poll tick by the
/// frontend with `limit = K - in_flight`, so in-flight jobs never exceed K.
/// Failures (bad key, missing source, provider error) mark that row `failed`
/// without aborting the rest. Returns the advanced records.
pub async fn submit_queued(db: &Db, limit: usize) -> Result<Vec<Generation>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let queued = db.list_queued(limit)?;
    let mut out = Vec::with_capacity(queued.len());
    for mut record in queued {
        submit_one(db, &mut record).await;
        out.push(record);
    }
    Ok(out)
}

/// Submit one queued row, always persisting the outcome. On any error the row is
/// stored as `failed` (with the message) rather than propagating, so one bad job
/// can't abort a drain pass.
async fn submit_one(db: &Db, record: &mut Generation) {
    if let Err(err) = do_submit(db, record).await {
        record.status = "failed".to_string();
        record.error = Some(err);
        record.poll_url = None;
        let _ = db.upsert_generation(record);
    }
}

async fn do_submit(db: &Db, record: &mut Generation) -> Result<(), String> {
    let provider = get_provider(&record.provider)
        .ok_or_else(|| format!("Unknown provider: {}", record.provider))?;

    let api_key = db
        .read_api_key(&record.provider)
        .ok_or_else(|| format!("No API key set for {}", record.provider))?;

    // Meta-providers (recraftory) need the downstream provider's API key too.
    let provider_api_key = if record.provider == "recraftory" {
        db.read_api_key("google")
    } else {
        None
    };

    let source_id = record
        .source_id
        .as_deref()
        .ok_or("Queued generation has no source image")?;
    let image = db
        .find_image_by_id(source_id)
        .ok_or("Source image no longer exists")?;
    let data_uri = read_image_as_data_uri(&image.path)?;

    let outcome = provider
        .create(GenerateRequest {
            prompt: record.prompt.clone(),
            image_data_uri: data_uri,
            api_key,
            provider_api_key,
        })
        .await?;

    match outcome {
        CreateOutcome::Pending { poll_url } => {
            record.status = "pending".to_string();
            record.poll_url = Some(poll_url);
            record.error = None;
            db.upsert_generation(record)?;
            Ok(())
        }
        CreateOutcome::Done { image_bytes, ext } => {
            // Synchronous provider: save immediately (sets status `succeeded`).
            save_generated_image(db, record, &image_bytes, &ext)
        }
    }
}

/// Read a saved image file and encode it as a `data:` URI for the provider,
/// picking the mime type from the file extension. Used at submit time to resolve
/// a queued row's `source_id` back into the bytes the provider needs.
fn read_image_as_data_uri(path: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read source image: {}", e))?;
    let mime = match std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
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
        PollOutcome::Pending { logs } => {
            // Still running: persist the latest logs so the detail panel updates
            // live. Only write when they actually changed to avoid a needless
            // upsert on every 2s poll tick.
            if logs.is_some() && logs != record.logs {
                record.logs = logs;
                let _ = db.upsert_generation(&record);
            }
        }
        PollOutcome::Done {
            image_bytes,
            ext,
            logs,
        } => {
            if logs.is_some() {
                record.logs = logs;
            }
            save_generated_image(db, &mut record, &image_bytes, &ext)?;
        }
        PollOutcome::Failed { error, logs } => {
            record.status = "failed".to_string();
            record.error = Some(error);
            if logs.is_some() {
                record.logs = logs;
            }
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
        id: uuid::Uuid::new_v4().to_string(),
        title: Some(filename.clone()),
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
    Ok(home.join("Pictures").join("sabi-images"))
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
/// frontend can select it immediately. `title` is the original picked file name,
/// kept for search/display since the on-disk name is a collision-free uuid.
pub fn save_uploaded_image(
    db: &Db,
    data_uri: &str,
    title: Option<&str>,
) -> Result<ImageEntry, String> {
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

    let title = title
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .unwrap_or_else(|| filename.clone());

    let entry = ImageEntry {
        path: filepath.to_string_lossy().to_string(),
        id: uuid::Uuid::new_v4().to_string(),
        title: Some(title),
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
    /// Stable uuid identifying this image independently of its file path. Used as
    /// the target of a generation's `source_id` so children can be listed per
    /// source. Backfilled for pre-existing rows (see `Db::backfill_image_ids`).
    #[serde(default)]
    pub id: String,
    pub filename: String,
    /// Human-readable name for search/display, distinct from the on-disk
    /// `filename` (a collision-free uuid). For uploads it's the original picked
    /// file name; for seeded/generated files it falls back to `filename`. `None`
    /// on pre-title rows — the UI falls back to `filename`.
    #[serde(default)]
    pub title: Option<String>,
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
/// right one; it defaults to `google` when absent (legacy sidecars/rows).
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
    /// The `id` of the image this was generated from, when known. Lets the UI
    /// list a source image's direct children. `None` for legacy rows created
    /// before source tracking existed.
    #[serde(default)]
    pub source_id: Option<String>,
    /// The provider's latest log blob for this generation, refreshed on every
    /// poll (Google's Batch API has none, so it stays `None`; a future provider
    /// may stream real logs). Surfaced in the generation detail panel. `None`
    /// for legacy rows and queued jobs that haven't been submitted yet.
    #[serde(default)]
    pub logs: Option<String>,
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
    source_id: Option<&str>,
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
        source_id: source_id.map(|s| s.to_string()),
        logs: None,
        created_at,
    }
}
