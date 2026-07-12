mod commands;
mod db;
mod generation;
mod provider;
mod providers;

use std::path::PathBuf;

use db::Db;
use tauri::Manager;

/// The database lives in a stable app-data location (not inside the image
/// storage directory), so the app always boots even before the user has chosen
/// a storage folder, and the folder can be relocated freely.
fn db_path() -> PathBuf {
    let data = dirs::data_dir().expect("Could not find data directory");
    data.join("com.recraftory.sabi")
        .join("catalog.db")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let path = db_path();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .expect("Failed to create app data directory");
            }
            let db = Db::open(&path).expect("Failed to initialize database");
            // idempotent seed from existing files on disk
            db.seed_from_disk().expect("Failed to seed database");

            // Allow the configured storage directory through the asset protocol
            // so saved images can be served to the frontend.
            let storage_dir = db.storage_dir();
            let _ = std::fs::create_dir_all(&storage_dir);
            app.asset_protocol_scope()
                .allow_directory(&storage_dir, true)
                .expect("Failed to allow storage directory");

            // Initialize Recraftory provider config from DB settings.
            if let Some(endpoint) = db.read_setting("recraftory_endpoint") {
                providers::recraftory::set_recraftory_endpoint(endpoint);
            }

            app.manage(db);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_prediction,
            commands::create_predictions,
            commands::submit_queued,
            commands::clear_queue,
            commands::requeue_generation,
            commands::refresh_generation,
            commands::list_providers,
            commands::get_active_provider,
            commands::set_active_provider,
            commands::has_api_key,
            commands::set_api_key,
            commands::get_images,
            commands::get_generations,
            commands::delete_image,
            commands::save_uploaded_image,
            commands::get_recraftory_endpoint,
            commands::set_recraftory_endpoint,
            commands::get_recraftory_credit_balance,
            commands::get_storage_dir,
            commands::set_storage_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
