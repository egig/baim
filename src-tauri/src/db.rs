use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::generation::{Generation, ImageEntry};

/// A single workspace's catalog: the `images` and `generations` for one
/// user-chosen folder. Lives at `<root>/.baim/catalog.db`. Global settings
/// (API keys, active provider, the workspace registry itself) are NOT here —
/// see `RegistryDb`.
pub struct WorkspaceDb {
    conn: Mutex<Connection>,
    /// The workspace's own folder — where its image files live. Fixed at
    /// construction; a different folder is a different `WorkspaceDb`.
    root: PathBuf,
}

impl WorkspaceDb {
    pub fn open(catalog_path: &Path, root: PathBuf) -> Result<Self, String> {
        let conn = Connection::open(catalog_path)
            .map_err(|e| format!("Failed to open DB: {}", e))?;
        Self::init_tables(&conn)?;
        Ok(WorkspaceDb {
            conn: Mutex::new(conn),
            root,
        })
    }

    fn init_tables(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS images (
                path TEXT PRIMARY KEY,
                id TEXT NOT NULL,
                filename TEXT NOT NULL,
                title TEXT,
                created_at INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS generations (
                id TEXT PRIMARY KEY,
                prompt TEXT NOT NULL,
                input_data_uri TEXT NOT NULL,
                provider TEXT NOT NULL DEFAULT 'google',
                status TEXT NOT NULL DEFAULT 'pending',
                poll_url TEXT,
                output_path TEXT,
                error TEXT,
                source_id TEXT,
                logs TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_generations_source ON generations(source_id);
            ",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        // One-time migration: `api_mode` distinguishes Batch vs Interactions
        // API rows, orthogonal to `provider` (which vendor). Added after the
        // table already existed for early installs, so it's not in the
        // CREATE TABLE above — ALTER TABLE errors if the column is already
        // there, so guard with PRAGMA table_info rather than re-running
        // unconditionally.
        let mut stmt = conn
            .prepare("PRAGMA table_info(generations)")
            .map_err(|e| format!("Failed to inspect generations table: {}", e))?;
        let has_api_mode = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("Failed to inspect generations table: {}", e))?
            .filter_map(|r| r.ok())
            .any(|name| name == "api_mode");
        drop(stmt);
        if !has_api_mode {
            conn.execute(
                "ALTER TABLE generations ADD COLUMN api_mode TEXT NOT NULL DEFAULT 'batch'",
                [],
            )
            .map_err(|e| format!("Failed to add api_mode column: {}", e))?;
        }

        Ok(())
    }

    /// The folder this workspace's image files live in.
    pub fn storage_dir(&self) -> PathBuf {
        self.root.clone()
    }

    pub fn insert_image(&self, entry: &ImageEntry) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO images (path, id, filename, title, created_at, size_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![entry.path, entry.id, entry.filename, entry.title, entry.created_at, entry.size_bytes],
        )
        .map_err(|e| format!("Failed to insert image: {}", e))?;
        Ok(())
    }

    /// Look up an image row by its stable `id`. Used when submitting a queued
    /// generation, to resolve its `source_id` back to the file on disk.
    pub fn find_image_by_id(&self, id: &str) -> Option<ImageEntry> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT path, id, filename, title, created_at, size_bytes FROM images WHERE id = ?1",
            params![id],
            |row| {
                Ok(ImageEntry {
                    path: row.get(0)?,
                    id: row.get(1)?,
                    filename: row.get(2)?,
                    title: row.get(3)?,
                    created_at: row.get(4)?,
                    size_bytes: row.get::<_, i64>(5)? as u64,
                })
            },
        )
        .ok()
    }

    pub fn delete_image_by_path(&self, path: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM images WHERE path = ?1", params![path])
            .map_err(|e| format!("Failed to delete image: {}", e))?;
        Ok(())
    }

    pub fn list_images(&self) -> Result<Vec<ImageEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT path, id, filename, title, created_at, size_bytes FROM images ORDER BY created_at DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let entries = stmt
            .query_map([], |row| {
                Ok(ImageEntry {
                    path: row.get(0)?,
                    id: row.get(1)?,
                    filename: row.get(2)?,
                    title: row.get(3)?,
                    created_at: row.get(4)?,
                    size_bytes: row.get::<_, i64>(5)? as u64,
                })
            })
            .map_err(|e| format!("Failed to query images: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(entries)
    }

    pub fn upsert_generation(&self, gen: &Generation) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO generations (id, prompt, input_data_uri, provider, status, poll_url, output_path, error, source_id, logs, api_mode, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                poll_url = excluded.poll_url,
                output_path = excluded.output_path,
                error = excluded.error,
                logs = excluded.logs,
                api_mode = excluded.api_mode",
            params![
                gen.id,
                gen.prompt,
                gen.input_data_uri,
                gen.provider,
                gen.status,
                gen.poll_url,
                gen.output_path,
                gen.error,
                gen.source_id,
                gen.logs,
                gen.api_mode,
                gen.created_at,
            ],
        )
        .map_err(|e| format!("Failed to upsert generation: {}", e))?;
        Ok(())
    }

    pub fn load_generation(&self, id: &str) -> Option<Generation> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT id, prompt, input_data_uri, provider, status, poll_url, output_path, error, source_id, logs, api_mode, created_at
             FROM generations WHERE id = ?1",
            params![id],
            |row| {
                Ok(Generation {
                    id: row.get(0)?,
                    prompt: row.get(1)?,
                    input_data_uri: row.get(2)?,
                    provider: row.get(3)?,
                    status: row.get(4)?,
                    poll_url: row.get(5)?,
                    output_path: row.get(6)?,
                    error: row.get(7)?,
                    source_id: row.get(8)?,
                    logs: row.get(9)?,
                    api_mode: row.get(10)?,
                    created_at: row.get(11)?,
                })
            },
        )
        .ok()
    }

    pub fn list_generations(&self) -> Result<Vec<Generation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // `input_data_uri` is the full base64 source image. The list feed is
        // fetched on every poll/refresh, and the frontend only needs the inline
        // image for *pending* rows (the in-progress placeholder tile). Emptying
        // it for settled rows keeps this from shipping many MB of base64 across
        // the IPC bridge (and being JSON-parsed on the UI thread) each refetch.
        let mut stmt = conn
            .prepare(
                "SELECT id, prompt,
                        CASE WHEN status = 'pending' THEN input_data_uri ELSE '' END AS input_data_uri,
                        provider, status, poll_url, output_path, error, source_id, logs, api_mode, created_at
                 FROM generations ORDER BY created_at DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let records = stmt
            .query_map([], |row| {
                Ok(Generation {
                    id: row.get(0)?,
                    prompt: row.get(1)?,
                    input_data_uri: row.get(2)?,
                    provider: row.get(3)?,
                    status: row.get(4)?,
                    poll_url: row.get(5)?,
                    output_path: row.get(6)?,
                    error: row.get(7)?,
                    source_id: row.get(8)?,
                    logs: row.get(9)?,
                    api_mode: row.get(10)?,
                    created_at: row.get(11)?,
                })
            })
            .map_err(|e| format!("Failed to query generations: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
    }

    /// Every `queued` generation, oldest first (FIFO). Drained by
    /// `submit_queued`, which groups same-source rows together before
    /// promoting each group to `pending` by submitting it to the provider.
    /// `input_data_uri` is empty for queued rows (the source is read from
    /// disk at submit time via `source_id`). Unbounded: queue depth is small
    /// and user-driven (a handful to a few dozen jobs at once), so grouping
    /// needs to see the whole queued set before deciding which groups to
    /// take this tick, not just an arbitrary row-count prefix of it.
    pub fn list_queued_all(&self) -> Result<Vec<Generation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, prompt, input_data_uri, provider, status, poll_url, output_path, error, source_id, logs, api_mode, created_at
                 FROM generations WHERE status = 'queued' ORDER BY created_at ASC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let records = stmt
            .query_map([], |row| {
                Ok(Generation {
                    id: row.get(0)?,
                    prompt: row.get(1)?,
                    input_data_uri: row.get(2)?,
                    provider: row.get(3)?,
                    status: row.get(4)?,
                    poll_url: row.get(5)?,
                    output_path: row.get(6)?,
                    error: row.get(7)?,
                    source_id: row.get(8)?,
                    logs: row.get(9)?,
                    api_mode: row.get(10)?,
                    created_at: row.get(11)?,
                })
            })
            .map_err(|e| format!("Failed to query queued: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
    }

    /// Interactions-mode rows checkpointed `pending`/`poll_url=NULL` right
    /// before their spawned task started (see `generation.rs::do_submit`),
    /// but whose task never got to finish — the app closed/crashed mid-flight.
    /// Batch-mode `pending` rows always carry a poll_url, so this predicate
    /// unambiguously identifies orphans without needing an `api_mode` filter.
    /// Resets them to `queued` so the normal drain loop silently re-fires
    /// them; called once per workspace open.
    pub fn reconcile_orphaned_interactions(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE generations SET status = 'queued' WHERE status = 'pending' AND poll_url IS NULL",
            [],
        )
        .map_err(|e| format!("Failed to reconcile orphaned interactions: {}", e))?;
        Ok(())
    }

    /// Drop every `queued` generation. Backs the "Clear queue" action; rows that
    /// have already advanced to `pending` (submitted) are left to finish.
    pub fn clear_queued(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM generations WHERE status = 'queued'", [])
            .map_err(|e| format!("Failed to clear queue: {}", e))?;
        Ok(())
    }

    pub fn delete_generation_by_id(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM generations WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete generation: {}", e))?;
        Ok(())
    }

    pub fn find_generation_by_output_path(&self, path: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT id FROM generations WHERE output_path = ?1",
            params![path],
            |row| row.get(0),
        )
        .ok()
    }

    /// One-time seed from existing files on disk. Uses INSERT OR IGNORE so it's
    /// idempotent — safe to run every time this workspace is opened.
    pub fn seed_from_disk(&self) -> Result<(), String> {
        let images_dir = self.storage_dir();

        // Seed generations from existing JSON sidecars (legacy format).
        let generations_dir = images_dir.join("generations");
        if generations_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&generations_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map_or(false, |e| e == "json") {
                        if let Ok(json) = std::fs::read_to_string(&path) {
                            if let Ok(gen) = serde_json::from_str::<Generation>(&json) {
                                let _ = self.upsert_generation(&gen);
                            }
                        }
                    }
                }
            }
        }

        // Seed images from top-level directory
        if images_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&images_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path
                        .extension()
                        .map(|e| e == "png" || e == "jpg" || e == "jpeg")
                        .unwrap_or(false)
                    {
                        continue;
                    }

                    let metadata = match entry.metadata() {
                        Ok(m) => m,
                        _ => continue,
                    };
                    let created = metadata
                        .created()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);

                    let filename = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let image_entry = ImageEntry {
                        path: path.to_string_lossy().to_string(),
                        id: uuid::Uuid::new_v4().to_string(),
                        title: Some(filename.clone()),
                        filename,
                        created_at: created,
                        size_bytes: metadata.len(),
                    };
                    let _ = self.insert_image(&image_entry);
                }
            }
        }

        Ok(())
    }
}
