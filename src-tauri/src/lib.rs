mod commands;
mod db;
mod replicate;

use std::path::PathBuf;

use db::Db;
use tauri::Manager;

fn db_path() -> PathBuf {
    let home = dirs::home_dir().expect("Could not find home directory");
    home.join("Pictures")
        .join("catalog-gen")
        .join("catalog.db")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let db = Db::open(&db_path())
                .expect("Failed to initialize database");
            // idempotent seed from existing files on disk
            db.seed_from_disk()
                .expect("Failed to seed database");
            app.manage(db);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_prediction,
            commands::refresh_generation,
            commands::get_images,
            commands::get_generations,
            commands::delete_image,
            commands::save_uploaded_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
