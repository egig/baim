use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::generation::{default_storage_dir, Generation, ImageEntry};
use crate::provider::DEFAULT_PROVIDER;

/// `settings` key under which the user-chosen storage directory is stored.
const STORAGE_DIR_KEY: &str = "storage_dir";
/// `settings` key under which the globally-selected image provider is stored.
const ACTIVE_PROVIDER_KEY: &str = "active_provider";

/// `settings` key holding a given provider's API key. Matches the historical
/// per-provider naming (`<provider_id>_api_key`, e.g. `google_api_key`).
fn api_key_setting_key(provider_id: &str) -> String {
    format!("{}_api_key", provider_id)
}

pub struct Db {
    conn: Mutex<Connection>,
    /// The directory image files live in. Loaded from the `settings` table on
    /// open (falling back to `default_storage_dir`) and cached here so image
    /// operations don't hit the DB for it on every call.
    storage_dir: Mutex<PathBuf>,
}

impl Db {
    pub fn open(db_path: &Path) -> Result<Self, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open DB: {}", e))?;
        Self::init_tables(&conn)?;
        let storage_dir = Self::read_storage_dir(&conn)?;
        Ok(Db {
            conn: Mutex::new(conn),
            storage_dir: Mutex::new(storage_dir),
        })
    }

    fn init_tables(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS images (
                path TEXT PRIMARY KEY,
                id TEXT,
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
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        // Migrations for pre-existing databases: add columns if they're missing.
        // `ALTER TABLE ... ADD COLUMN` errors when the column already exists, so
        // ignore that (idempotent) failure. These must run before the index below,
        // since on an existing DB the `CREATE TABLE IF NOT EXISTS` above is a no-op
        // and doesn't add the new columns.
        let _ = conn.execute(
            "ALTER TABLE generations ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'",
            [],
        );
        let _ = conn.execute("ALTER TABLE images ADD COLUMN id TEXT", []);
        let _ = conn.execute("ALTER TABLE images ADD COLUMN title TEXT", []);
        let _ = conn.execute("ALTER TABLE generations ADD COLUMN source_id TEXT", []);
        let _ = conn.execute("ALTER TABLE generations ADD COLUMN logs TEXT", []);

        // The Replicate provider was removed. Databases from before that keep
        // finished rows' provider as-is (historical record), but anything that
        // would still be dispatched to it must be moved off: the global
        // selection falls back to google, and unfinished replicate jobs are
        // failed (their poll URLs point at a backend we can no longer talk to).
        conn.execute(
            "UPDATE settings SET value = 'google'
             WHERE key = ?1 AND value = 'replicate'",
            params![ACTIVE_PROVIDER_KEY],
        )
        .map_err(|e| format!("Failed to migrate active provider: {}", e))?;
        conn.execute(
            "UPDATE generations SET status = 'failed', error = 'Replicate provider was removed'
             WHERE provider = 'replicate' AND status IN ('queued', 'pending')",
            [],
        )
        .map_err(|e| format!("Failed to fail orphaned replicate generations: {}", e))?;

        // The "cloud" provider was renamed to "recraftory" (same backend, new
        // name). Rewrite existing databases so saved selections, keys, and
        // generation history follow the rename rather than silently falling
        // back to the default provider.
        conn.execute(
            "UPDATE settings SET value = 'recraftory'
             WHERE key = ?1 AND value = 'cloud'",
            params![ACTIVE_PROVIDER_KEY],
        )
        .map_err(|e| format!("Failed to migrate active provider: {}", e))?;
        conn.execute(
            "UPDATE generations SET provider = 'recraftory' WHERE provider = 'cloud'",
            [],
        )
        .map_err(|e| format!("Failed to migrate cloud generations: {}", e))?;
        conn.execute(
            "UPDATE settings SET key = 'recraftory_api_key' WHERE key = 'cloud_api_key'",
            [],
        )
        .map_err(|e| format!("Failed to migrate cloud api key setting: {}", e))?;
        conn.execute(
            "UPDATE settings SET key = 'recraftory_endpoint' WHERE key = 'cloud_endpoint'",
            [],
        )
        .map_err(|e| format!("Failed to migrate cloud endpoint setting: {}", e))?;

        // Index on the source link, created after the column is guaranteed to exist.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_generations_source ON generations(source_id)",
            [],
        )
        .map_err(|e| format!("Failed to create index: {}", e))?;

        // Backfill stable ids for image rows created before the `id` column
        // existed. rusqlite has no SQL uuid function, so generate one per row in
        // Rust. New generations only reference images by this id, so old rows need
        // one to be linkable as a source going forward.
        Self::backfill_image_ids(conn)?;

        Ok(())
    }

    /// Assign a fresh uuid to every image row still missing an `id` (post-migration
    /// backfill). Idempotent: rows that already have an id are left untouched.
    fn backfill_image_ids(conn: &Connection) -> Result<(), String> {
        let paths: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT path FROM images WHERE id IS NULL OR id = ''")
                .map_err(|e| format!("Failed to prepare backfill query: {}", e))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| format!("Failed to query images for backfill: {}", e))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };
        for path in paths {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "UPDATE images SET id = ?1 WHERE path = ?2",
                params![id, path],
            )
            .map_err(|e| format!("Failed to backfill image id: {}", e))?;
        }
        Ok(())
    }

    fn read_storage_dir(conn: &Connection) -> Result<PathBuf, String> {
        let stored: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![STORAGE_DIR_KEY],
                |row| row.get(0),
            )
            .ok();
        match stored {
            Some(s) if !s.is_empty() => Ok(PathBuf::from(s)),
            _ => default_storage_dir(),
        }
    }

    /// The currently configured storage directory.
    pub fn storage_dir(&self) -> PathBuf {
        self.storage_dir
            .lock()
            .expect("storage_dir mutex poisoned")
            .clone()
    }

    /// Persist and cache a new storage directory. The path is expected to be
    /// already created and canonicalized by the caller.
    pub fn set_storage_dir(&self, dir: &Path) -> Result<(), String> {
        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![STORAGE_DIR_KEY, dir.to_string_lossy().to_string()],
            )
            .map_err(|e| format!("Failed to save storage directory: {}", e))?;
        }
        let mut guard = self.storage_dir.lock().map_err(|e| e.to_string())?;
        *guard = dir.to_path_buf();
        Ok(())
    }

    /// The globally-selected image provider id, falling back to the default when
    /// unset (fresh installs / pre-provider databases).
    pub fn read_active_provider(&self) -> String {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return DEFAULT_PROVIDER.to_string(),
        };
        let stored: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![ACTIVE_PROVIDER_KEY],
                |row| row.get(0),
            )
            .ok();
        match stored {
            Some(s) if !s.is_empty() => s,
            _ => DEFAULT_PROVIDER.to_string(),
        }
    }

    /// Persist the globally-selected image provider id.
    pub fn set_active_provider(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![ACTIVE_PROVIDER_KEY, id],
        )
        .map_err(|e| format!("Failed to save active provider: {}", e))?;
        Ok(())
    }

    /// The stored API key for a provider, if one has been saved and is
    /// non-empty. Returned to the settings UI and read on every generation.
    pub fn read_api_key(&self, provider_id: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        let stored: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![api_key_setting_key(provider_id)],
                |row| row.get(0),
            )
            .ok();
        stored.filter(|s| !s.is_empty())
    }

    /// Read a raw setting value from the settings table.
    pub fn read_setting(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        let stored: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .ok();
        stored.filter(|s| !s.is_empty())
    }

    /// Persist a raw setting to the settings table.
    pub fn write_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|e| format!("Failed to write setting: {}", e))?;
        Ok(())
    }

    /// Persist a provider's API key. An empty/whitespace-only key clears it.
    pub fn set_api_key(&self, provider_id: &str, key: &str) -> Result<(), String> {
        let key = key.trim();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        if key.is_empty() {
            conn.execute(
                "DELETE FROM settings WHERE key = ?1",
                params![api_key_setting_key(provider_id)],
            )
            .map_err(|e| format!("Failed to clear API key: {}", e))?;
        } else {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![api_key_setting_key(provider_id), key],
            )
            .map_err(|e| format!("Failed to save API key: {}", e))?;
        }
        Ok(())
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
                    id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
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
                    id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
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
            "INSERT INTO generations (id, prompt, input_data_uri, provider, status, poll_url, output_path, error, source_id, logs, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                poll_url = excluded.poll_url,
                output_path = excluded.output_path,
                error = excluded.error,
                logs = excluded.logs",
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
                gen.created_at,
            ],
        )
        .map_err(|e| format!("Failed to upsert generation: {}", e))?;
        Ok(())
    }

    pub fn load_generation(&self, id: &str) -> Option<Generation> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT id, prompt, input_data_uri, provider, status, poll_url, output_path, error, source_id, logs, created_at
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
                    created_at: row.get(10)?,
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
                        provider, status, poll_url, output_path, error, source_id, logs, created_at
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
                    created_at: row.get(10)?,
                })
            })
            .map_err(|e| format!("Failed to query generations: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
    }

    /// The oldest `queued` generations (FIFO), up to `limit`. Drained by
    /// `submit_queued`, which promotes each to `pending` by submitting it to the
    /// provider. `input_data_uri` is empty for queued rows (the source is read
    /// from disk at submit time via `source_id`).
    pub fn list_queued(&self, limit: usize) -> Result<Vec<Generation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, prompt, input_data_uri, provider, status, poll_url, output_path, error, source_id, logs, created_at
                 FROM generations WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?1",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let records = stmt
            .query_map(params![limit as i64], |row| {
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
                    created_at: row.get(10)?,
                })
            })
            .map_err(|e| format!("Failed to query queued: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
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
    /// idempotent — safe to run on every startup.
    pub fn seed_from_disk(&self) -> Result<(), String> {
        let images_dir = self.storage_dir();

        // Seed generations from existing JSON sidecars
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
