use std::path::{Path, PathBuf};

use crate::registry::{RegistryDb, TemplateRow};

/// `<app-data>/com.recraftory.sabi/templates/` — sibling of `sabi.db`, holding
/// copied preview images for saved prompt templates. Created on demand.
pub fn templates_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("templates")
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Copy `source_image_path`'s bytes into `templates_dir` under a fresh uuid
/// filename (preserving its extension), insert a `templates` row, and return
/// it. A plain byte copy — unlike `save_uploaded_image`/`save_generated_image`
/// (which write from in-memory bytes), this copies an existing file as-is, so
/// no decode/re-encode is needed and the original format is preserved.
pub fn save_template(
    registry: &RegistryDb,
    templates_dir: &Path,
    name: &str,
    prompt: &str,
    source_image_path: &str,
) -> Result<TemplateRow, String> {
    let name = name.trim();
    let prompt = prompt.trim();
    if name.is_empty() {
        return Err("Template name cannot be empty".to_string());
    }
    if prompt.is_empty() {
        return Err("Template prompt cannot be empty".to_string());
    }

    std::fs::create_dir_all(templates_dir)
        .map_err(|e| format!("Failed to create templates directory: {}", e))?;

    let ext = Path::new(source_image_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let dest = templates_dir.join(&filename);

    std::fs::copy(source_image_path, &dest)
        .map_err(|e| format!("Failed to copy template preview image: {}", e))?;

    let row = TemplateRow {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        prompt: prompt.to_string(),
        preview_path: dest.to_string_lossy().to_string(),
        created_at: now(),
    };
    registry.insert_template(&row)?;
    Ok(row)
}

/// Delete a template row and its preview file. File removal is best-effort: a
/// missing/already-gone file doesn't fail the row deletion, matching this
/// codebase's existing tolerance for `delete_image`'s sidecar cleanup.
pub fn delete_template(registry: &RegistryDb, id: &str) -> Result<(), String> {
    if let Some(preview_path) = registry.delete_template(id)? {
        let _ = std::fs::remove_file(preview_path);
    }
    Ok(())
}
