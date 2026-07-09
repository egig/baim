use tauri::Manager;

use crate::db::Db;
use crate::generation;
use crate::generation::{Generation, ImageEntry};
use crate::provider::{self, ProviderInfo};

/// Enqueue a single generation (status `queued`) referencing its source image by
/// id. The queue drainer (`submit_queued`) submits it to the provider later.
#[tauri::command]
pub fn create_prediction(
    state: tauri::State<'_, Db>,
    prompt: String,
    provider: String,
    source_id: Option<String>,
) -> Result<Generation, String> {
    generation::create_prediction(&*state, &prompt, &provider, source_id.as_deref())
}

/// Enqueue one generation per prompt, sharing one source image and provider.
/// Powers batch (template / bulk) generation.
#[tauri::command]
pub fn create_predictions(
    state: tauri::State<'_, Db>,
    prompts: Vec<String>,
    provider: String,
    source_id: Option<String>,
) -> Result<Vec<Generation>, String> {
    generation::create_predictions(&*state, &prompts, &provider, source_id.as_deref())
}

/// Drain the queue: submit up to `limit` of the oldest `queued` jobs to their
/// provider, promoting them to `pending`. Called each poll tick with the number
/// of free in-flight slots so concurrency stays capped.
#[tauri::command]
pub async fn submit_queued(
    state: tauri::State<'_, Db>,
    limit: usize,
) -> Result<Vec<Generation>, String> {
    generation::submit_queued(&*state, limit).await
}

/// Drop every `queued` job ("Clear queue"). In-flight jobs finish.
#[tauri::command]
pub fn clear_queue(state: tauri::State<'_, Db>) -> Result<(), String> {
    generation::clear_queue(&*state)
}

/// Re-enqueue an existing generation (Retry) as a fresh `queued` job.
#[tauri::command]
pub fn requeue_generation(
    state: tauri::State<'_, Db>,
    id: String,
) -> Result<Generation, String> {
    generation::requeue_generation(&*state, &id)
}

#[tauri::command]
pub async fn refresh_generation(
    state: tauri::State<'_, Db>,
    id: String,
) -> Result<Generation, String> {
    generation::refresh_generation(&*state, &id).await
}

/// Whether the given provider has an API key saved (the value is never returned
/// to the frontend; only its presence).
#[tauri::command]
pub fn has_api_key(state: tauri::State<'_, Db>, provider: String) -> bool {
    state.read_api_key(&provider).is_some()
}

/// Persist (or, with an empty string, clear) a provider's API key.
#[tauri::command]
pub fn set_api_key(
    state: tauri::State<'_, Db>,
    provider: String,
    key: String,
) -> Result<(), String> {
    state.set_api_key(&provider, &key)
}

/// The image providers the app knows about, for the settings dropdown and
/// per-provider API-key inputs.
#[tauri::command]
pub fn list_providers() -> Vec<ProviderInfo> {
    provider::provider_infos()
}

/// The globally-selected provider id.
#[tauri::command]
pub fn get_active_provider(state: tauri::State<'_, Db>) -> String {
    state.read_active_provider()
}

/// Persist the globally-selected provider id.
#[tauri::command]
pub fn set_active_provider(state: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    state.set_active_provider(&id)
}

#[tauri::command]
pub fn get_images(state: tauri::State<'_, Db>) -> Result<Vec<ImageEntry>, String> {
    generation::list_saved_images(&*state)
}

#[tauri::command]
pub fn get_generations(state: tauri::State<'_, Db>) -> Result<Vec<Generation>, String> {
    generation::list_generations(&*state)
}

// `async` so the file + SQLite work runs on Tauri's async runtime rather than
// the main thread, where it would block the webview UI until it completes.
#[tauri::command]
pub async fn delete_image(state: tauri::State<'_, Db>, path: String) -> Result<(), String> {
    generation::delete_image(&*state, &path)
}

// `async` for the same reason: base64-decoding and writing the upload to disk
// must not block the main (UI) thread.
#[tauri::command]
pub async fn save_uploaded_image(
    state: tauri::State<'_, Db>,
    data_uri: String,
    title: Option<String>,
) -> Result<ImageEntry, String> {
    generation::save_uploaded_image(&*state, &data_uri, title.as_deref())
}

/// The configured cloud backend endpoint URL.
#[tauri::command]
pub fn get_cloud_endpoint(state: tauri::State<'_, Db>) -> Option<String> {
    state.read_setting("cloud_endpoint")
}

/// Persist the cloud backend endpoint URL and update the CloudProvider config.
#[tauri::command]
pub fn set_cloud_endpoint(
    state: tauri::State<'_, Db>,
    endpoint: String,
) -> Result<(), String> {
    let endpoint = endpoint.trim().to_string();
    if endpoint.is_empty() {
        return Ok(());
    }
    state.write_setting("cloud_endpoint", &endpoint)?;
    crate::providers::cloud::set_cloud_endpoint(endpoint);
    Ok(())
}

/// The remaining credit balance on the configured cloud API key.
#[tauri::command]
pub async fn get_cloud_credit_balance(state: tauri::State<'_, Db>) -> Result<i64, String> {
    let api_key = state
        .read_api_key("cloud")
        .ok_or_else(|| "No cloud API key configured".to_string())?;
    crate::providers::cloud::get_credit_balance(&api_key).await
}

#[tauri::command]
pub fn get_storage_dir(state: tauri::State<'_, Db>) -> String {
    generation::get_storage_dir(&*state)
}

#[tauri::command]
pub fn set_storage_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, Db>,
    path: String,
) -> Result<String, String> {
    let dir = generation::set_storage_dir(&*state, &path)?;
    // Let the asset protocol serve images from the new directory.
    app.asset_protocol_scope()
        .allow_directory(std::path::Path::new(&dir), true)
        .map_err(|e| format!("Failed to allow storage directory: {}", e))?;
    // Pick up any files already present in the chosen directory.
    state.seed_from_disk()?;
    Ok(dir)
}
