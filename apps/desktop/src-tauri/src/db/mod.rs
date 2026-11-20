use crate::capture::captures_dir;
use crate::types::{BrainKind, HistoryDetail, HistorySession, HistoryStep, Settings, Step};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub const CURRENT_SCHEMA_VERSION: i32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppPreference {
    pub app_executable: String,
    pub always_magnify: bool,
    pub preferred_brain: String,
}

#[derive(Clone)]
pub struct DbState {
    conn: Arc<Mutex<Connection>>,
    db_path: PathBuf,
}

impl DbState {
    /// Opens (or creates) the default SQLite database at `%LOCALAPPDATA%\GuideLens\guidelens_local.db`,
    /// enables WAL mode, backs up before migration, runs schema migrations, and prunes old captures.
    pub fn init_default() -> Result<Self, String> {
        let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
        let dir = base.join("GuideLens");
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create GuideLens data dir {:?}: {}", dir, e))?;
        let db_path = dir.join("guidelens_local.db");
        let state = Self::open(&db_path)?;

        let retention_days = state
            .get_settings()
            .map(|s| s.capture_retention_days)
            .unwrap_or(7);
        let _ = prune_captures_in_dir(&captures_dir(), retention_days);

        Ok(state)
    }

    /// Opens a SQLite database at `db_path`, enables WAL & foreign keys, backs up if needed, and runs migrations.
    pub fn open(db_path: &Path) -> Result<Self, String> {
        let existed_before = db_path.exists()
            && fs::metadata(db_path)
                .map(|m| m.len() > 0)
                .unwrap_or(false);

        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open SQLite DB at {:?}: {}", db_path, e))?;

        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("Failed to enable WAL mode: {}", e))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("Failed to enable foreign_keys: {}", e))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| format!("Failed to set synchronous=NORMAL: {}", e))?;

        let current_version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap_or(0);

        if current_version < CURRENT_SCHEMA_VERSION {
            if existed_before {
                let backup_path =
                    db_path.with_extension(format!("db.bak.v{}", current_version));
                let _ = fs::copy(db_path, &backup_path);
            }
            Self::run_migrations(&conn)?;
            conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
                .map_err(|e| format!("Failed to update user_version: {}", e))?;
        }

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: db_path.to_path_buf(),
        })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    fn run_migrations(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                active_app TEXT NOT NULL,
                user_query TEXT NOT NULL,
                brain_used TEXT NOT NULL CHECK (
                    brain_used IN ('agent_mcp', 'agent_cli', 'local_vlm', 'byo_api', 'groq_pro')
                ),
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS steps (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                step_number INTEGER NOT NULL,
                instruction_line TEXT NOT NULL,
                bbox_json TEXT,
                terminal_command TEXT,
                screenshot_path TEXT,
                completed INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS app_preferences (
                app_executable TEXT PRIMARY KEY,
                always_magnify INTEGER DEFAULT 0,
                preferred_brain TEXT DEFAULT 'auto'
            );

            CREATE TABLE IF NOT EXISTS kv_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_created_at
                ON sessions(created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_steps_session_step
                ON steps(session_id, step_number);
            "#,
        )
        .map_err(|e| format!("SQLite schema migration failed: {}", e))?;

        Ok(())
    }

    pub fn journal_mode(&self) -> Result<String, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to read journal_mode: {}", e))
    }

    pub fn insert_session(
        &self,
        id: &str,
        active_app: &str,
        user_query: &str,
        brain_used: BrainKind,
        created_at: i64,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO sessions (id, active_app, user_query, brain_used, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, active_app, user_query, brain_used.as_str(), created_at],
        )
        .map_err(|e| format!("Failed to insert session: {}", e))?;
        Ok(())
    }

    pub fn insert_step(
        &self,
        session_id: &str,
        step_number: u32,
        instruction_line: &str,
        bbox_json: Option<&str>,
        terminal_command: Option<&str>,
        screenshot_path: Option<&str>,
    ) -> Result<String, String> {
        let step_id = Uuid::new_v4().to_string();
        let clamped = Step::clamp_instruction(instruction_line);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.execute(
            "INSERT INTO steps (id, session_id, step_number, instruction_line, bbox_json, terminal_command, screenshot_path, completed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
            params![
                step_id,
                session_id,
                step_number,
                clamped,
                bbox_json,
                terminal_command,
                screenshot_path
            ],
        )
        .map_err(|e| format!("Failed to insert step: {}", e))?;
        Ok(step_id)
    }

    pub fn mark_step_completed(
        &self,
        session_id: &str,
        step_number: u32,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.execute(
            "UPDATE steps SET completed = 1 WHERE session_id = ?1 AND step_number = ?2",
            params![session_id, step_number],
        )
        .map_err(|e| format!("Failed to mark step completed: {}", e))?;
        Ok(())
    }

    pub fn history_list(&self, limit: u32) -> Result<Vec<HistorySession>, String> {
        let safe_limit = limit.clamp(1, 500);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.active_app, s.user_query, s.brain_used, s.created_at,
                        (SELECT COUNT(*) FROM steps st WHERE st.session_id = s.id) AS step_count
                 FROM sessions s
                 ORDER BY s.created_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("Failed to prepare history_list: {}", e))?;

        let rows = stmt
            .query_map(params![safe_limit], |row| {
                let brain_str: String = row.get(3)?;
                let brain_used = BrainKind::from_str(&brain_str).unwrap_or(BrainKind::LocalVlm);
                let step_count: i64 = row.get(5)?;
                Ok(HistorySession {
                    id: row.get(0)?,
                    active_app: row.get(1)?,
                    user_query: row.get(2)?,
                    brain_used,
                    created_at: row.get(4)?,
                    step_count: step_count.max(0) as usize,
                })
            })
            .map_err(|e| format!("Failed to query history_list: {}", e))?;

        let mut sessions = Vec::new();
        for r in rows {
            sessions.push(r.map_err(|e| format!("Row decode error: {}", e))?);
        }
        Ok(sessions)
    }

    pub fn history_get(&self, session_id: &str) -> Result<HistoryDetail, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;

        let mut session = conn
            .query_row(
                "SELECT id, active_app, user_query, brain_used, created_at
                 FROM sessions
                 WHERE id = ?1",
                params![session_id],
                |row| {
                    let brain_str: String = row.get(3)?;
                    let brain_used =
                        BrainKind::from_str(&brain_str).unwrap_or(BrainKind::LocalVlm);
                    Ok(HistorySession {
                        id: row.get(0)?,
                        active_app: row.get(1)?,
                        user_query: row.get(2)?,
                        brain_used,
                        created_at: row.get(4)?,
                        step_count: 0,
                    })
                },
            )
            .map_err(|e| format!("Session '{}' not found: {}", session_id, e))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, step_number, instruction_line, bbox_json, terminal_command, screenshot_path, completed
                 FROM steps
                 WHERE session_id = ?1
                 ORDER BY step_number ASC",
            )
            .map_err(|e| format!("Failed to prepare steps query: {}", e))?;

        let rows = stmt
            .query_map(params![session_id], |row| {
                let bbox_json: Option<String> = row.get(4)?;
                let bbox = bbox_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<[f64; 4]>(s).ok());
                let completed_int: i32 = row.get(7)?;
                Ok(HistoryStep {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    step_number: row.get(2)?,
                    instruction_line: row.get(3)?,
                    bbox,
                    bbox_json,
                    terminal_command: row.get(5)?,
                    screenshot_path: row.get(6)?,
                    completed: completed_int != 0,
                })
            })
            .map_err(|e| format!("Failed to query steps: {}", e))?;

        let mut steps = Vec::new();
        for r in rows {
            steps.push(r.map_err(|e| format!("Step row decode error: {}", e))?);
        }
        session.step_count = steps.len();

        Ok(HistoryDetail { session, steps })
    }

    pub fn get_app_preference(&self, app_executable: &str) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.query_row(
            "SELECT preferred_brain FROM app_preferences WHERE LOWER(app_executable) = LOWER(?1)",
            params![app_executable],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query app_preferences: {}", e))
    }

    pub fn get_app_preference_record(
        &self,
        app_executable: &str,
    ) -> Result<Option<AppPreference>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.query_row(
            "SELECT app_executable, always_magnify, preferred_brain
             FROM app_preferences
             WHERE LOWER(app_executable) = LOWER(?1)",
            params![app_executable],
            |row| {
                let mag: i32 = row.get(1)?;
                Ok(AppPreference {
                    app_executable: row.get(0)?,
                    always_magnify: mag != 0,
                    preferred_brain: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to query app_preferences record: {}", e))
    }

    pub fn set_app_preference(
        &self,
        app_executable: &str,
        always_magnify: bool,
        preferred_brain: &str,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.execute(
            "INSERT INTO app_preferences (app_executable, always_magnify, preferred_brain)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(app_executable) DO UPDATE SET
               always_magnify = excluded.always_magnify,
               preferred_brain = excluded.preferred_brain",
            params![
                app_executable,
                if always_magnify { 1 } else { 0 },
                preferred_brain
            ],
        )
        .map_err(|e| format!("Failed to upsert app_preferences: {}", e))?;
        Ok(())
    }

    pub fn get_settings(&self) -> Result<Settings, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        let json_opt: Option<String> = conn
            .query_row(
                "SELECT value_json FROM kv_settings WHERE key = 'global_settings'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to read settings from DB: {}", e))?;

        match json_opt {
            Some(raw) => serde_json::from_str::<Settings>(&raw)
                .or_else(|_| Ok(Settings::default())),
            None => Ok(Settings::default()),
        }
    }

    pub fn set_settings(&self, settings: &Settings) -> Result<(), String> {
        let serialized = serde_json::to_string(settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.execute(
            "INSERT INTO kv_settings (key, value_json) VALUES ('global_settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            params![serialized],
        )
        .map_err(|e| format!("Failed to save settings to DB: {}", e))?;
        Ok(())
    }
}

/// Convenience wrappers callable directly via `crate::db::insert_session(...)` etc.
pub fn insert_session(
    db: &DbState,
    id: &str,
    active_app: &str,
    user_query: &str,
    brain_used: BrainKind,
    created_at: i64,
) -> Result<(), String> {
    db.insert_session(id, active_app, user_query, brain_used, created_at)
}

pub fn insert_step(
    db: &DbState,
    session_id: &str,
    step_number: u32,
    instruction_line: &str,
    bbox_json: Option<&str>,
    terminal_command: Option<&str>,
    screenshot_path: Option<&str>,
) -> Result<String, String> {
    db.insert_step(
        session_id,
        step_number,
        instruction_line,
        bbox_json,
        terminal_command,
        screenshot_path,
    )
}

pub fn get_app_preference(db: &DbState, exe: &str) -> Option<String> {
    db.get_app_preference(exe).ok().flatten()
}

/// Prunes capture files in `dir` older than `retention_days` days.
/// Returns the count of deleted files.
pub fn prune_captures_in_dir(dir: &Path, retention_days: u32) -> Result<usize, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let max_age = Duration::from_secs(u64::from(retention_days.max(1)) * 86_400);
    let now = SystemTime::now();
    let mut removed = 0usize;

    let entries =
        fs::read_dir(dir).map_err(|e| format!("Failed to read captures dir {:?}: {}", dir, e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "jpg" && ext != "jpeg" && ext != "png" && ext != "webp" {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if let Ok(age) = now.duration_since(modified) {
                    if age > max_age && fs::remove_file(&path).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
    }
    Ok(removed)
}

pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_wal_and_all_five_brain_kinds() {
        let tmp = tempdir().expect("tempdir");
        let db_path = tmp.path().join("test_guidelens.db");
        let db = DbState::open(&db_path).expect("open db");

        assert_eq!(db.journal_mode().expect("journal_mode").to_lowercase(), "wal");

        // Verify all 5 BrainKind values in decisions.md §3 are accepted by the CHECK constraint
        for (i, kind) in BrainKind::ALL.iter().enumerate() {
            let session_id = format!("sess-{}", i);
            db.insert_session(
                &session_id,
                "Photoshop.exe",
                "How do I remove a background?",
                *kind,
                1_700_000_000 + i as i64,
            )
            .unwrap_or_else(|e| panic!("BrainKind {:?} failed: {}", kind, e));

            db.insert_step(
                &session_id,
                1,
                "Click the Object Selection Tool in the left toolbar, or press W.",
                Some("[40.0, 180.0, 32.0, 32.0]"),
                None,
                Some("C:\\Users\\test\\captures\\shot.jpg"),
            )
            .expect("insert step");
        }

        let list = db.history_list(10).expect("history_list");
        assert_eq!(list.len(), 5);
        assert_eq!(list[0].step_count, 1);

        let detail = db.history_get("sess-0").expect("history_get");
        assert_eq!(detail.session.active_app, "Photoshop.exe");
        assert_eq!(detail.steps.len(), 1);
        assert_eq!(detail.steps[0].bbox, Some([40.0, 180.0, 32.0, 32.0]));
    }

    #[test]
    fn test_backup_before_schema_migration() {
        let tmp = tempdir().expect("tempdir");
        let db_path = tmp.path().join("upgrade_test.db");

        // Pre-create a v0 database file
        {
            let raw_conn = Connection::open(&db_path).expect("create raw");
            raw_conn
                .execute("CREATE TABLE dummy (id INT);", [])
                .expect("create dummy");
            raw_conn
                .pragma_update(None, "user_version", 0)
                .expect("set v0");
        }

        // Now open with DbState — it must back up before migrating to CURRENT_SCHEMA_VERSION
        let _db = DbState::open(&db_path).expect("open and migrate");
        let backup_path = db_path.with_extension("db.bak.v0");
        assert!(
            backup_path.exists(),
            "Expected backup file {:?} to be created before schema migration",
            backup_path
        );
    }

    #[test]
    fn test_settings_and_app_preferences() {
        let tmp = tempdir().expect("tempdir");
        let db = DbState::open(&tmp.path().join("prefs.db")).expect("open");

        let mut settings = db.get_settings().expect("default settings");
        assert_eq!(settings.brain_mode, "auto");
        assert_eq!(settings.capture_retention_days, 7);

        settings.brain_mode = "groq_pro".to_string();
        settings.high_contrast = true;
        settings.always_magnify = true;
        db.set_settings(&settings).expect("save settings");

        let loaded = db.get_settings().expect("reload settings");
        assert_eq!(loaded.brain_mode, "groq_pro");
        assert!(loaded.high_contrast);
        assert!(loaded.always_magnify);

        db.set_app_preference("Code.exe", false, "agent_cli")
            .expect("set app pref");
        assert_eq!(
            db.get_app_preference("code.exe").expect("get app pref"),
            Some("agent_cli".to_string())
        );
    }

    #[test]
    fn test_prune_captures_older_than_retention_days() {
        let tmp = tempdir().expect("tempdir");
        let old_jpg = tmp.path().join("old_shot.jpg");
        let new_jpg = tmp.path().join("new_shot.jpg");
        let keep_txt = tmp.path().join("notes.txt");

        fs::write(&old_jpg, b"old").expect("write old");
        fs::write(&new_jpg, b"new").expect("write new");
        fs::write(&keep_txt, b"notes").expect("write txt");

        let nine_days_ago = SystemTime::now() - Duration::from_secs(9 * 86_400);
        fs::OpenOptions::new()
            .write(true)
            .open(&old_jpg)
            .expect("open old")
            .set_modified(nine_days_ago)
            .expect("set old mtime");
        fs::OpenOptions::new()
            .write(true)
            .open(&keep_txt)
            .expect("open txt")
            .set_modified(nine_days_ago)
            .expect("set txt mtime");

        let removed = prune_captures_in_dir(tmp.path(), 7).expect("prune");
        assert_eq!(removed, 1);
        assert!(!old_jpg.exists());
        assert!(new_jpg.exists());
        assert!(keep_txt.exists());
    }
}
