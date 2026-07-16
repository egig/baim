use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::db::WorkspaceDb;
use crate::provider::{
    get_provider, ApiMode, CreateOutcome, GenerateRequest, PollOutcome, DEFAULT_PROVIDER,
    RATE_LIMITED_ERROR,
};
use crate::registry::RegistryDb;
use crate::workspace::WorkspaceHandle;

/// Tauri event emitted when a detached Interactions-mode task (see
/// `spawn_interaction`) hits a rate limit. Its own `submit_queued` tick has
/// already returned by the time this happens, so it can't ride along in that
/// call's `SubmitOutcome.rate_limited` like the synchronous Batch path does —
/// the frontend listens for this event instead to trigger the same AIMD
/// backoff (see `src/lib/queries.ts::applyRateLimitSignal`).
pub const RATE_LIMITED_EVENT: &str = "generation-rate-limited";

/// Normalizes an incoming mode string to one of the two recognized values,
/// defaulting anything else (including absent/legacy callers) to `"batch"`.
fn normalize_api_mode(mode: &str) -> &'static str {
    if mode == "interactions" {
        "interactions"
    } else {
        "batch"
    }
}

/// Enqueue a single generation. Inserts a `queued` row referencing its source
/// image by `source_id` (no inline image data — the bytes are read from disk at
/// submit time). The queue drainer (`submit_queued`) later submits it to the
/// provider. Returns the persisted record.
pub fn create_prediction(
    db: &WorkspaceDb,
    prompt: &str,
    provider_id: &str,
    source_id: Option<&str>,
    mode: &str,
) -> Result<Generation, String> {
    let mode = normalize_api_mode(mode);
    let record = new_generation(
        prompt,
        "",
        provider_id,
        mode,
        "queued",
        None,
        None,
        None,
        source_id,
    );
    db.upsert_generation(&record)?;
    Ok(record)
}

/// Enqueue one generation per prompt against the same source image and provider.
/// Each becomes its own `queued` row, drained later by `submit_queued`. Returns
/// every record in prompt order.
pub fn create_predictions(
    db: &WorkspaceDb,
    prompts: &[String],
    provider_id: &str,
    source_id: Option<&str>,
    mode: &str,
) -> Result<Vec<Generation>, String> {
    if prompts.is_empty() {
        return Err("No prompts provided".to_string());
    }
    let mut out = Vec::with_capacity(prompts.len());
    for prompt in prompts {
        out.push(create_prediction(db, prompt, provider_id, source_id, mode)?);
    }
    Ok(out)
}

/// Re-enqueue an existing generation (typically a `failed` one) as a fresh
/// `queued` row cloning its source, prompt, provider and mode. Powers per-row
/// Retry.
pub fn requeue_generation(db: &WorkspaceDb, id: &str) -> Result<Generation, String> {
    let existing = db.load_generation(id).ok_or("Generation not found")?;
    create_prediction(
        db,
        &existing.prompt,
        &existing.provider,
        existing.source_id.as_deref(),
        &existing.api_mode,
    )
}

/// Drop every `queued` generation (the "Clear queue" action). Already-submitted
/// (`pending`) jobs are left to finish.
pub fn clear_queue(db: &WorkspaceDb) -> Result<(), String> {
    db.clear_queued()
}

/// Drain the queue: pack `queued` rows into provider-homogeneous batches (see
/// `pack_into_batches`) and promote up to `limit` of them to `pending` by
/// submitting each as one request to its provider — a batch of any size
/// counts as 1 toward `limit`, since it's genuinely one HTTP call (a Gemini
/// batch request covering every prompt in it, see `do_submit_group`) rather
/// than one per row. Called each poll tick by the frontend with
/// `limit = k - in_flight` (`k` is the frontend's adaptive concurrency
/// target), so in-flight *requests* never exceed it regardless of how many
/// rows they cover. Groups are submitted concurrently via `join_all` rather
/// than back to back — `db`/`registry` are only touched synchronously between
/// `.await` points, never held across one, so interleaving them here is safe.
/// Failures (bad key, missing source, provider error) mark every row in that
/// group `failed` without aborting the rest; a rate-limited submission
/// instead reverts every row in that group to `queued` (see `submit_one`/
/// `submit_group`) and is reflected in the returned `rate_limited` flag
/// rather than as a failure.
/// The result of a `submit_queued` drain pass: the advanced records, plus
/// whether any submission in the batch was rate-limited by its provider.
/// Drives the frontend's adaptive concurrency (AIMD) backoff.
#[derive(Debug, Serialize)]
pub struct SubmitOutcome {
    pub generations: Vec<Generation>,
    pub rate_limited: bool,
}

pub async fn submit_queued(
    app: &tauri::AppHandle,
    registry: &RegistryDb,
    ws: Arc<WorkspaceHandle>,
    limit: usize,
) -> Result<SubmitOutcome, String> {
    if limit == 0 {
        return Ok(SubmitOutcome {
            generations: Vec::new(),
            rate_limited: false,
        });
    }
    let batches = pack_into_batches(&ws.db, ws.db.list_queued_all()?)
        .into_iter()
        .take(limit);

    let results = futures_util::future::join_all(batches.map(|group| {
        let ws = ws.clone();
        let app = app.clone();
        async move {
            if group.len() == 1 {
                let mut record = group.into_iter().next().unwrap();
                let rate_limited = submit_one(&app, registry, &ws, &mut record).await;
                (vec![record], rate_limited)
            } else {
                submit_group(registry, &ws.db, group).await
            }
        }
    }))
    .await;

    let rate_limited = results.iter().any(|(_, rl)| *rl);
    let generations = results.into_iter().flat_map(|(recs, _)| recs).collect();
    Ok(SubmitOutcome {
        generations,
        rate_limited,
    })
}

/// Conservative budget under Gemini's ~20MB inline-batch-request cap, leaving
/// headroom both for JSON structure/prompt text and for `estimate_payload_bytes`
/// being an approximation rather than an exact encode.
const BATCH_PAYLOAD_BUDGET_BYTES: u64 = 18 * 1024 * 1024;

/// Rough base64-encoded size of a row's source image (its on-disk
/// `size_bytes` × 4/3 for base64 inflation) — used only to decide how many
/// rows can share one batch call, so it doesn't need to be exact. A row whose
/// image can't be found estimates as 0 rather than blocking packing; it'll
/// surface a clear error at actual submission time instead.
fn estimate_payload_bytes(db: &WorkspaceDb, record: &Generation) -> u64 {
    record
        .source_id
        .as_deref()
        .and_then(|id| db.find_image_by_id(id))
        .map(|image| image.size_bytes * 4 / 3)
        .unwrap_or(0)
}

/// Packs queued rows into provider-homogeneous batches, greedily filling each
/// toward `BATCH_PAYLOAD_BUDGET_BYTES` (first-fit; queue depth is small and
/// user-driven, so optimal bin-packing isn't worth the complexity). Provider
/// is the only hard boundary a batch can't cross — one request means one
/// endpoint/auth key. Source image is *not* a boundary: each row's image
/// travels inline with its own item (see `do_submit_group`), so rows for
/// different images can freely share one call — which is what lets a batch
/// actually fill toward the payload budget instead of stopping at however
/// many rows one image happens to have queued.
///
/// Interactions-mode rows never join any group (always a singleton of their
/// own) and nothing ever joins them — `CreateOutcome` has no way to
/// represent N independent per-row results from one call the way a Batch
/// job's `poll_url` + per-item `metadata.key` can, so `create_batch` must
/// never see one. This is what routes every interactions-mode row through
/// `submit_one`/`do_submit` (and from there into `spawn_interaction`)
/// instead of `submit_group`.
fn pack_into_batches(db: &WorkspaceDb, records: Vec<Generation>) -> Vec<Vec<Generation>> {
    struct Batch {
        provider: String,
        records: Vec<Generation>,
        bytes: u64,
    }
    let mut batches: Vec<Batch> = Vec::new();
    for record in records {
        if record.api_mode == "interactions" {
            batches.push(Batch {
                provider: record.provider.clone(),
                bytes: 0,
                records: vec![record],
            });
            continue;
        }
        let size = estimate_payload_bytes(db, &record);
        let fit = batches.iter_mut().find(|b| {
            b.provider == record.provider
                && b.records.first().is_some_and(|r| r.api_mode != "interactions")
                && b.bytes + size <= BATCH_PAYLOAD_BUDGET_BYTES
        });
        match fit {
            Some(batch) => {
                batch.bytes += size;
                batch.records.push(record);
            }
            None => batches.push(Batch {
                provider: record.provider.clone(),
                bytes: size,
                records: vec![record],
            }),
        }
    }
    batches.into_iter().map(|b| b.records).collect()
}

/// Submit one queued row, always persisting the outcome. A rate-limited
/// (`RATE_LIMITED_ERROR`) response reverts the row to `queued` — it's retried
/// on a later drain rather than dying as a visible failure — and returns
/// `true`. Any other error is stored as `failed` (with the message) rather
/// than propagating, so one bad job can't abort a drain pass.
///
/// For an interactions-mode row, `do_submit` returns after only checkpointing
/// the row and spawning its detached task — the real outcome (including any
/// rate limit) arrives later out of band via `RATE_LIMITED_EVENT`, so this
/// always returns `false` for that mode; see `spawn_interaction`.
async fn submit_one(
    app: &tauri::AppHandle,
    registry: &RegistryDb,
    ws: &Arc<WorkspaceHandle>,
    record: &mut Generation,
) -> bool {
    if let Err(err) = do_submit(app, registry, ws, record).await {
        if err == RATE_LIMITED_ERROR {
            record.status = "queued".to_string();
            record.poll_url = None;
            let _ = ws.db.upsert_generation(record);
            return true;
        }
        record.status = "failed".to_string();
        record.error = Some(err);
        record.poll_url = None;
        let _ = ws.db.upsert_generation(record);
    }
    false
}

/// Submit a group of ≥2 queued rows sharing one provider + source image as a
/// single batch request (`ImageProvider::create_batch`), reading the source
/// image once rather than once per row. On success every row gets the same
/// `poll_url`. On a rate limit every row reverts to `queued`, same contract
/// as `submit_one`'s single-row case (one `rate_limited` signal for the whole
/// group). Any other error marks every row `failed` with that message, since
/// the batch genuinely never got submitted — there's no partial outcome to
/// preserve at this stage (that only happens once results come back via
/// `poll`).
async fn submit_group(
    registry: &RegistryDb,
    db: &WorkspaceDb,
    mut records: Vec<Generation>,
) -> (Vec<Generation>, bool) {
    match do_submit_group(registry, db, &records).await {
        Ok(CreateOutcome::Pending { poll_url }) => {
            for record in &mut records {
                record.status = "pending".to_string();
                record.poll_url = Some(poll_url.clone());
                record.error = None;
                let _ = db.upsert_generation(record);
            }
            (records, false)
        }
        Ok(CreateOutcome::Done { image_bytes, ext }) => {
            // No batching-capable provider is synchronous today, but handle
            // it: every row in the group shares the same result.
            for record in &mut records {
                let _ = save_generated_image(db, record, &image_bytes, &ext);
            }
            (records, false)
        }
        Err(err) if err == RATE_LIMITED_ERROR => {
            for record in &mut records {
                record.status = "queued".to_string();
                record.poll_url = None;
                let _ = db.upsert_generation(record);
            }
            (records, true)
        }
        Err(err) => {
            for record in &mut records {
                record.status = "failed".to_string();
                record.error = Some(err.clone());
                record.poll_url = None;
                let _ = db.upsert_generation(record);
            }
            (records, false)
        }
    }
}

/// A provider's resolved auth for one submission: its API key, plus (for
/// meta-providers like recraftory) the downstream provider's key forwarded
/// alongside it. Shared by every row in a group — auth is a per-provider
/// concern, not a per-image one.
struct ProviderAuth {
    api_key: String,
    provider_api_key: Option<String>,
}

fn resolve_provider_auth(registry: &RegistryDb, provider_id: &str) -> Result<ProviderAuth, String> {
    let api_key = registry
        .read_api_key(provider_id)
        .ok_or_else(|| format!("No API key set for {}", provider_id))?;

    // Meta-providers (recraftory) need the downstream provider's API key too.
    let provider_api_key = if provider_id == "recraftory" {
        registry.read_api_key("google")
    } else {
        None
    };

    Ok(ProviderAuth {
        api_key,
        provider_api_key,
    })
}

/// Reads a saved source image and encodes it as a `data:` URI, by id.
fn resolve_image_data_uri(db: &WorkspaceDb, source_id: &str) -> Result<String, String> {
    let image = db
        .find_image_by_id(source_id)
        .ok_or("Source image no longer exists")?;
    read_image_as_data_uri(&image.path)
}

async fn do_submit(
    app: &tauri::AppHandle,
    registry: &RegistryDb,
    ws: &Arc<WorkspaceHandle>,
    record: &mut Generation,
) -> Result<(), String> {
    let provider = get_provider(&record.provider)
        .ok_or_else(|| format!("Unknown provider: {}", record.provider))?;
    let auth = resolve_provider_auth(registry, &record.provider)?;
    let source_id = record
        .source_id
        .as_deref()
        .ok_or("Queued generation has no source image")?;
    let data_uri = resolve_image_data_uri(&ws.db, source_id)?;

    if record.api_mode == "interactions" {
        // Checkpoint *before* spawning: `pending` + no poll_url is what
        // `reconcile_orphaned_interactions` recognizes on the next workspace
        // open as "was in flight when the app closed" (Batch-mode `pending`
        // rows always carry a poll_url, so this pairing is unambiguous).
        record.status = "pending".to_string();
        record.poll_url = None;
        record.error = None;
        ws.db.upsert_generation(record)?;
        spawn_interaction(
            app.clone(),
            ws.clone(),
            provider,
            record.clone(),
            data_uri,
            auth,
        );
        return Ok(());
    }

    let outcome = provider
        .create(GenerateRequest {
            prompt: record.prompt.clone(),
            image_data_uri: data_uri,
            api_key: auth.api_key,
            provider_api_key: auth.provider_api_key,
            mode: ApiMode::Batch,
        })
        .await?;

    match outcome {
        CreateOutcome::Pending { poll_url } => {
            record.status = "pending".to_string();
            record.poll_url = Some(poll_url);
            record.error = None;
            ws.db.upsert_generation(record)?;
            Ok(())
        }
        CreateOutcome::Done { image_bytes, ext } => {
            // Synchronous provider: save immediately (sets status `succeeded`).
            save_generated_image(&ws.db, record, &image_bytes, &ext)
        }
    }
}

/// Fires one Interactions-API call as a detached task so the queue drain
/// (`submit_queued`/the Tauri command it backs) never blocks on a single
/// synchronous 10-30s generation — parallelism comes from many of these
/// running concurrently, up to the same AIMD `k` the Batch path already
/// respects (each spawn counts as one `submit_queued` slot, same as a Batch
/// group). The task writes its own result to the DB when it completes,
/// independent of whatever already returned to the caller.
///
/// If the whole app closes/crashes while this is in flight, the row stays
/// checkpointed `pending`/no-poll_url and is silently reset to `queued` by
/// `reconcile_orphaned_interactions` on the next workspace open — an
/// accepted, self-healing cost (one wasted call), not a correctness issue.
fn spawn_interaction(
    app: tauri::AppHandle,
    ws: Arc<WorkspaceHandle>,
    provider: Box<dyn crate::provider::ImageProvider>,
    mut record: Generation,
    data_uri: String,
    auth: ProviderAuth,
) {
    tauri::async_runtime::spawn(async move {
        let result = provider
            .create(GenerateRequest {
                prompt: record.prompt.clone(),
                image_data_uri: data_uri,
                api_key: auth.api_key,
                provider_api_key: auth.provider_api_key,
                mode: ApiMode::Interactions,
            })
            .await;

        match result {
            Ok(CreateOutcome::Done { image_bytes, ext }) => {
                let _ = save_generated_image(&ws.db, &mut record, &image_bytes, &ext);
            }
            Ok(CreateOutcome::Pending { poll_url }) => {
                // Defensive only — v1's synchronous Interactions call should
                // never legitimately return Pending (background/streaming
                // modes are out of scope). Handle it rather than dropping it.
                record.status = "pending".to_string();
                record.poll_url = Some(poll_url);
                let _ = ws.db.upsert_generation(&record);
            }
            Err(err) if err == RATE_LIMITED_ERROR => {
                record.status = "queued".to_string();
                record.poll_url = None;
                let _ = ws.db.upsert_generation(&record);
                // Can't ride along in submit_queued's already-returned
                // SubmitOutcome (that call returned long ago) — signal the
                // frontend's AIMD backoff out of band instead.
                let _ = app.emit(RATE_LIMITED_EVENT, ());
            }
            Err(err) => {
                record.status = "failed".to_string();
                record.error = Some(err);
                record.poll_url = None;
                let _ = ws.db.upsert_generation(&record);
            }
        }
    });
}

/// Batch-submit variant of `do_submit`: resolves auth once for the whole
/// group, then builds one `(id, GenerateRequest)` item per row. A group can
/// now span multiple source images (see `pack_into_batches`), so each row's
/// image is resolved individually — cached by `source_id` so rows that do
/// share an image (the common "N templates × one image" case) still only pay
/// for one read.
async fn do_submit_group(
    registry: &RegistryDb,
    db: &WorkspaceDb,
    records: &[Generation],
) -> Result<CreateOutcome, String> {
    let first = records.first().ok_or("Empty submission group")?;
    let provider = get_provider(&first.provider)
        .ok_or_else(|| format!("Unknown provider: {}", first.provider))?;
    let auth = resolve_provider_auth(registry, &first.provider)?;

    let mut image_cache: HashMap<String, String> = HashMap::new();
    let mut items = Vec::with_capacity(records.len());
    for record in records {
        let source_id = record
            .source_id
            .as_deref()
            .ok_or("Queued generation has no source image")?;
        let data_uri = match image_cache.get(source_id) {
            Some(cached) => cached.clone(),
            None => {
                let uri = resolve_image_data_uri(db, source_id)?;
                image_cache.insert(source_id.to_string(), uri.clone());
                uri
            }
        };
        items.push((
            record.id.clone(),
            GenerateRequest {
                prompt: record.prompt.clone(),
                image_data_uri: data_uri,
                api_key: auth.api_key.clone(),
                provider_api_key: auth.provider_api_key.clone(),
                // Groups are always Batch-mode — `pack_into_batches` never
                // lets an interactions-mode row join a multi-row group.
                mode: ApiMode::Batch,
            },
        ));
    }

    provider.create_batch(items).await
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
pub async fn refresh_generation(
    registry: &RegistryDb,
    db: &WorkspaceDb,
    id: &str,
) -> Result<Generation, String> {
    let mut record = db.load_generation(id).ok_or("Generation not found")?;

    if record.status != "pending" {
        return Ok(record);
    }

    if record.poll_url.is_none() {
        // Interactions-mode row still in flight in its spawned task (see
        // `spawn_interaction`), which writes the eventual result itself.
        // Nothing to poll — cheap no-op re-load; the frontend's 2s poll tick
        // picks up the status change once it lands.
        return Ok(record);
    }

    let provider = get_provider(&record.provider)
        .ok_or_else(|| format!("Unknown provider: {}", record.provider))?;

    let api_key = registry
        .read_api_key(&record.provider)
        .ok_or_else(|| format!("No API key set for {}", record.provider))?;

    let poll_url = record
        .poll_url
        .clone()
        .ok_or("This generation has no poll URL to refresh")?;

    match provider.poll(&poll_url, &api_key, &record.id).await? {
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
    db: &WorkspaceDb,
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

/// Delete a saved image file and its associated generation record.
/// The path is canonicalized and required to sit directly inside the images
/// directory, so a path coming back from the frontend can't remove sidecar
/// records or escape the directory via `..`/symlinks.
pub fn delete_image(db: &WorkspaceDb, path: &str) -> Result<(), String> {
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

/// Delete multiple images (bulk selection). Best-effort: a failure on one path
/// doesn't stop the rest from being deleted. Returns `Err` naming every path
/// that failed (with its reason) if at least one did; `Ok` only if all
/// succeeded.
pub fn delete_images(db: &WorkspaceDb, paths: &[String]) -> Result<(), String> {
    let failures: Vec<String> = paths
        .iter()
        .filter_map(|path| delete_image(db, path).err().map(|e| format!("{path}: {e}")))
        .collect();

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

pub fn list_saved_images(db: &WorkspaceDb) -> Result<Vec<ImageEntry>, String> {
    db.list_images()
}

pub fn list_generations(db: &WorkspaceDb) -> Result<Vec<Generation>, String> {
    db.list_generations()
}

/// Accept a client-side normalized PNG data URI, decode it, save the file, and
/// insert a row into the images table. Returns the new ImageEntry so the
/// frontend can select it immediately. `title` is the original picked file name,
/// kept for search/display since the on-disk name is a collision-free uuid.
pub fn save_uploaded_image(
    db: &WorkspaceDb,
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
    /// source.
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Which call strategy produced (or will produce) this row — `"batch"` or
    /// `"interactions"`, orthogonal to `provider`. Defaults to `"batch"` for
    /// legacy rows created before this field existed.
    #[serde(default = "default_api_mode")]
    pub api_mode: String,
    pub created_at: i64,
}

fn default_api_mode() -> String {
    "batch".to_string()
}

#[allow(clippy::too_many_arguments)]
fn new_generation(
    prompt: &str,
    input_data_uri: &str,
    provider: &str,
    api_mode: &str,
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
        api_mode: api_mode.to_string(),
        created_at,
    }
}
