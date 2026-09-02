use std::path::{Path, PathBuf};

use crate::registry::{RegistryDb, TemplateRow};

/// `<app-data>/com.recraftory.baim/templates/` — sibling of `baim.db`, holding
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

/// Settings key marking that the built-in starter templates have already
/// been seeded, so a user who deletes one doesn't get it back on next launch.
const BUILTIN_TEMPLATES_SEEDED_KEY: &str = "builtin_templates_seeded";

const FULL_PRODUCT_PHOTO_PREVIEW: &[u8] = include_bytes!("../../public/img/tshirt-full.png");
const FLAT_LAY_PREVIEW: &[u8] = include_bytes!("../../public/img/tshirt-flatlay.png");

/// One-time seed of the two starter templates as regular `templates` rows,
/// so they render, rename, and delete exactly like user-saved ones — no
/// built-in/user distinction anywhere downstream. Their preview images ship
/// embedded in the binary and are copied into `templates_dir` on first seed,
/// since `preview_path` is served through the same asset-protocol path
/// (`convertFileSrc`) as saved templates' copied previews.
pub fn seed_builtin_templates(registry: &RegistryDb, templates_dir: &Path) -> Result<(), String> {
    if registry.read_setting(BUILTIN_TEMPLATES_SEEDED_KEY).is_some() {
        return Ok(());
    }

    std::fs::create_dir_all(templates_dir)
        .map_err(|e| format!("Failed to create templates directory: {}", e))?;

    seed_one(
        registry,
        templates_dir,
        "full-product-photo",
        "Full product photo",
        FULL_PRODUCT_PHOTO_PREVIEW,
        "A professional e-commerce fashion product photograph of an Indonesian adult model, wearing a plain unisex T-shirt. The image is cropped from the neck down to the feet, keeping the model faceless to emphasize the clothing. The T-shirt has a relaxed unisex fit with natural fabric drape, short sleeves, and a classic crew neck. The model stands in an elegant, confident pose with an upright posture and arms relaxed at the sides. Clean, minimalist light gray studio background, soft diffused lighting, high-detail fabric texture, realistic wrinkles and folds, commercial apparel catalog photography, centered composition, square aspect ratio, 1024 x 1024 resolution. ",
    )?;
    seed_one(
        registry,
        templates_dir,
        "flat-lay",
        "Flat-lay",
        FLAT_LAY_PREVIEW,
        "Professional e-commerce flat lay photography of a fashion outfit. The clothes are neatly arranged unfolded a clean, solid light gray background. Studio lighting, top-down knolling photography style, crisp details on fabric texture, no wrinkles, mid-end apparel catalog look, square image 1k resolution.",
    )?;

    registry.write_setting(BUILTIN_TEMPLATES_SEEDED_KEY, "1")?;
    Ok(())
}

fn seed_one(
    registry: &RegistryDb,
    templates_dir: &Path,
    id: &str,
    name: &str,
    preview_bytes: &[u8],
    prompt: &str,
) -> Result<(), String> {
    let dest = templates_dir.join(format!("{}.png", id));
    std::fs::write(&dest, preview_bytes)
        .map_err(|e| format!("Failed to write built-in template preview: {}", e))?;
    registry.insert_template(&TemplateRow {
        id: id.to_string(),
        name: name.to_string(),
        prompt: prompt.to_string(),
        preview_path: dest.to_string_lossy().to_string(),
        created_at: now(),
    })
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

/// Decode a `data:` URI (client-normalized PNG, same shape as
/// `save_uploaded_image` accepts) into raw bytes.
fn decode_data_uri(data_uri: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let encoded = data_uri
        .split(',')
        .nth(1)
        .ok_or_else(|| "Invalid data URI".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Failed to decode preview image: {}", e))
}

/// Write a preview image (decoded from a data URI) into `templates_dir` under a
/// fresh uuid filename, returning its path.
fn write_preview(templates_dir: &Path, data_uri: &str) -> Result<String, String> {
    std::fs::create_dir_all(templates_dir)
        .map_err(|e| format!("Failed to create templates directory: {}", e))?;
    let bytes = decode_data_uri(data_uri)?;
    let filename = format!("{}.png", uuid::Uuid::new_v4());
    let dest = templates_dir.join(&filename);
    std::fs::write(&dest, &bytes)
        .map_err(|e| format!("Failed to write template preview: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

fn validate(name: &str, prompt: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Template name cannot be empty".to_string());
    }
    if prompt.is_empty() {
        return Err("Template prompt cannot be empty".to_string());
    }
    Ok(())
}

/// Create a template from scratch (the Templat page's "Tambah templat" flow):
/// name + prompt, with an optional preview image supplied as a data URI. With
/// no preview, `preview_path` is stored empty and the card falls back to a
/// placeholder icon.
pub fn create_template(
    registry: &RegistryDb,
    templates_dir: &Path,
    name: &str,
    prompt: &str,
    preview_data_uri: Option<&str>,
) -> Result<TemplateRow, String> {
    let name = name.trim();
    let prompt = prompt.trim();
    validate(name, prompt)?;

    let preview_path = match preview_data_uri {
        Some(uri) => write_preview(templates_dir, uri)?,
        None => String::new(),
    };

    let row = TemplateRow {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        prompt: prompt.to_string(),
        preview_path,
        created_at: now(),
    };
    registry.insert_template(&row)?;
    Ok(row)
}

/// Edit an existing template's name, prompt, and — when `preview_data_uri` is
/// given — its preview image (the old preview file is removed best-effort).
pub fn update_template(
    registry: &RegistryDb,
    templates_dir: &Path,
    id: &str,
    name: &str,
    prompt: &str,
    preview_data_uri: Option<&str>,
) -> Result<(), String> {
    let name = name.trim();
    let prompt = prompt.trim();
    validate(name, prompt)?;

    registry.update_template(id, name, prompt)?;

    if let Some(uri) = preview_data_uri {
        let new_path = write_preview(templates_dir, uri)?;
        if let Some(old) = registry.set_template_preview(id, &new_path)? {
            if !old.is_empty() && old != new_path {
                let _ = std::fs::remove_file(old);
            }
        }
    }
    Ok(())
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
