use crate::generation;
use crate::generation::{Generation, ImageEntry, SubmitOutcome};
use crate::provider::{self, ProviderInfo};
use crate::registry::TemplateRow;
use crate::templates;
use crate::workspace::{self, active_workspace, AppState, WorkspaceInfo};

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
    let ws = active_workspace(&state)?;
    generation::create_prediction(
        &ws.db,
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
    let ws = active_workspace(&state)?;
    generation::create_predictions(
        &ws.db,
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
    let ws = active_workspace(&state)?;
    generation::submit_queued(&app, &state.registry, ws, limit).await
}

/// Drop every `queued` job ("Clear queue"). In-flight jobs finish.
#[tauri::command]
pub fn clear_queue(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let ws = active_workspace(&state)?;
    generation::clear_queue(&ws.db)
}

/// Re-enqueue an existing generation (Retry) as a fresh `queued` job.
#[tauri::command]
pub fn requeue_generation(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Generation, String> {
    let ws = active_workspace(&state)?;
    generation::requeue_generation(&ws.db, &id)
}

#[tauri::command]
pub async fn refresh_generation(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Generation, String> {
    let ws = active_workspace(&state)?;
    generation::refresh_generation(&state.registry, &ws.db, &id).await
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
    let ws = active_workspace(&state)?;
    generation::list_saved_images(&ws.db)
}

#[tauri::command]
pub fn get_generations(state: tauri::State<'_, AppState>) -> Result<Vec<Generation>, String> {
    let ws = active_workspace(&state)?;
    generation::list_generations(&ws.db)
}

// `async` so the file + SQLite work runs on Tauri's async runtime rather than
// the main thread, where it would block the webview UI until it completes.
#[tauri::command]
pub async fn delete_image(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let ws = active_workspace(&state)?;
    generation::delete_image(&ws.db, &path)
}

/// Delete multiple images at once (bulk-select "Delete"). Best-effort: partial
/// failures are reported but don't block deleting the rest.
#[tauri::command]
pub async fn delete_images(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let ws = active_workspace(&state)?;
    generation::delete_images(&ws.db, &paths)
}

// `async` for the same reason: base64-decoding and writing the upload to disk
// must not block the main (UI) thread.
#[tauri::command]
pub async fn save_uploaded_image(
    state: tauri::State<'_, AppState>,
    data_uri: String,
    title: Option<String>,
) -> Result<ImageEntry, String> {
    let ws = active_workspace(&state)?;
    generation::save_uploaded_image(&ws.db, &data_uri, title.as_deref())
}

/// The configured Recraftory backend endpoint URL.
#[tauri::command]
pub fn get_recraftory_endpoint(state: tauri::State<'_, AppState>) -> Option<String> {
    state.registry.read_setting("recraftory_endpoint")
}

/// Persist the Recraftory backend endpoint URL and update the RecraftoryProvider config.
#[tauri::command]
pub fn set_recraftory_endpoint(
    state: tauri::State<'_, AppState>,
    endpoint: String,
) -> Result<(), String> {
    let endpoint = endpoint.trim().to_string();
    if endpoint.is_empty() {
        return Ok(());
    }
    state
        .registry
        .write_setting("recraftory_endpoint", &endpoint)?;
    crate::providers::recraftory::set_recraftory_endpoint(endpoint);
    Ok(())
}

/// The remaining credit balance on the configured Recraftory API key.
#[tauri::command]
pub async fn get_recraftory_credit_balance(
    state: tauri::State<'_, AppState>,
) -> Result<i64, String> {
    let api_key = state
        .registry
        .read_api_key("recraftory")
        .ok_or_else(|| "No Recraftory API key configured".to_string())?;
    crate::providers::recraftory::get_credit_balance(&api_key).await
}

/// Known workspaces, most-recently-opened first.
#[tauri::command]
pub fn list_workspaces(state: tauri::State<'_, AppState>) -> Result<Vec<WorkspaceInfo>, String> {
    workspace::list_workspaces_info(&state)
}

/// The currently active workspace.
#[tauri::command]
pub fn get_active_workspace(state: tauri::State<'_, AppState>) -> Result<WorkspaceInfo, String> {
    workspace::get_active_workspace_info(&state)
}

/// Open (or switch to) a workspace folder, creating its catalog if this is the
/// first time it's been opened. `async` since it does blocking filesystem and
/// SQLite work (folder creation, DB init, disk seeding) that shouldn't block
/// the UI thread.
#[tauri::command]
pub async fn open_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<WorkspaceInfo, String> {
    workspace::open_workspace(&app, &state, &path)
}

/// Remove a workspace from the recents list. Does not touch any files, and
/// refuses nothing about the currently active workspace continuing to run.
#[tauri::command]
pub fn forget_workspace(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    state.registry.forget_workspace(&path)
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
