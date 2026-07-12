use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Manager;

use crate::db::WorkspaceDb;
use crate::generation::default_storage_dir;
use crate::registry::RegistryDb;

/// The currently-open workspace: its catalog connection, canonical folder
/// path, and when it was opened.
pub struct WorkspaceHandle {
    pub db: WorkspaceDb,
    pub path: PathBuf,
    pub opened_at: i64,
}

/// Top-level Tauri managed state. `registry` is a single always-open
/// connection to `sabi.db`. `workspace` is the active workspace, swapped
/// wholesale (never mutated in place) on every `open_workspace` call — an
/// `Arc` so async commands can clone it out from under the lock and hold it
/// live across `.await` points without keeping the mutex held.
pub struct AppState {
    pub registry: RegistryDb,
    pub workspace: Mutex<Arc<WorkspaceHandle>>,
    /// App-wide directory holding copied preview images for saved prompt
    /// templates (`<app-data>/com.recraftory.sabi/templates/`), registered
    /// with the asset protocol scope once at startup.
    pub templates_dir: PathBuf,
}

#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub path: String,
    pub name: String,
    pub last_opened_at: i64,
}

/// Clone out the currently-active workspace handle. Locks only long enough to
/// clone the `Arc`, so the guard never has to be held across an `.await`.
pub fn active_workspace(state: &AppState) -> Result<Arc<WorkspaceHandle>, String> {
    state
        .workspace
        .lock()
        .map_err(|e| e.to_string())
        .map(|guard| guard.clone())
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// A workspace's display name is always derived live from its folder's
/// basename — never stored, so it can't drift out of sync with a rename on
/// disk.
fn workspace_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn workspace_info(path: &Path, opened_at: i64) -> WorkspaceInfo {
    WorkspaceInfo {
        path: path.to_string_lossy().to_string(),
        name: workspace_name(path),
        last_opened_at: opened_at,
    }
}

/// Build a fully-initialized workspace (catalog DB + registered asset scope)
/// for an already-canonicalized folder, without touching the registry or any
/// shared state. A failure here never disturbs whatever workspace is
/// currently active.
fn build_workspace_handle<M: Manager<tauri::Wry>>(
    app: &M,
    canonical: &Path,
) -> Result<WorkspaceHandle, String> {
    let sabi_dir = canonical.join(".sabi");
    std::fs::create_dir_all(&sabi_dir)
        .map_err(|e| format!("Failed to create .sabi directory: {}", e))?;
    let db = WorkspaceDb::open(&sabi_dir.join("catalog.db"), canonical.to_path_buf())?;
    db.seed_from_disk()?;
    app.asset_protocol_scope()
        .allow_directory(canonical, true)
        .map_err(|e| format!("Failed to allow workspace directory: {}", e))?;
    Ok(WorkspaceHandle {
        db,
        path: canonical.to_path_buf(),
        opened_at: now(),
    })
}

/// Open (or switch to) a workspace folder. Builds the entire new workspace
/// first; only commits to the registry and swaps the live state once it's
/// known to be fully valid, so a failure at any point leaves the previously
/// active workspace untouched.
pub fn open_workspace(
    app: &tauri::AppHandle,
    state: &AppState,
    path: &str,
) -> Result<WorkspaceInfo, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("Folder not found: {}", e))?;
    if !canonical.is_dir() {
        return Err("Not a folder".to_string());
    }

    let handle = build_workspace_handle(app, &canonical)?;
    let path_str = canonical.to_string_lossy().to_string();

    state
        .registry
        .upsert_workspace_opened(&path_str, handle.opened_at)?;
    state.registry.set_active_workspace_path(&path_str)?;

    let info = workspace_info(&canonical, handle.opened_at);
    *state.workspace.lock().map_err(|e| e.to_string())? = Arc::new(handle);
    Ok(info)
}

/// Startup workspace resolution: try the last-active path, then fall back
/// through the recents list (most-recent-first), skipping anything that no
/// longer exists or fails to open — without deleting it from the registry, so
/// a transient boot failure never silently drops a recent entry. If nothing
/// resolves (first-ever launch, or every known workspace is now missing),
/// auto-create the default.
pub fn boot_workspace(app: &tauri::App, registry: &RegistryDb) -> Result<WorkspaceHandle, String> {
    let rows = registry.list_workspaces()?;

    let mut candidates: Vec<PathBuf> = registry
        .read_active_workspace_path()
        .map(PathBuf::from)
        .into_iter()
        .collect();
    candidates.extend(rows.iter().map(|r| PathBuf::from(&r.path)));

    for candidate in candidates {
        let canonical = match std::fs::canonicalize(&candidate) {
            Ok(c) if c.is_dir() => c,
            _ => continue,
        };
        if let Ok(handle) = build_workspace_handle(app, &canonical) {
            let path_str = canonical.to_string_lossy().to_string();
            let _ = registry.upsert_workspace_opened(&path_str, handle.opened_at);
            let _ = registry.set_active_workspace_path(&path_str);
            return Ok(handle);
        }
    }

    let default_dir = default_storage_dir()?;
    std::fs::create_dir_all(&default_dir)
        .map_err(|e| format!("Failed to create default workspace directory: {}", e))?;
    let canonical = std::fs::canonicalize(&default_dir)
        .map_err(|e| format!("Failed to resolve default workspace directory: {}", e))?;
    let handle = build_workspace_handle(app, &canonical)?;
    let path_str = canonical.to_string_lossy().to_string();
    registry.upsert_workspace_opened(&path_str, handle.opened_at)?;
    registry.set_active_workspace_path(&path_str)?;
    Ok(handle)
}

pub fn get_active_workspace_info(state: &AppState) -> Result<WorkspaceInfo, String> {
    let ws = active_workspace(state)?;
    Ok(workspace_info(&ws.path, ws.opened_at))
}

pub fn list_workspaces_info(state: &AppState) -> Result<Vec<WorkspaceInfo>, String> {
    let rows = state.registry.list_workspaces()?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let path = PathBuf::from(&r.path);
            WorkspaceInfo {
                name: workspace_name(&path),
                path: r.path,
                last_opened_at: r.last_opened_at,
            }
        })
        .collect())
}
