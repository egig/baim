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
