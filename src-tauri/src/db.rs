use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::replicate::{default_storage_dir, Generation, ImageEntry};

/// `settings` key under which the user-chosen storage directory is stored.
const STORAGE_DIR_KEY: &str = "storage_dir";

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
                filename TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS generations (
                id TEXT PRIMARY KEY,
                prompt TEXT NOT NULL,
                input_data_uri TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                poll_url TEXT,
                output_path TEXT,
                error TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))
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

    pub fn insert_image(&self, entry: &ImageEntry) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO images (path, filename, created_at, size_bytes) VALUES (?1, ?2, ?3, ?4)",
            params![entry.path, entry.filename, entry.created_at, entry.size_bytes],
        )
        .map_err(|e| format!("Failed to insert image: {}", e))?;
        Ok(())
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
                "SELECT path, filename, created_at, size_bytes FROM images ORDER BY created_at DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let entries = stmt
            .query_map([], |row| {
                Ok(ImageEntry {
                    path: row.get(0)?,
                    filename: row.get(1)?,
                    created_at: row.get(2)?,
                    size_bytes: row.get::<_, i64>(3)? as u64,
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
            "INSERT INTO generations (id, prompt, input_data_uri, status, poll_url, output_path, error, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                poll_url = excluded.poll_url,
                output_path = excluded.output_path,
                error = excluded.error",
            params![
                gen.id,
                gen.prompt,
                gen.input_data_uri,
                gen.status,
                gen.poll_url,
                gen.output_path,
                gen.error,
                gen.created_at,
            ],
        )
        .map_err(|e| format!("Failed to upsert generation: {}", e))?;
        Ok(())
    }

    pub fn load_generation(&self, id: &str) -> Option<Generation> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT id, prompt, input_data_uri, status, poll_url, output_path, error, created_at
             FROM generations WHERE id = ?1",
            params![id],
            |row| {
                Ok(Generation {
                    id: row.get(0)?,
                    prompt: row.get(1)?,
                    input_data_uri: row.get(2)?,
                    status: row.get(3)?,
                    poll_url: row.get(4)?,
                    output_path: row.get(5)?,
                    error: row.get(6)?,
                    created_at: row.get(7)?,
                })
            },
        )
        .ok()
    }

    pub fn list_generations(&self) -> Result<Vec<Generation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, prompt, input_data_uri, status, poll_url, output_path, error, created_at
                 FROM generations ORDER BY created_at DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let records = stmt
            .query_map([], |row| {
                Ok(Generation {
                    id: row.get(0)?,
                    prompt: row.get(1)?,
                    input_data_uri: row.get(2)?,
                    status: row.get(3)?,
                    poll_url: row.get(4)?,
                    output_path: row.get(5)?,
                    error: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })
            .map_err(|e| format!("Failed to query generations: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
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

                    let image_entry = ImageEntry {
                        path: path.to_string_lossy().to_string(),
                        filename: path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default(),
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
