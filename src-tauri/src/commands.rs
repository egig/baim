use crate::replicate;
use crate::replicate::ImageEntry;

#[tauri::command]
pub async fn generate_image(
    data_uri: String,
    prompt: String,
    api_key: String,
) -> Result<String, String> {
    replicate::generate_image(&data_uri, &prompt, &api_key).await
}

#[tauri::command]
pub fn get_images() -> Result<Vec<ImageEntry>, String> {
    replicate::list_saved_images()
}
