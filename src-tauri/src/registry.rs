use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::provider::DEFAULT_PROVIDER;

/// `settings` key under which the globally-selected image provider is stored.
const ACTIVE_PROVIDER_KEY: &str = "active_provider";
/// `settings` key under which the currently-active workspace's canonical path
/// is stored, so the app reopens it on the next launch.
const ACTIVE_WORKSPACE_PATH_KEY: &str = "active_workspace_path";

/// `settings` key holding a given provider's API key. Matches the historical
/// per-provider naming (`<provider_id>_api_key`, e.g. `google_api_key`).
fn api_key_setting_key(provider_id: &str) -> String {
    format!("{}_api_key", provider_id)
}

pub struct WorkspaceRow {
    pub path: String,
    pub last_opened_at: i64,
}

/// The app-wide registry (`sabi.db`): global settings (API keys, active
/// provider, Recraftory endpoint) plus the list of known workspaces. Exactly
/// one instance, opened once at startup and never swapped — unlike
/// `WorkspaceDb`, which is reopened on every workspace switch.
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
            CREATE TABLE IF NOT EXISTS workspaces (
                path TEXT PRIMARY KEY,
                last_opened_at INTEGER NOT NULL
            );
            ",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        // Migrations for pre-existing databases (files that started life as the
        // old single-catalog `catalog.db`, renamed in place to `sabi.db`).

        // The Replicate provider was removed.
        conn.execute(
            "UPDATE settings SET value = 'google'
             WHERE key = ?1 AND value = 'replicate'",
            params![ACTIVE_PROVIDER_KEY],
        )
        .map_err(|e| format!("Failed to migrate active provider: {}", e))?;

        // The "cloud" provider was renamed to "recraftory".
        conn.execute(
            "UPDATE settings SET value = 'recraftory'
             WHERE key = ?1 AND value = 'cloud'",
            params![ACTIVE_PROVIDER_KEY],
        )
        .map_err(|e| format!("Failed to migrate active provider: {}", e))?;
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

    /// Known workspaces, most-recently-opened first.
    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT path, last_opened_at FROM workspaces ORDER BY last_opened_at DESC")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(WorkspaceRow {
                    path: row.get(0)?,
                    last_opened_at: row.get(1)?,
                })
            })
            .map_err(|e| format!("Failed to query workspaces: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Record that a workspace (by canonical path) was just opened.
    pub fn upsert_workspace_opened(&self, path: &str, opened_at: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO workspaces (path, last_opened_at) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at",
            params![path, opened_at],
        )
        .map_err(|e| format!("Failed to record workspace: {}", e))?;
        Ok(())
    }

    /// Remove a workspace from the recents list. Touches no files.
    pub fn forget_workspace(&self, path: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM workspaces WHERE path = ?1", params![path])
            .map_err(|e| format!("Failed to forget workspace: {}", e))?;
        Ok(())
    }

    /// The workspace path to reopen on next launch, if one was recorded.
    pub fn read_active_workspace_path(&self) -> Option<String> {
        self.read_setting(ACTIVE_WORKSPACE_PATH_KEY)
    }

    /// Persist which workspace is currently active, for the next launch.
    pub fn set_active_workspace_path(&self, path: &str) -> Result<(), String> {
        self.write_setting(ACTIVE_WORKSPACE_PATH_KEY, path)
    }
}
