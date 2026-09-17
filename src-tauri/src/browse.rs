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

/// An externally-attached or secondary mounted volume, distinct from the
/// root/boot disk — backs the sidebar's "Locations" section.
#[derive(Serialize)]
pub struct LocationEntry {
    pub label: String,
    pub path: String,
}

/// Real, on-disk filesystem types worth showing as a "Location" — deliberately
/// an allowlist rather than a denylist of virtual ones (tmpfs, proc, sysfs,
/// overlay, squashfs, devtmpfs, cgroup, …), since a fixed set of real
/// filesystems is far shorter to enumerate correctly than every pseudo-fs a
/// Linux distro might mount. Also excludes network filesystems (smbfs, nfs,
/// afpfs) — "Locations" is local-volumes-only for now.
fn is_real_disk_fs(fs_type: &str) -> bool {
    matches!(
        fs_type.to_ascii_lowercase().as_str(),
        "apfs"
            | "hfs"
            | "hfsplus"
            | "hfs+"
            | "ntfs"
            | "ntfs3"
            | "refs"
            | "exfat"
            | "vfat"
            | "fat"
            | "fat32"
            | "msdos"
            | "ext2"
            | "ext3"
            | "ext4"
            | "btrfs"
            | "xfs"
            | "f2fs"
            | "zfs"
    )
}

/// Whether `mount_point` is the root/boot volume, which "Locations" excludes
/// (it's already reachable via the Home favorite). macOS/Linux mount the
/// boot volume at `/`; Windows has no single root, so the boot drive is
/// resolved from the `SystemDrive` environment variable (e.g. `C:`) instead.
fn is_root_mount(mount_point: &Path) -> bool {
    if cfg!(target_os = "windows") {
        match std::env::var("SystemDrive") {
            Ok(sysdrive) => mount_point
                .to_string_lossy()
                .trim_end_matches(['\\', '/'])
                .eq_ignore_ascii_case(sysdrive.trim_end_matches(['\\', '/'])),
            Err(_) => false,
        }
    } else {
        mount_point == Path::new("/")
    }
}

/// Whether `mount_point` is a hidden member of the boot disk's own APFS
/// volume group (Data/VM/Preboot/Update/Recovery), not a separate volume a
/// user would recognize. macOS mounts these under `/System/Volumes/*`, while
/// every real external/secondary volume mounts under `/Volumes/*` — Finder's
/// Locations section never shows the former either.
fn is_hidden_system_volume(mount_point: &Path) -> bool {
    cfg!(target_os = "macos") && mount_point.starts_with("/System")
}

/// Every mounted volume except the root/boot disk, restricted to real disk
/// filesystems — external/secondary drives, disk images, USB media. Backs
/// the sidebar's "Locations" section. Re-enumerated fresh on every call
/// (no caching) since this reflects live OS mount state.
pub fn list_locations() -> Vec<LocationEntry> {
    sysinfo::Disks::new_with_refreshed_list()
        .list()
        .iter()
        .filter(|disk| !is_root_mount(disk.mount_point()))
        .filter(|disk| !is_hidden_system_volume(disk.mount_point()))
        .filter(|disk| is_real_disk_fs(&disk.file_system().to_string_lossy()))
        .map(|disk| {
            let path = disk.mount_point().to_string_lossy().to_string();
            let name = disk.name().to_string_lossy().to_string();
            let label = if name.trim().is_empty() { path.clone() } else { name };
            LocationEntry { label, path }
        })
        .collect()
}

fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
    )
}

pub fn now() -> i64 {
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
/// `convertFileSrc` thumbnails/previews work for files in it) and remembers
/// it as the folder to reopen on next launch.
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

    let _ = registry.write_last_visited_path(&path_str);

    Ok(DirListing {
        path: path_str,
        parent,
        entries,
    })
}

/// Files recently clicked/opened in the browser, most-recently-viewed first —
/// backs the sidebar's "Recent" virtual folder. Reads candidate paths from
/// the DB, then stats each one and silently drops any that no longer exist
/// (moved/deleted since being viewed) rather than erroring the whole list.
pub fn list_recent_files(registry: &RegistryDb) -> Result<Vec<DirEntry>, String> {
    let paths = registry.list_recent_file_paths(60)?;
    let mut entries = Vec::new();
    for path in paths {
        let p = Path::new(&path);
        let metadata = match p.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        let is_image = is_image_ext(ext);
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        entries.push(DirEntry {
            path,
            name,
            is_dir: false,
            is_image,
            size_bytes: metadata.len(),
            modified_at,
        });
    }
    Ok(entries)
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
