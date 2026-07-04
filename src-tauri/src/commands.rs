use crate::replicate;
use crate::replicate::{Generation, ImageEntry};

#[tauri::command]
pub async fn create_prediction(
    data_uri: String,
    prompt: String,
    api_key: String,
) -> Result<Generation, String> {
    replicate::create_prediction(&data_uri, &prompt, &api_key).await
}

#[tauri::command]
pub async fn refresh_generation(id: String, api_key: String) -> Result<Generation, String> {
    replicate::refresh_generation(&id, &api_key).await
}

#[tauri::command]
pub fn get_images() -> Result<Vec<ImageEntry>, String> {
    replicate::list_saved_images()
}

#[tauri::command]
pub fn get_generations() -> Result<Vec<Generation>, String> {
    replicate::list_generations()
}
