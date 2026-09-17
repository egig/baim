mod browse;
mod chat;
mod commands;
mod generation;
mod provider;
mod providers;
mod registry;
mod templates;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use registry::RegistryDb;
use tauri::Manager;

/// Top-level Tauri managed state. `registry` is the single always-open
/// connection to `baim.db` — settings, API keys, the image/generation
/// catalog, the chat thread, and recently-viewed files all live behind it. `Arc`
/// so it can be cheaply cloned into detached async tasks (see
/// `generation::spawn_interaction`) that must outlive the command call that
/// started them.
pub struct AppState {
    pub registry: Arc<RegistryDb>,
    /// App-wide directory holding copied preview images for saved prompt
    /// templates (`<app-data>/com.recraftory.baim/templates/`), registered
    /// with the asset protocol scope once at startup.
    pub templates_dir: PathBuf,
}

/// The registry database's stable app-data location (not inside any browsed
/// folder), so the app always boots regardless of where the user is
/// browsing. If an older install's `catalog.db` (the pre-registry single
/// global catalog) is found and `baim.db` doesn't exist yet, rename it in
/// place — it becomes the registry under its new name, keeping its `settings`
/// table (API keys, active provider) with zero user-visible migration.
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

            // Initiations-mode rows left `pending`/no-poll_url when the app
            // last closed never got to write their result — reset them to
            // `queued` so the normal drain loop silently re-fires them (see
            // `RegistryDb::reconcile_orphaned_interactions`). Used to run once
            // per workspace open; now once at startup, since there's one
            // catalog for the whole app.
            let _ = registry.reconcile_orphaned_interactions();

            // Initialize the OpenAI-compatible provider config from the registry.
            if let (Some(base_url), Some(model)) = (
                registry.read_setting("openai_compatible_base_url"),
                registry.read_setting("openai_compatible_model"),
            ) {
                providers::openai_compatible::set_config(base_url, model);
            }

            // Template preview images live outside any browsed folder, so
            // they need their own asset-protocol grant (dynamic per-folder
            // grants for browsed images happen in `browse::list_dir`).
            let templates_dir = templates::templates_dir(&app_dir);
            std::fs::create_dir_all(&templates_dir)
                .expect("Failed to create templates directory");
            app.asset_protocol_scope()
                .allow_directory(&templates_dir, true)
                .expect("Failed to allow templates directory");
            templates::seed_builtin_templates(&registry, &templates_dir)
                .expect("Failed to seed built-in templates");

            app.manage(AppState {
                registry: Arc::new(registry),
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
            commands::get_openai_compatible_config,
            commands::set_openai_compatible_config,
            commands::list_dir,
            commands::list_favorites,
            commands::list_locations,
            commands::list_recent_files,
            commands::record_file_visit,
            commands::open_path_externally,
            commands::reveal_in_file_manager,
            commands::send_chat_message,
            commands::list_chat_messages,
            commands::list_templates,
            commands::save_template,
            commands::create_template,
            commands::update_template,
            commands::delete_template,
            commands::rename_template,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
