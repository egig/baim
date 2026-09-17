use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::generation::{Generation, ImageEntry};
use crate::provider::DEFAULT_PROVIDER;

/// `settings` key under which the globally-selected image provider is stored.
const ACTIVE_PROVIDER_KEY: &str = "active_provider";
/// `settings` key holding the folder the browser was showing when the app last
/// closed, so it reopens there on the next launch (falling back to the home
/// directory if it no longer exists — see `browse::list_dir`).
const LAST_VISITED_PATH_KEY: &str = "last_visited_path";

/// `settings` key holding a given provider's API key. Matches the historical
/// per-provider naming (`<provider_id>_api_key`, e.g. `google_api_key`).
fn api_key_setting_key(provider_id: &str) -> String {
    format!("{}_api_key", provider_id)
}

/// A user-saved prompt template: a name + reusable prompt text, with a
/// preview image copied into app-wide storage (see `templates.rs`) so it
/// survives its source folder being moved/renamed/deleted.
#[derive(Serialize)]
pub struct TemplateRow {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub preview_path: String,
    pub created_at: i64,
}

/// One turn of the persistent chat thread (one thread, app-wide — see
/// `chat.rs`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageRow {
    pub id: String,
    /// `"user"` or `"assistant"`.
    pub role: String,
    pub content: String,
    /// Absolute paths the user attached to this turn (empty for assistant
    /// turns).
    pub attachments: Vec<String>,
    /// Set on an assistant turn that triggered a generation via the
    /// `generate_image` tool, so the UI can render its live status/result
    /// inline instead of just the turn's text.
    pub generation_id: Option<String>,
    pub created_at: i64,
}

/// The app-wide database (`baim.db`): global settings (API keys, active
/// provider), the image/generation catalog (keyed by absolute path — see
/// `generation.rs`), the persistent chat thread, recently-viewed files,
/// and user-saved templates. Exactly one instance, opened once at startup and
/// held for the app's whole lifetime.
pub struct RegistryDb {
    conn: Mutex<Connection>,
}

impl RegistryDb {
    pub fn open(db_path: &Path) -> Result<Self, String> {
        let conn =
            Connection::open(db_path).map_err(|e| format!("Failed to open DB: {}", e))?;
        Self::init_tables(&conn)?;
        Ok(RegistryDb {
            conn: Mutex::new(conn),
        })
    }

    fn init_tables(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS recent_files (
                path TEXT PRIMARY KEY,
                viewed_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                prompt TEXT NOT NULL,
                preview_path TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
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
            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                attachments TEXT NOT NULL DEFAULT '[]',
                generation_id TEXT,
                created_at INTEGER NOT NULL
            );
            ",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        // One-time migrations for pre-existing databases.

        // The Replicate provider was removed.
        conn.execute(
            "UPDATE settings SET value = 'google'
             WHERE key = ?1 AND value = 'replicate'",
            params![ACTIVE_PROVIDER_KEY],
        )
        .map_err(|e| format!("Failed to migrate active provider: {}", e))?;

        // `api_mode` distinguishes Batch vs Interactions API rows, orthogonal
        // to `provider` (which vendor). Added after `generations` already
        // existed for early installs, so it's not in the CREATE TABLE above —
        // ALTER TABLE errors if the column is already there, so guard with
        // PRAGMA table_info rather than re-running unconditionally.
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

    // ---- settings / provider / API keys ----

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

    /// The folder to reopen the browser at on next launch, if one was recorded.
    pub fn read_last_visited_path(&self) -> Option<String> {
        self.read_setting(LAST_VISITED_PATH_KEY)
    }

    /// Persist which folder the browser is showing, for the next launch.
    pub fn write_last_visited_path(&self, path: &str) -> Result<(), String> {
        self.write_setting(LAST_VISITED_PATH_KEY, path)
    }

    // ---- recently-viewed files ----

    /// Paths of recently clicked/viewed files, most-recent first. Backs the
    /// sidebar's "Recent" virtual folder; the caller (`browse::list_recent_files`)
    /// stats each one and drops any that no longer exist on disk.
    pub fn list_recent_file_paths(&self, limit: i64) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT path FROM recent_files ORDER BY viewed_at DESC LIMIT ?1")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let rows = stmt
            .query_map(params![limit], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query recent files: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Record that a file was just clicked/opened/viewed.
    pub fn record_file_visit(&self, path: &str, viewed_at: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO recent_files (path, viewed_at) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET viewed_at = excluded.viewed_at",
            params![path, viewed_at],
        )
        .map_err(|e| format!("Failed to record file visit: {}", e))?;
        Ok(())
    }

    // ---- templates ----

    /// Save a new prompt template row.
    pub fn insert_template(&self, row: &TemplateRow) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO templates (id, name, prompt, preview_path, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![row.id, row.name, row.prompt, row.preview_path, row.created_at],
        )
        .map_err(|e| format!("Failed to save template: {}", e))?;
        Ok(())
    }

    /// User-saved templates, most-recently-created first.
    pub fn list_templates(&self) -> Result<Vec<TemplateRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, prompt, preview_path, created_at
                 FROM templates ORDER BY created_at DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(TemplateRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    prompt: row.get(2)?,
                    preview_path: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| format!("Failed to query templates: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Delete a template row, returning its `preview_path` (if it existed) so
    /// the caller can also remove the copied preview file.
    pub fn delete_template(&self, id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let preview_path: Option<String> = conn
            .query_row(
                "SELECT preview_path FROM templates WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok();
        conn.execute("DELETE FROM templates WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete template: {}", e))?;
        Ok(preview_path)
    }

    /// Rename an existing template.
    pub fn rename_template(&self, id: &str, name: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE templates SET name = ?1 WHERE id = ?2",
            params![name, id],
        )
        .map_err(|e| format!("Failed to rename template: {}", e))?;
        Ok(())
    }

    /// Update a template's name and prompt in one shot (the Templat page's
    /// edit dialog). Preview replacement is handled separately by
    /// `set_template_preview` since it also touches the filesystem.
    pub fn update_template(&self, id: &str, name: &str, prompt: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE templates SET name = ?1, prompt = ?2 WHERE id = ?3",
            params![name, prompt, id],
        )
        .map_err(|e| format!("Failed to update template: {}", e))?;
        Ok(())
    }

    /// Point a template at a new preview file, returning its previous
    /// `preview_path` (empty string if it had none) so the caller can delete
    /// the now-orphaned file.
    pub fn set_template_preview(&self, id: &str, preview_path: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let old: Option<String> = conn
            .query_row(
                "SELECT preview_path FROM templates WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok();
        conn.execute(
            "UPDATE templates SET preview_path = ?1 WHERE id = ?2",
            params![preview_path, id],
        )
        .map_err(|e| format!("Failed to update template preview: {}", e))?;
        Ok(old)
    }

    // ---- image / generation catalog (keyed by absolute path — see generation.rs) ----

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

    /// Look up an image row by its absolute path. Used to resolve a file the
    /// user attaches to chat from the live filesystem browser, which may not
    /// have a catalog row yet (see `generation::get_or_create_image`).
    pub fn find_image_by_path(&self, path: &str) -> Option<ImageEntry> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT path, id, filename, title, created_at, size_bytes FROM images WHERE path = ?1",
            params![path],
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
    /// them; called once at app startup.
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

    // ---- chat ----

    pub fn insert_chat_message(&self, row: &ChatMessageRow) -> Result<(), String> {
        let attachments = serde_json::to_string(&row.attachments)
            .map_err(|e| format!("Failed to encode attachments: {}", e))?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO chat_messages (id, role, content, attachments, generation_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![row.id, row.role, row.content, attachments, row.generation_id, row.created_at],
        )
        .map_err(|e| format!("Failed to save chat message: {}", e))?;
        Ok(())
    }

    /// The whole persistent chat thread, oldest first.
    pub fn list_chat_messages(&self) -> Result<Vec<ChatMessageRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, role, content, attachments, generation_id, created_at
                 FROM chat_messages ORDER BY created_at ASC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                let attachments_json: String = row.get(3)?;
                let attachments: Vec<String> =
                    serde_json::from_str(&attachments_json).unwrap_or_default();
                Ok(ChatMessageRow {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    content: row.get(2)?,
                    attachments,
                    generation_id: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| format!("Failed to query chat messages: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }
}
