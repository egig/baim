use tauri::Manager;

use crate::db::Db;
use crate::replicate;
use crate::replicate::{Generation, ImageEntry};

#[tauri::command]
pub async fn create_prediction(
    state: tauri::State<'_, Db>,
    data_uri: String,
    prompt: String,
    api_key: String,
) -> Result<Generation, String> {
    replicate::create_prediction(&*state, &data_uri, &prompt, &api_key).await
}

#[tauri::command]
pub async fn refresh_generation(
    state: tauri::State<'_, Db>,
    id: String,
    api_key: String,
) -> Result<Generation, String> {
    replicate::refresh_generation(&*state, &id, &api_key).await
}

#[tauri::command]
pub fn get_images(state: tauri::State<'_, Db>) -> Result<Vec<ImageEntry>, String> {
    replicate::list_saved_images(&*state)
}

#[tauri::command]
pub fn get_generations(state: tauri::State<'_, Db>) -> Result<Vec<Generation>, String> {
    replicate::list_generations(&*state)
}

#[tauri::command]
pub fn delete_image(state: tauri::State<'_, Db>, path: String) -> Result<(), String> {
    replicate::delete_image(&*state, &path)
}

#[tauri::command]
pub fn save_uploaded_image(
    state: tauri::State<'_, Db>,
    data_uri: String,
) -> Result<ImageEntry, String> {
    replicate::save_uploaded_image(&*state, &data_uri)
}

#[tauri::command]
pub fn get_storage_dir(state: tauri::State<'_, Db>) -> String {
    replicate::get_storage_dir(&*state)
}

#[tauri::command]
pub fn set_storage_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, Db>,
    path: String,
) -> Result<String, String> {
    let dir = replicate::set_storage_dir(&*state, &path)?;
    // Let the asset protocol serve images from the new directory.
    app.asset_protocol_scope()
        .allow_directory(std::path::Path::new(&dir), true)
        .map_err(|e| format!("Failed to allow storage directory: {}", e))?;
    // Pick up any files already present in the chosen directory.
    state.seed_from_disk()?;
    Ok(dir)
}
