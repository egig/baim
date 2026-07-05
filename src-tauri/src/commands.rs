use tauri::Manager;

use crate::db::Db;
use crate::generation;
use crate::generation::{Generation, ImageEntry};
use crate::provider::{self, ProviderInfo};

#[tauri::command]
pub async fn create_prediction(
    state: tauri::State<'_, Db>,
    data_uri: String,
    prompt: String,
    provider: String,
) -> Result<Generation, String> {
    generation::create_prediction(&*state, &data_uri, &prompt, &provider).await
}

/// Create one generation per prompt in a single call, sharing one source image
/// and provider. Powers batch generation from selected templates.
#[tauri::command]
pub async fn create_predictions(
    state: tauri::State<'_, Db>,
    data_uri: String,
    prompts: Vec<String>,
    provider: String,
) -> Result<Vec<Generation>, String> {
    generation::create_predictions(&*state, &data_uri, &prompts, &provider).await
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

#[tauri::command]
pub fn delete_image(state: tauri::State<'_, Db>, path: String) -> Result<(), String> {
    generation::delete_image(&*state, &path)
}

#[tauri::command]
pub fn save_uploaded_image(
    state: tauri::State<'_, Db>,
    data_uri: String,
) -> Result<ImageEntry, String> {
    generation::save_uploaded_image(&*state, &data_uri)
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
