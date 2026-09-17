use crate::browse::{self, DirListing, FavoriteEntry};
use crate::chat;
use crate::generation;
use crate::generation::{Generation, ImageEntry, SubmitOutcome};
use crate::provider::{self, ProviderInfo};
use crate::registry::{ChatMessageRow, FolderRow, TemplateRow};
use crate::templates;
use crate::AppState;

/// Enqueue a single generation (status `queued`) referencing its source image by
/// id. The queue drainer (`submit_queued`) submits it to the provider later.
/// `mode` selects the call strategy (`"batch"`/`"interactions"`) used once
/// drained; omitted/unrecognized values default to `"batch"`.
#[tauri::command]
pub fn create_prediction(
    state: tauri::State<'_, AppState>,
    prompt: String,
    provider: String,
    source_id: Option<String>,
    mode: Option<String>,
) -> Result<Generation, String> {
    generation::create_prediction(
        &state.registry,
        &prompt,
        &provider,
        source_id.as_deref(),
        mode.as_deref().unwrap_or("batch"),
    )
}

/// Enqueue one generation per prompt, sharing one source image, provider and
/// mode. Powers batch (template / bulk) generation.
#[tauri::command]
pub fn create_predictions(
    state: tauri::State<'_, AppState>,
    prompts: Vec<String>,
    provider: String,
    source_id: Option<String>,
    mode: Option<String>,
) -> Result<Vec<Generation>, String> {
    generation::create_predictions(
        &state.registry,
        &prompts,
        &provider,
        source_id.as_deref(),
        mode.as_deref().unwrap_or("batch"),
    )
}

/// Drain the queue: submit up to `limit` of the oldest `queued` jobs to their
/// provider, promoting them to `pending`. Called each poll tick with the number
/// of free in-flight slots so concurrency stays capped. Takes the `AppHandle`
/// so interactions-mode submissions (see `generation::spawn_interaction`) can
/// emit a rate-limit event after this call has already returned.
#[tauri::command]
pub async fn submit_queued(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    limit: usize,
) -> Result<SubmitOutcome, String> {
    generation::submit_queued(&app, state.registry.clone(), limit).await
}

/// Drop every `queued` job ("Clear queue"). In-flight jobs finish.
#[tauri::command]
pub fn clear_queue(state: tauri::State<'_, AppState>) -> Result<(), String> {
    generation::clear_queue(&state.registry)
}

/// Re-enqueue an existing generation (Retry) as a fresh `queued` job.
#[tauri::command]
pub fn requeue_generation(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Generation, String> {
    generation::requeue_generation(&state.registry, &id)
}

#[tauri::command]
pub async fn refresh_generation(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Generation, String> {
    generation::refresh_generation(&app, &state.registry, &id).await
}

/// Whether the given provider has an API key saved (the value is never returned
/// to the frontend; only its presence).
#[tauri::command]
pub fn has_api_key(state: tauri::State<'_, AppState>, provider: String) -> bool {
    state.registry.read_api_key(&provider).is_some()
}

/// Persist (or, with an empty string, clear) a provider's API key.
#[tauri::command]
pub fn set_api_key(
    state: tauri::State<'_, AppState>,
    provider: String,
    key: String,
) -> Result<(), String> {
    state.registry.set_api_key(&provider, &key)
}

/// The image providers the app knows about, for the settings dropdown and
/// per-provider API-key inputs.
#[tauri::command]
pub fn list_providers() -> Vec<ProviderInfo> {
    provider::provider_infos()
}

/// The globally-selected provider id.
#[tauri::command]
pub fn get_active_provider(state: tauri::State<'_, AppState>) -> String {
    state.registry.read_active_provider()
}

/// Persist the globally-selected provider id.
#[tauri::command]
pub fn set_active_provider(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.registry.set_active_provider(&id)
}

/// The user-configured ceiling for adaptive generation concurrency (the
/// frontend's AIMD engine ramps `k` up toward this and never past it).
/// Defaults to 10 when unset.
#[tauri::command]
pub fn get_max_concurrency(state: tauri::State<'_, AppState>) -> u32 {
    state
        .registry
        .read_setting("max_concurrency")
        .and_then(|v| v.parse().ok())
        .unwrap_or(10)
        .clamp(1, 100)
}

/// Persist the concurrency ceiling, clamped to a sane range (defense in depth
/// alongside the frontend's own input clamp).
#[tauri::command]
pub fn set_max_concurrency(state: tauri::State<'_, AppState>, value: u32) -> Result<(), String> {
    let clamped = value.clamp(1, 100);
    state
        .registry
        .write_setting("max_concurrency", &clamped.to_string())
}

#[tauri::command]
pub fn get_images(state: tauri::State<'_, AppState>) -> Result<Vec<ImageEntry>, String> {
    generation::list_saved_images(&state.registry)
}

#[tauri::command]
pub fn get_generations(state: tauri::State<'_, AppState>) -> Result<Vec<Generation>, String> {
    generation::list_generations(&state.registry)
}

// `async` so the file + SQLite work runs on Tauri's async runtime rather than
// the main thread, where it would block the webview UI until it completes.
#[tauri::command]
pub async fn delete_image(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    generation::delete_image(&state.registry, &path)
}

/// Delete multiple images at once (bulk-select "Delete"). Best-effort: partial
/// failures are reported but don't block deleting the rest.
#[tauri::command]
pub async fn delete_images(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    generation::delete_images(&state.registry, &paths)
}

// `async` for the same reason: base64-decoding and writing the upload to disk
// must not block the main (UI) thread.
#[tauri::command]
pub async fn save_uploaded_image(
    state: tauri::State<'_, AppState>,
    data_uri: String,
    title: Option<String>,
) -> Result<ImageEntry, String> {
    generation::save_uploaded_image(&state.registry, &data_uri, title.as_deref())
}

/// The configured OpenAI-compatible endpoint's base URL and model id.
#[derive(serde::Serialize)]
pub struct OpenAiCompatibleConfig {
    pub base_url: Option<String>,
    pub model: Option<String>,
}

/// The saved Base URL / Model id for the OpenAI-compatible provider.
#[tauri::command]
pub fn get_openai_compatible_config(
    state: tauri::State<'_, AppState>,
) -> OpenAiCompatibleConfig {
    OpenAiCompatibleConfig {
        base_url: state.registry.read_setting("openai_compatible_base_url"),
        model: state.registry.read_setting("openai_compatible_model"),
    }
}

/// Persist the OpenAI-compatible provider's Base URL and Model id and update
/// its in-memory config.
#[tauri::command]
pub fn set_openai_compatible_config(
    state: tauri::State<'_, AppState>,
    base_url: String,
    model: String,
) -> Result<(), String> {
    let base_url = base_url.trim().to_string();
    let model = model.trim().to_string();
    if base_url.is_empty() || model.is_empty() {
        return Ok(());
    }
    state
        .registry
        .write_setting("openai_compatible_base_url", &base_url)?;
    state.registry.write_setting("openai_compatible_model", &model)?;
    crate::providers::openai_compatible::set_config(base_url, model);
    Ok(())
}

/// Live-list one folder's contents (folders + every file, not just images).
/// `path: None` resolves to the last-visited folder, falling back to home.
#[tauri::command]
pub fn list_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: Option<String>,
) -> Result<DirListing, String> {
    browse::list_dir(&app, &state.registry, path)
}

/// The fixed sidebar favorites (Home, Desktop, Pictures, Downloads).
#[tauri::command]
pub fn list_favorites() -> Vec<FavoriteEntry> {
    browse::list_favorites()
}

/// Recently-visited folders, most-recent first.
#[tauri::command]
pub fn list_recent_folders(state: tauri::State<'_, AppState>) -> Result<Vec<FolderRow>, String> {
    state.registry.list_recent_folders()
}

/// Remove a folder from the recents list. Does not touch any files.
#[tauri::command]
pub fn remove_recent_folder(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    state.registry.remove_recent_folder(&path)
}

/// Open a file in its OS-default application.
#[tauri::command]
pub fn open_path_externally(path: String) -> Result<(), String> {
    browse::open_path_externally(&path)
}

/// Reveal a file in the system file manager (Finder/Explorer).
#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    browse::reveal_in_file_manager(&path)
}

/// Send one turn to the persistent AI chat thread and get back the new
/// user+assistant rows. See `chat::send_message`.
#[tauri::command]
pub async fn send_chat_message(
    state: tauri::State<'_, AppState>,
    text: String,
    attachments: Vec<String>,
) -> Result<Vec<ChatMessageRow>, String> {
    chat::send_message(&state.registry, text, attachments).await
}

/// The whole persistent chat thread, oldest first.
#[tauri::command]
pub fn list_chat_messages(state: tauri::State<'_, AppState>) -> Result<Vec<ChatMessageRow>, String> {
    chat::list_messages(&state.registry)
}

/// User-saved prompt templates, most-recently-created first.
#[tauri::command]
pub fn list_templates(state: tauri::State<'_, AppState>) -> Result<Vec<TemplateRow>, String> {
    state.registry.list_templates()
}

/// Save a prompt as a reusable template, copying `source_image_path`'s image
/// into app-wide storage as its preview. `async` since it does blocking file
/// I/O (`fs::copy`) that shouldn't block the UI thread.
#[tauri::command]
pub async fn save_template(
    state: tauri::State<'_, AppState>,
    name: String,
    prompt: String,
    source_image_path: String,
) -> Result<TemplateRow, String> {
    templates::save_template(
        &state.registry,
        &state.templates_dir,
        &name,
        &prompt,
        &source_image_path,
    )
}

/// Create a template from scratch (Templat page "Tambah templat"): a name +
/// prompt with an optional preview image supplied as a data URI. `async` for
/// the same blocking-I/O reason as `save_template`.
#[tauri::command]
pub async fn create_template(
    state: tauri::State<'_, AppState>,
    name: String,
    prompt: String,
    preview_data_uri: Option<String>,
) -> Result<TemplateRow, String> {
    templates::create_template(
        &state.registry,
        &state.templates_dir,
        &name,
        &prompt,
        preview_data_uri.as_deref(),
    )
}

/// Edit an existing template's name, prompt, and — when a data URI is given —
/// its preview image.
#[tauri::command]
pub async fn update_template(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
    prompt: String,
    preview_data_uri: Option<String>,
) -> Result<(), String> {
    templates::update_template(
        &state.registry,
        &state.templates_dir,
        &id,
        &name,
        &prompt,
        preview_data_uri.as_deref(),
    )
}

/// Delete a saved template and its preview file. `async` for the same reason
/// as `save_template`.
#[tauri::command]
pub async fn delete_template(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    templates::delete_template(&state.registry, &id)
}

/// Rename an existing saved template.
#[tauri::command]
pub fn rename_template(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    state.registry.rename_template(&id, &name)
}
