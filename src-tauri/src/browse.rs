use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::registry::RegistryDb;

/// One entry in a live directory listing — a folder or a file, not resolved
/// against any catalog. `is_image` drives the browser's thumbnail vs.
/// generic-icon rendering; everything else about a non-image file (kind,
/// preview) is left to the OS via `open_path_externally`.
#[derive(Serialize)]
pub struct DirEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub is_image: bool,
    pub size_bytes: u64,
    pub modified_at: i64,
}

#[derive(Serialize)]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
}

/// A pinned starter location in the sidebar (Home, Desktop, Pictures,
/// Downloads) — a fixed set for now, not user-customizable. Entries whose
/// directory doesn't exist on this machine (e.g. no Desktop on some Linux
/// setups) are simply omitted.
#[derive(Serialize)]
pub struct FavoriteEntry {
    pub label: String,
    pub path: String,
}

fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
    )
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The fixed favorites list, existing directories only.
pub fn list_favorites() -> Vec<FavoriteEntry> {
    let candidates: [(&str, Option<PathBuf>); 4] = [
        ("Home", dirs::home_dir()),
        ("Desktop", dirs::desktop_dir()),
        ("Pictures", dirs::picture_dir()),
        ("Downloads", dirs::download_dir()),
    ];
    candidates
        .into_iter()
        .filter_map(|(label, dir)| {
            dir.filter(|d| d.is_dir()).map(|d| FavoriteEntry {
                label: label.to_string(),
                path: d.to_string_lossy().to_string(),
            })
        })
        .collect()
}

/// Live-list one folder's immediate children (no recursion — the frontend
/// drives navigation one level at a time). `path: None` resolves to the
/// last-visited folder (persisted across launches), falling back to the home
/// directory if that folder no longer exists or this is the first run.
///
/// Also allowlists the folder for the Tauri asset protocol (so
/// `convertFileSrc` thumbnails/previews work for files in it) and records the
/// visit — the dynamic, per-navigation equivalent of what opening a
/// "workspace" used to do once, up front.
pub fn list_dir(
    app: &tauri::AppHandle,
    registry: &RegistryDb,
    path: Option<String>,
) -> Result<DirListing, String> {
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => registry
            .read_last_visited_path()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .or_else(dirs::home_dir)
            .ok_or("Could not resolve a starting folder")?,
    };

    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Folder not found: {}", e))?;
    if !canonical.is_dir() {
        return Err("Not a folder".to_string());
    }

    app.asset_protocol_scope()
        .allow_directory(&canonical, true)
        .map_err(|e| format!("Failed to allow folder for previews: {}", e))?;

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&canonical).map_err(|e| format!("Failed to read folder: {}", e))?;
    for item in read_dir.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        // Hidden files/dirs (dotfiles, .baim, .DS_Store, …) stay out of view,
        // matching Finder's default.
        if name.starts_with('.') {
            continue;
        }
        let metadata = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let entry_path = item.path();
        let is_dir = metadata.is_dir();
        let ext = entry_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        entries.push(DirEntry {
            path: entry_path.to_string_lossy().to_string(),
            name,
            is_dir,
            is_image: !is_dir && is_image_ext(ext),
            size_bytes: metadata.len(),
            modified_at,
        });
    }
    // Folders first, then alphabetical (case-insensitive) — a plain, familiar
    // Finder-list ordering rather than anything catalog/recency-driven.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let path_str = canonical.to_string_lossy().to_string();
    let parent = canonical
        .parent()
        .map(|p| p.to_string_lossy().to_string());

    let _ = registry.record_folder_visit(&path_str, now());
    let _ = registry.write_last_visited_path(&path_str);

    Ok(DirListing {
        path: path_str,
        parent,
        entries,
    })
}

/// Open a file in its OS-default application, or reveal it in the system
/// file manager (Finder/Explorer). Shells out directly to the platform's
/// native opener rather than pulling in a plugin — `spawn` (not
/// `status`/`output`) so we don't wait on or interpret the child's exit code,
/// which e.g. Windows' `explorer.exe` returns unreliably even on success.
fn run_opener(path: &Path, reveal: bool) -> Result<(), String> {
    let spawn_result = if cfg!(target_os = "macos") {
        let mut cmd = std::process::Command::new("open");
        if reveal {
            cmd.arg("-R");
        }
        cmd.arg(path).spawn()
    } else if cfg!(target_os = "windows") {
        if reveal {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", path.display()))
                .spawn()
        } else {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &path.to_string_lossy()])
                .spawn()
        }
    } else {
        // Linux/other: no universally-reliable "reveal a specific file"
        // command across file managers — open its containing folder instead.
        let target = if reveal {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        std::process::Command::new("xdg-open").arg(target).spawn()
    };
    spawn_result
        .map(|_| ())
        .map_err(|e| format!("Failed to open: {}", e))
}

pub fn open_path_externally(path: &str) -> Result<(), String> {
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("File not found: {}", e))?;
    run_opener(&canonical, false)
}

pub fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("File not found: {}", e))?;
    run_opener(&canonical, true)
}
