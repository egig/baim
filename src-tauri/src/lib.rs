mod commands;
mod db;
mod generation;
mod provider;
mod providers;
mod registry;
mod templates;
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use registry::RegistryDb;
use tauri::Manager;
use workspace::AppState;

/// The registry database's stable app-data location (not inside any workspace
/// folder), so the app always boots even before the user has opened a
/// workspace. If an older install's `catalog.db` (the pre-workspace single
/// global catalog) is found and `baim.db` doesn't exist yet, rename it in
/// place — it becomes the registry under its new name, keeping its `settings`
/// table (API keys, active provider) with zero user-visible migration. Its
/// old `images`/`generations` rows are left in the file, unused.
fn registry_db_path(dir: &Path) -> PathBuf {
    let old = dir.join("catalog.db");
    let new = dir.join("baim.db");
    if new.exists() {
        return new;
    }
    if old.exists() {
        // If the rename fails (permissions, cross-device, etc.) fall back to
        // opening the original file in place rather than risking a fresh,
        // empty baim.db that silently orphans existing settings/API keys.
        return match std::fs::rename(&old, &new) {
            Ok(()) => new,
            Err(_) => old,
        };
    }
    new
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

            let app_dir = dirs::data_dir()
                .expect("Could not find data directory")
                .join("com.recraftory.baim");
            std::fs::create_dir_all(&app_dir).expect("Failed to create app data directory");
            let registry_path = registry_db_path(&app_dir);
            let registry =
                RegistryDb::open(&registry_path).expect("Failed to initialize registry database");

            // Initialize Recraftory provider config from the registry.
            if let Some(endpoint) = registry.read_setting("recraftory_endpoint") {
                providers::recraftory::set_recraftory_endpoint(endpoint);
            }

            let handle = workspace::boot_workspace(app, &registry)
                .expect("Failed to open a workspace");

            // Template preview images live outside any workspace folder, so
            // they need their own asset-protocol grant (see the per-workspace
            // grant in workspace.rs::build_workspace_handle for the same idea).
            let templates_dir = templates::templates_dir(&app_dir);
            std::fs::create_dir_all(&templates_dir)
                .expect("Failed to create templates directory");
            app.asset_protocol_scope()
                .allow_directory(&templates_dir, true)
                .expect("Failed to allow templates directory");
            templates::seed_builtin_templates(&registry, &templates_dir)
                .expect("Failed to seed built-in templates");

            app.manage(AppState {
                registry,
                workspace: Mutex::new(Arc::new(handle)),
                templates_dir,
            });

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
            commands::get_max_concurrency,
            commands::set_max_concurrency,
            commands::has_api_key,
            commands::set_api_key,
            commands::get_images,
            commands::get_generations,
            commands::delete_image,
            commands::delete_images,
            commands::save_uploaded_image,
            commands::get_recraftory_endpoint,
            commands::set_recraftory_endpoint,
            commands::get_recraftory_credit_balance,
            commands::list_workspaces,
            commands::get_active_workspace,
            commands::open_workspace,
            commands::forget_workspace,
            commands::list_templates,
            commands::save_template,
            commands::delete_template,
            commands::rename_template,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
