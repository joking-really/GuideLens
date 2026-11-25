use crate::capture::captures_dir;
use crate::types::{
    BrainKind, HistoryDetail, HistorySession, HistoryStep, KgEdgeDto, KgNodeDto, KnowledgeGraphDto,
    ScreenDayDetailDto, ScreenDayFrameDto, ScreenDayMeetingGroup, ScreenDayProjectGroup,
    ScreenDaySummaryDto, SessionGraphSummaryDto, Settings, Step,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub const CURRENT_SCHEMA_VERSION: i32 = 2;

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

            CREATE TABLE IF NOT EXISTS kg_nodes (
                id TEXT PRIMARY KEY,
                node_type TEXT NOT NULL,
                app_exe TEXT NOT NULL,
                label TEXT NOT NULL,
                metadata_json TEXT,
                hit_count INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_kg_nodes_app
                ON kg_nodes(LOWER(app_exe), hit_count DESC, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_kg_nodes_type
                ON kg_nodes(node_type, updated_at DESC);

            CREATE TABLE IF NOT EXISTS kg_edges (
                id TEXT PRIMARY KEY,
                from_node TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
                to_node TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
                relation TEXT NOT NULL,
                intent TEXT NOT NULL,
                control_name TEXT,
                control_type TEXT,
                shortcut TEXT,
                norm_bbox_json TEXT,
                success_count INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_kg_edges_from
                ON kg_edges(from_node, success_count DESC, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_kg_edges_to
                ON kg_edges(to_node);

            CREATE INDEX IF NOT EXISTS idx_kg_edges_intent
                ON kg_edges(intent);

            CREATE TABLE IF NOT EXISTS session_graphs (
                session_id TEXT PRIMARY KEY,
                day_key TEXT NOT NULL,
                active_app TEXT NOT NULL,
                goal TEXT NOT NULL,
                graph_md_path TEXT NOT NULL,
                node_count INTEGER NOT NULL DEFAULT 0,
                edge_count INTEGER NOT NULL DEFAULT 0,
                completed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_session_graphs_day
                ON session_graphs(day_key, created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_session_graphs_app
                ON session_graphs(LOWER(active_app), created_at DESC);

            CREATE TABLE IF NOT EXISTS screenday_frames (
                id TEXT PRIMARY KEY,
                day_key TEXT NOT NULL,
                captured_at INTEGER NOT NULL,
                image_path TEXT NOT NULL,
                active_app TEXT NOT NULL,
                window_title TEXT NOT NULL,
                project_name TEXT,
                meeting_name TEXT,
                ocr_excerpt TEXT,
                dhash TEXT NOT NULL,
                file_bytes INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_screenday_frames_day
                ON screenday_frames(day_key, captured_at ASC);

            CREATE INDEX IF NOT EXISTS idx_screenday_frames_captured
                ON screenday_frames(captured_at DESC);

            CREATE TABLE IF NOT EXISTS screenday_days (
                day_key TEXT PRIMARY KEY,
                folder_path TEXT NOT NULL,
                frame_count INTEGER NOT NULL DEFAULT 0,
                total_bytes INTEGER NOT NULL DEFAULT 0,
                session_count INTEGER NOT NULL DEFAULT 0,
                projects_json TEXT NOT NULL DEFAULT '[]',
                meetings_json TEXT NOT NULL DEFAULT '[]',
                summary_md TEXT,
                graph_md_path TEXT,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_screenday_days_updated
                ON screenday_days(updated_at DESC);
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

    pub fn upsert_kg_node(&self, node: &KgNodeDto) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        let initial_hits = node.hit_count.max(1);
        conn.execute(
            "INSERT INTO kg_nodes (id, node_type, app_exe, label, metadata_json, hit_count, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               node_type = excluded.node_type,
               app_exe = excluded.app_exe,
               label = excluded.label,
               metadata_json = COALESCE(excluded.metadata_json, kg_nodes.metadata_json),
               hit_count = kg_nodes.hit_count + CASE WHEN excluded.hit_count > 0 THEN excluded.hit_count ELSE 1 END,
               updated_at = excluded.updated_at",
            params![
                node.id,
                node.node_type,
                node.app_exe,
                node.label,
                node.metadata_json,
                initial_hits,
                node.updated_at
            ],
        )
        .map_err(|e| format!("Failed to upsert kg_node: {}", e))?;
        Ok(())
    }

    pub fn upsert_kg_edge(&self, edge: &KgEdgeDto) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        let norm_bbox_json = edge
            .norm_bbox
            .as_ref()
            .and_then(|b| serde_json::to_string(b).ok());
        let initial_success = edge.success_count.max(1);
        conn.execute(
            "INSERT INTO kg_edges (
                id, from_node, to_node, relation, intent,
                control_name, control_type, shortcut, norm_bbox_json,
                success_count, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
               from_node = excluded.from_node,
               to_node = excluded.to_node,
               relation = excluded.relation,
               intent = excluded.intent,
               control_name = COALESCE(excluded.control_name, kg_edges.control_name),
               control_type = COALESCE(excluded.control_type, kg_edges.control_type),
               shortcut = COALESCE(excluded.shortcut, kg_edges.shortcut),
               norm_bbox_json = COALESCE(excluded.norm_bbox_json, kg_edges.norm_bbox_json),
               success_count = kg_edges.success_count + CASE WHEN excluded.success_count > 0 THEN excluded.success_count ELSE 1 END,
               updated_at = excluded.updated_at",
            params![
                edge.id,
                edge.from_node,
                edge.to_node,
                edge.relation,
                edge.intent,
                edge.control_name,
                edge.control_type,
                edge.shortcut,
                norm_bbox_json,
                initial_success,
                edge.updated_at
            ],
        )
        .map_err(|e| format!("Failed to upsert kg_edge: {}", e))?;
        Ok(())
    }

    pub fn query_kg_for_app(&self, app_exe: &str, limit: usize) -> Result<KnowledgeGraphDto, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        query_kg_filtered(&conn, Some(app_exe), limit)
    }

    pub fn delete_kg_node(&self, node_id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.execute(
            "DELETE FROM kg_edges WHERE from_node = ?1 OR to_node = ?1",
            params![node_id],
        )
        .map_err(|e| format!("Failed to delete referencing kg_edges: {}", e))?;
        conn.execute("DELETE FROM kg_nodes WHERE id = ?1", params![node_id])
            .map_err(|e| format!("Failed to delete kg_node: {}", e))?;
        Ok(())
    }

    pub fn get_knowledge_graph(&self, app_filter: Option<&str>) -> Result<KnowledgeGraphDto, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        let trimmed = app_filter.map(str::trim).filter(|s| !s.is_empty());
        query_kg_filtered(&conn, trimmed, 1000)
    }

    pub fn insert_session_graph(&self, summary: &SessionGraphSummaryDto) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.execute(
            "INSERT INTO session_graphs (
                session_id, day_key, active_app, goal, graph_md_path,
                node_count, edge_count, completed, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(session_id) DO UPDATE SET
               day_key = excluded.day_key,
               active_app = excluded.active_app,
               goal = excluded.goal,
               graph_md_path = excluded.graph_md_path,
               node_count = excluded.node_count,
               edge_count = excluded.edge_count,
               completed = excluded.completed,
               created_at = excluded.created_at",
            params![
                summary.session_id,
                summary.day_key,
                summary.active_app,
                summary.goal,
                summary.graph_md_path,
                summary.node_count as i64,
                summary.edge_count as i64,
                if summary.completed { 1 } else { 0 },
                summary.created_at
            ],
        )
        .map_err(|e| format!("Failed to insert session_graph: {}", e))?;
        Ok(())
    }

    pub fn list_session_graphs(
        &self,
        day_key: Option<&str>,
        limit: u32,
    ) -> Result<Vec<SessionGraphSummaryDto>, String> {
        let safe_limit = limit.clamp(1, 500) as i64;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        let trimmed_day = day_key.map(str::trim).filter(|s| !s.is_empty());
        query_session_graphs(&conn, trimmed_day, None, safe_limit)
    }

    pub fn insert_screenday_frame(&self, frame: &ScreenDayFrameDto) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO screenday_frames (
                id, day_key, captured_at, image_path, active_app, window_title,
                project_name, meeting_name, ocr_excerpt, dhash, file_bytes
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                frame.id,
                frame.day_key,
                frame.captured_at,
                frame.image_path,
                frame.active_app,
                frame.window_title,
                frame.project_name,
                frame.meeting_name,
                frame.ocr_excerpt,
                frame.dhash,
                frame.file_bytes as i64
            ],
        )
        .map_err(|e| format!("Failed to insert screenday_frame: {}", e))?;
        Ok(())
    }

    pub fn upsert_screenday_day_meta(&self, meta: &ScreenDaySummaryDto) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        let projects_json =
            serde_json::to_string(&meta.projects).unwrap_or_else(|_| "[]".to_string());
        let meetings_json =
            serde_json::to_string(&meta.meetings).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO screenday_days (
                day_key, folder_path, frame_count, total_bytes, session_count,
                projects_json, meetings_json, summary_md, graph_md_path, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(day_key) DO UPDATE SET
               folder_path = excluded.folder_path,
               frame_count = excluded.frame_count,
               total_bytes = excluded.total_bytes,
               session_count = excluded.session_count,
               projects_json = excluded.projects_json,
               meetings_json = excluded.meetings_json,
               summary_md = COALESCE(excluded.summary_md, screenday_days.summary_md),
               graph_md_path = COALESCE(excluded.graph_md_path, screenday_days.graph_md_path),
               updated_at = excluded.updated_at",
            params![
                meta.day_key,
                meta.folder_path,
                meta.frame_count as i64,
                meta.total_bytes as i64,
                meta.session_count as i64,
                projects_json,
                meetings_json,
                meta.summary_md,
                meta.graph_md_path,
                meta.updated_at
            ],
        )
        .map_err(|e| format!("Failed to upsert screenday_day_meta: {}", e))?;
        Ok(())
    }

    pub fn update_screenday_day_summary(
        &self,
        day_key: &str,
        summary_md: &str,
        graph_md_path: Option<&str>,
        updated_at: i64,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        conn.execute(
            "INSERT INTO screenday_days (
                day_key, folder_path, frame_count, total_bytes, session_count,
                projects_json, meetings_json, summary_md, graph_md_path, updated_at
             ) VALUES (?1, '', 0, 0, 0, '[]', '[]', ?2, ?3, ?4)
             ON CONFLICT(day_key) DO UPDATE SET
               summary_md = excluded.summary_md,
               graph_md_path = COALESCE(excluded.graph_md_path, screenday_days.graph_md_path),
               updated_at = excluded.updated_at",
            params![day_key, summary_md, graph_md_path, updated_at],
        )
        .map_err(|e| format!("Failed to update screenday_day_summary: {}", e))?;
        Ok(())
    }

    pub fn list_screenday_days(&self, limit: u32) -> Result<Vec<ScreenDaySummaryDto>, String> {
        let safe_limit = limit.clamp(1, 500) as i64;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT day_key, folder_path, frame_count, total_bytes, session_count,
                        projects_json, meetings_json, summary_md, graph_md_path, updated_at
                 FROM screenday_days
                 ORDER BY day_key DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("Failed to prepare list_screenday_days: {}", e))?;
        let rows = stmt
            .query_map(params![safe_limit], decode_screenday_summary)
            .map_err(|e| format!("Failed to query list_screenday_days: {}", e))?;
        collect_rows(rows, "screenday_days")
    }

    pub fn get_screenday_day_detail(
        &self,
        day_key: &str,
    ) -> Result<Option<ScreenDayDetailDto>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;

        let summary_opt = conn
            .query_row(
                "SELECT day_key, folder_path, frame_count, total_bytes, session_count,
                        projects_json, meetings_json, summary_md, graph_md_path, updated_at
                 FROM screenday_days
                 WHERE day_key = ?1",
                params![day_key],
                decode_screenday_summary,
            )
            .optional()
            .map_err(|e| format!("Failed to query screenday_days: {}", e))?;

        let mut frame_stmt = conn
            .prepare(
                "SELECT id, day_key, captured_at, image_path, active_app, window_title,
                        project_name, meeting_name, ocr_excerpt, dhash, file_bytes
                 FROM screenday_frames
                 WHERE day_key = ?1
                 ORDER BY captured_at ASC",
            )
            .map_err(|e| format!("Failed to prepare screenday_frames query: {}", e))?;
        let frame_rows = frame_stmt
            .query_map(params![day_key], decode_screenday_frame)
            .map_err(|e| format!("Failed to query screenday_frames: {}", e))?;
        let frames = collect_rows(frame_rows, "screenday_frames")?;

        let sessions = query_session_graphs(&conn, Some(day_key), None, 200)?;

        if summary_opt.is_none() && frames.is_empty() && sessions.is_empty() {
            return Ok(None);
        }

        let project_groups = group_frames_by_project(&frames);
        let meeting_groups = group_frames_by_meeting(&frames);

        let summary = match summary_opt {
            Some(s) => s,
            None => ScreenDaySummaryDto {
                day_key: day_key.to_string(),
                folder_path: frames
                    .first()
                    .and_then(|f| Path::new(&f.image_path).parent())
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                frame_count: frames.len(),
                total_bytes: frames.iter().map(|f| f.file_bytes).sum(),
                session_count: sessions.len(),
                projects: project_groups.iter().map(|p| p.name.clone()).collect(),
                meetings: meeting_groups.iter().map(|m| m.name.clone()).collect(),
                summary_md: None,
                graph_md_path: None,
                updated_at: frames
                    .last()
                    .map(|f| f.captured_at)
                    .or_else(|| sessions.first().map(|s| s.created_at))
                    .unwrap_or(0),
            },
        };

        let day_graph_md = summary
            .graph_md_path
            .as_deref()
            .and_then(|p| read_optional_file(Path::new(p)));
        let day_diary_md = summary.summary_md.clone().or_else(|| {
            if summary.folder_path.is_empty() {
                None
            } else {
                read_optional_file(&Path::new(&summary.folder_path).join("diary.md"))
            }
        });

        Ok(Some(ScreenDayDetailDto {
            summary,
            frames,
            project_groups,
            meeting_groups,
            sessions,
            day_graph_md,
            day_diary_md,
        }))
    }

    pub fn get_latest_screenday_dhash(&self, day_key: Option<&str>) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        let trimmed = day_key.map(str::trim).filter(|s| !s.is_empty());
        match trimmed {
            Some(day) => conn
                .query_row(
                    "SELECT dhash FROM screenday_frames WHERE day_key = ?1 ORDER BY captured_at DESC LIMIT 1",
                    params![day],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| format!("Failed to query latest screenday dhash: {}", e)),
            None => conn
                .query_row(
                    "SELECT dhash FROM screenday_frames ORDER BY captured_at DESC LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| format!("Failed to query latest screenday dhash: {}", e)),
        }
    }
}

fn collect_rows<T, I>(rows: I, label: &str) -> Result<Vec<T>, String>
where
    I: Iterator<Item = rusqlite::Result<T>>,
{
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("{} row decode error: {}", label, e))?);
    }
    Ok(out)
}

fn read_optional_file(path: &Path) -> Option<String> {
    if path.is_file() {
        fs::read_to_string(path).ok()
    } else {
        None
    }
}

fn decode_kg_node(row: &Row<'_>) -> rusqlite::Result<KgNodeDto> {
    Ok(KgNodeDto {
        id: row.get(0)?,
        node_type: row.get(1)?,
        app_exe: row.get(2)?,
        label: row.get(3)?,
        metadata_json: row.get(4)?,
        hit_count: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn decode_kg_edge(row: &Row<'_>) -> rusqlite::Result<KgEdgeDto> {
    let norm_bbox_json: Option<String> = row.get(8)?;
    let norm_bbox = norm_bbox_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<[f64; 4]>(s).ok());
    Ok(KgEdgeDto {
        id: row.get(0)?,
        from_node: row.get(1)?,
        to_node: row.get(2)?,
        relation: row.get(3)?,
        intent: row.get(4)?,
        control_name: row.get(5)?,
        control_type: row.get(6)?,
        shortcut: row.get(7)?,
        norm_bbox,
        success_count: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn decode_session_graph(row: &Row<'_>) -> rusqlite::Result<SessionGraphSummaryDto> {
    let node_count: i64 = row.get(5)?;
    let edge_count: i64 = row.get(6)?;
    let completed_int: i32 = row.get(7)?;
    Ok(SessionGraphSummaryDto {
        session_id: row.get(0)?,
        day_key: row.get(1)?,
        active_app: row.get(2)?,
        goal: row.get(3)?,
        graph_md_path: row.get(4)?,
        node_count: node_count.max(0) as usize,
        edge_count: edge_count.max(0) as usize,
        completed: completed_int != 0,
        created_at: row.get(8)?,
    })
}

fn decode_screenday_frame(row: &Row<'_>) -> rusqlite::Result<ScreenDayFrameDto> {
    let file_bytes: i64 = row.get(10)?;
    Ok(ScreenDayFrameDto {
        id: row.get(0)?,
        day_key: row.get(1)?,
        captured_at: row.get(2)?,
        image_path: row.get(3)?,
        active_app: row.get(4)?,
        window_title: row.get(5)?,
        project_name: row.get(6)?,
        meeting_name: row.get(7)?,
        ocr_excerpt: row.get(8)?,
        dhash: row.get(9)?,
        file_bytes: file_bytes.max(0) as u64,
    })
}

fn decode_screenday_summary(row: &Row<'_>) -> rusqlite::Result<ScreenDaySummaryDto> {
    let frame_count: i64 = row.get(2)?;
    let total_bytes: i64 = row.get(3)?;
    let session_count: i64 = row.get(4)?;
    let projects_json: String = row.get(5)?;
    let meetings_json: String = row.get(6)?;
    Ok(ScreenDaySummaryDto {
        day_key: row.get(0)?,
        folder_path: row.get(1)?,
        frame_count: frame_count.max(0) as usize,
        total_bytes: total_bytes.max(0) as u64,
        session_count: session_count.max(0) as usize,
        projects: serde_json::from_str::<Vec<String>>(&projects_json).unwrap_or_default(),
        meetings: serde_json::from_str::<Vec<String>>(&meetings_json).unwrap_or_default(),
        summary_md: row.get(7)?,
        graph_md_path: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn query_session_graphs(
    conn: &Connection,
    day_key: Option<&str>,
    app_exe: Option<&str>,
    limit: i64,
) -> Result<Vec<SessionGraphSummaryDto>, String> {
    match (day_key, app_exe) {
        (Some(day), _) => {
            let mut stmt = conn
                .prepare(
                    "SELECT session_id, day_key, active_app, goal, graph_md_path,
                            node_count, edge_count, completed, created_at
                     FROM session_graphs
                     WHERE day_key = ?1
                     ORDER BY created_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| format!("Failed to prepare session_graphs query: {}", e))?;
            let rows = stmt
                .query_map(params![day, limit], decode_session_graph)
                .map_err(|e| format!("Failed to query session_graphs: {}", e))?;
            collect_rows(rows, "session_graphs")
        }
        (None, Some(app)) => {
            let mut stmt = conn
                .prepare(
                    "SELECT session_id, day_key, active_app, goal, graph_md_path,
                            node_count, edge_count, completed, created_at
                     FROM session_graphs
                     WHERE LOWER(active_app) = LOWER(?1)
                     ORDER BY created_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| format!("Failed to prepare session_graphs query: {}", e))?;
            let rows = stmt
                .query_map(params![app, limit], decode_session_graph)
                .map_err(|e| format!("Failed to query session_graphs: {}", e))?;
            collect_rows(rows, "session_graphs")
        }
        (None, None) => {
            let mut stmt = conn
                .prepare(
                    "SELECT session_id, day_key, active_app, goal, graph_md_path,
                            node_count, edge_count, completed, created_at
                     FROM session_graphs
                     ORDER BY created_at DESC
                     LIMIT ?1",
                )
                .map_err(|e| format!("Failed to prepare session_graphs query: {}", e))?;
            let rows = stmt
                .query_map(params![limit], decode_session_graph)
                .map_err(|e| format!("Failed to query session_graphs: {}", e))?;
            collect_rows(rows, "session_graphs")
        }
    }
}

fn query_kg_filtered(
    conn: &Connection,
    app_filter: Option<&str>,
    limit: usize,
) -> Result<KnowledgeGraphDto, String> {
    let safe_limit = limit.clamp(1, 2000) as i64;
    let (nodes, edges, sessions) = match app_filter {
        Some(app) => {
            let mut node_stmt = conn
                .prepare(
                    "SELECT id, node_type, app_exe, label, metadata_json, hit_count, updated_at
                     FROM kg_nodes
                     WHERE LOWER(app_exe) = LOWER(?1)
                     ORDER BY hit_count DESC, updated_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| format!("Failed to prepare kg_nodes query: {}", e))?;
            let node_rows = node_stmt
                .query_map(params![app, safe_limit], decode_kg_node)
                .map_err(|e| format!("Failed to query kg_nodes: {}", e))?;
            let nodes = collect_rows(node_rows, "kg_nodes")?;

            let mut edge_stmt = conn
                .prepare(
                    "SELECT DISTINCT e.id, e.from_node, e.to_node, e.relation, e.intent,
                            e.control_name, e.control_type, e.shortcut, e.norm_bbox_json,
                            e.success_count, e.updated_at
                     FROM kg_edges e
                     LEFT JOIN kg_nodes nf ON nf.id = e.from_node
                     LEFT JOIN kg_nodes nt ON nt.id = e.to_node
                     WHERE LOWER(nf.app_exe) = LOWER(?1) OR LOWER(nt.app_exe) = LOWER(?1)
                     ORDER BY e.success_count DESC, e.updated_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| format!("Failed to prepare kg_edges query: {}", e))?;
            let edge_rows = edge_stmt
                .query_map(params![app, safe_limit], decode_kg_edge)
                .map_err(|e| format!("Failed to query kg_edges: {}", e))?;
            let edges = collect_rows(edge_rows, "kg_edges")?;

            let sessions = query_session_graphs(conn, None, Some(app), safe_limit)?;
            (nodes, edges, sessions)
        }
        None => {
            let mut node_stmt = conn
                .prepare(
                    "SELECT id, node_type, app_exe, label, metadata_json, hit_count, updated_at
                     FROM kg_nodes
                     ORDER BY hit_count DESC, updated_at DESC
                     LIMIT ?1",
                )
                .map_err(|e| format!("Failed to prepare kg_nodes query: {}", e))?;
            let node_rows = node_stmt
                .query_map(params![safe_limit], decode_kg_node)
                .map_err(|e| format!("Failed to query kg_nodes: {}", e))?;
            let nodes = collect_rows(node_rows, "kg_nodes")?;

            let mut edge_stmt = conn
                .prepare(
                    "SELECT id, from_node, to_node, relation, intent,
                            control_name, control_type, shortcut, norm_bbox_json,
                            success_count, updated_at
                     FROM kg_edges
                     ORDER BY success_count DESC, updated_at DESC
                     LIMIT ?1",
                )
                .map_err(|e| format!("Failed to prepare kg_edges query: {}", e))?;
            let edge_rows = edge_stmt
                .query_map(params![safe_limit], decode_kg_edge)
                .map_err(|e| format!("Failed to query kg_edges: {}", e))?;
            let edges = collect_rows(edge_rows, "kg_edges")?;

            let sessions = query_session_graphs(conn, None, None, safe_limit)?;
            (nodes, edges, sessions)
        }
    };

    Ok(KnowledgeGraphDto {
        nodes,
        edges,
        sessions,
        master_md_path: None,
    })
}

fn group_frames_by_project(frames: &[ScreenDayFrameDto]) -> Vec<ScreenDayProjectGroup> {
    let mut grouped: BTreeMap<String, (usize, BTreeSet<String>)> = BTreeMap::new();
    for frame in frames {
        let Some(name) = frame
            .project_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let entry = grouped
            .entry(name.to_string())
            .or_insert_with(|| (0, BTreeSet::new()));
        entry.0 += 1;
        if !frame.active_app.trim().is_empty() {
            entry.1.insert(frame.active_app.clone());
        }
    }
    let mut out: Vec<ScreenDayProjectGroup> = grouped
        .into_iter()
        .map(|(name, (frame_count, apps))| ScreenDayProjectGroup {
            name,
            frame_count,
            apps: apps.into_iter().collect(),
        })
        .collect();
    out.sort_by(|a, b| b.frame_count.cmp(&a.frame_count).then_with(|| a.name.cmp(&b.name)));
    out
}

fn group_frames_by_meeting(frames: &[ScreenDayFrameDto]) -> Vec<ScreenDayMeetingGroup> {
    struct Accum {
        started_at: i64,
        ended_at: i64,
        frame_count: usize,
        topics: Vec<String>,
    }

    let mut grouped: BTreeMap<String, Accum> = BTreeMap::new();
    for frame in frames {
        let Some(name) = frame
            .meeting_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let entry = grouped.entry(name.to_string()).or_insert_with(|| Accum {
            started_at: frame.captured_at,
            ended_at: frame.captured_at,
            frame_count: 0,
            topics: Vec::new(),
        });
        entry.started_at = entry.started_at.min(frame.captured_at);
        entry.ended_at = entry.ended_at.max(frame.captured_at);
        entry.frame_count += 1;

        let topic = frame
            .window_title
            .trim()
            .to_string();
        if !topic.is_empty() && entry.topics.len() < 10 && !entry.topics.contains(&topic) {
            entry.topics.push(topic);
        }
    }

    let mut out: Vec<ScreenDayMeetingGroup> = grouped
        .into_iter()
        .map(|(name, acc)| ScreenDayMeetingGroup {
            name,
            started_at: acc.started_at,
            ended_at: acc.ended_at,
            frame_count: acc.frame_count,
            screen_topics: acc.topics,
        })
        .collect();
    out.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.name.cmp(&b.name)));
    out
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

    #[test]
    fn test_v1_to_v2_migration_and_backup() {
        let tmp = tempdir().expect("tempdir");
        let db_path = tmp.path().join("v1_guidelens.db");

        {
            let raw = Connection::open(&db_path).expect("create raw v1 db");
            raw.execute_batch(
                r#"
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    active_app TEXT NOT NULL,
                    user_query TEXT NOT NULL,
                    brain_used TEXT NOT NULL CHECK (
                        brain_used IN ('agent_mcp', 'agent_cli', 'local_vlm', 'byo_api', 'groq_pro')
                    ),
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE steps (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    step_number INTEGER NOT NULL,
                    instruction_line TEXT NOT NULL,
                    bbox_json TEXT,
                    terminal_command TEXT,
                    screenshot_path TEXT,
                    completed INTEGER DEFAULT 0
                );
                CREATE TABLE app_preferences (
                    app_executable TEXT PRIMARY KEY,
                    always_magnify INTEGER DEFAULT 0,
                    preferred_brain TEXT DEFAULT 'auto'
                );
                CREATE TABLE kv_settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                );
                INSERT INTO sessions (id, active_app, user_query, brain_used, created_at)
                VALUES ('legacy-1', 'Code.exe', 'Format file', 'local_vlm', 1700000001);
                INSERT INTO kv_settings (key, value_json)
                VALUES ('global_settings', '{"brain_mode":"groq_pro","onboarding_complete":true}');
                "#,
            )
            .expect("seed v1 schema");
            raw.pragma_update(None, "user_version", 1).expect("set v1");
        }

        let db = DbState::open(&db_path).expect("migrate v1 -> v2");
        let backup_path = db_path.with_extension("db.bak.v1");
        assert!(
            backup_path.exists(),
            "Expected v1 backup file {:?} to exist",
            backup_path
        );

        let version: i32 = db
            .conn
            .lock()
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .expect("user_version");
        assert_eq!(version, 2);

        let history = db.history_list(10).expect("history preserved");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, "legacy-1");

        let settings = db.get_settings().expect("legacy settings readable");
        assert_eq!(settings.brain_mode, "groq_pro");
        assert_eq!(settings.companion_id, "pixel_cat");
        assert_eq!(settings.screenday_interval_sec, 15);

        let conn = db.conn.lock().unwrap();
        for table in [
            "kg_nodes",
            "kg_edges",
            "session_graphs",
            "screenday_frames",
            "screenday_days",
        ] {
            let exists: Option<String> = conn
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |r| r.get(0),
                )
                .optional()
                .expect("query sqlite_master");
            assert_eq!(exists.as_deref(), Some(table));
        }
    }

    #[test]
    fn test_knowledge_graph_and_session_graphs_crud() {
        let tmp = tempdir().expect("tempdir");
        let db = DbState::open(&tmp.path().join("kg.db")).expect("open");

        let app_node = KgNodeDto {
            id: "app:code.exe".to_string(),
            node_type: "app".to_string(),
            app_exe: "Code.exe".to_string(),
            label: "Visual Studio Code".to_string(),
            metadata_json: Some(r#"{"family":"ide"}"#.to_string()),
            hit_count: 1,
            updated_at: 100,
        };
        let ctrl_node = KgNodeDto {
            id: "ctrl:code.exe:terminal".to_string(),
            node_type: "control".to_string(),
            app_exe: "Code.exe".to_string(),
            label: "New Terminal".to_string(),
            metadata_json: None,
            hit_count: 1,
            updated_at: 101,
        };
        let other_node = KgNodeDto {
            id: "app:chrome.exe".to_string(),
            node_type: "app".to_string(),
            app_exe: "chrome.exe".to_string(),
            label: "Chrome".to_string(),
            metadata_json: None,
            hit_count: 1,
            updated_at: 102,
        };

        db.upsert_kg_node(&app_node).expect("insert app_node");
        db.upsert_kg_node(&KgNodeDto {
            updated_at: 105,
            ..app_node.clone()
        })
        .expect("increment app_node");
        db.upsert_kg_node(&ctrl_node).expect("insert ctrl_node");
        db.upsert_kg_node(&other_node).expect("insert other_node");

        let edge = KgEdgeDto {
            id: "edge:open-term".to_string(),
            from_node: app_node.id.clone(),
            to_node: ctrl_node.id.clone(),
            relation: "triggers".to_string(),
            intent: "open terminal".to_string(),
            control_name: Some("New Terminal".to_string()),
            control_type: Some("MenuItem".to_string()),
            shortcut: Some("Ctrl+Shift+`".to_string()),
            norm_bbox: Some([120.0, 40.0, 80.0, 24.0]),
            success_count: 1,
            updated_at: 106,
        };
        db.upsert_kg_edge(&edge).expect("insert edge");
        db.upsert_kg_edge(&KgEdgeDto {
            updated_at: 110,
            ..edge.clone()
        })
        .expect("increment edge");

        db.insert_session_graph(&SessionGraphSummaryDto {
            session_id: "sg-1".to_string(),
            day_key: "2026-11-25".to_string(),
            active_app: "Code.exe".to_string(),
            goal: "Open integrated terminal".to_string(),
            graph_md_path: "C:\\tmp\\sg-1.md".to_string(),
            node_count: 2,
            edge_count: 1,
            completed: true,
            created_at: 120,
        })
        .expect("insert session graph");

        let code_kg = db.query_kg_for_app("code.exe", 10).expect("query app kg");
        assert_eq!(code_kg.nodes.len(), 2);
        assert_eq!(code_kg.nodes[0].hit_count, 2);
        assert_eq!(code_kg.edges.len(), 1);
        assert_eq!(code_kg.edges[0].success_count, 2);
        assert_eq!(code_kg.edges[0].norm_bbox, Some([120.0, 40.0, 80.0, 24.0]));
        assert_eq!(code_kg.sessions.len(), 1);

        let full_kg = db.get_knowledge_graph(None).expect("full kg");
        assert_eq!(full_kg.nodes.len(), 3);
        assert_eq!(full_kg.edges.len(), 1);

        let day_sessions = db
            .list_session_graphs(Some("2026-11-25"), 10)
            .expect("list session graphs");
        assert_eq!(day_sessions.len(), 1);
        assert!(day_sessions[0].completed);

        db.delete_kg_node(&ctrl_node.id).expect("delete ctrl node");
        let after_del = db.query_kg_for_app("code.exe", 10).expect("after delete");
        assert_eq!(after_del.nodes.len(), 1);
        assert!(after_del.edges.is_empty());
    }

    #[test]
    fn test_screenday_frames_days_summary_and_dhash() {
        let tmp = tempdir().expect("tempdir");
        let db = DbState::open(&tmp.path().join("screenday.db")).expect("open");

        assert_eq!(db.get_latest_screenday_dhash(None).expect("empty dhash"), None);
        assert_eq!(
            db.get_screenday_day_detail("2026-11-25")
                .expect("missing day"),
            None
        );

        let f1 = ScreenDayFrameDto {
            id: "frame-1".to_string(),
            day_key: "2026-11-25".to_string(),
            captured_at: 1000,
            image_path: tmp.path().join("f1.webp").to_string_lossy().into_owned(),
            active_app: "Code.exe".to_string(),
            window_title: "GuideLens - types.rs".to_string(),
            project_name: Some("GuideLens".to_string()),
            meeting_name: None,
            ocr_excerpt: Some("pub struct Step".to_string()),
            dhash: "a1b2c3d4e5f60708".to_string(),
            file_bytes: 12000,
        };
        let f2 = ScreenDayFrameDto {
            id: "frame-2".to_string(),
            day_key: "2026-11-25".to_string(),
            captured_at: 1060,
            image_path: tmp.path().join("f2.webp").to_string_lossy().into_owned(),
            active_app: "Zoom.exe".to_string(),
            window_title: "Design Sync".to_string(),
            project_name: Some("GuideLens".to_string()),
            meeting_name: Some("Design Sync".to_string()),
            ocr_excerpt: Some("ScreenDay timeline".to_string()),
            dhash: "ff00aa11bb22cc33".to_string(),
            file_bytes: 15000,
        };
        db.insert_screenday_frame(&f1).expect("insert f1");
        db.insert_screenday_frame(&f2).expect("insert f2");

        assert_eq!(
            db.get_latest_screenday_dhash(Some("2026-11-25"))
                .expect("latest day dhash")
                .as_deref(),
            Some("ff00aa11bb22cc33")
        );
        assert_eq!(
            db.get_latest_screenday_dhash(None)
                .expect("latest global dhash")
                .as_deref(),
            Some("ff00aa11bb22cc33")
        );

        db.update_screenday_day_summary(
            "2026-11-25",
            "# Day Diary\nWorked on GuideLens.",
            None,
            1070,
        )
        .expect("update summary");

        db.upsert_screenday_day_meta(&ScreenDaySummaryDto {
            day_key: "2026-11-25".to_string(),
            folder_path: tmp.path().to_string_lossy().into_owned(),
            frame_count: 2,
            total_bytes: 27000,
            session_count: 1,
            projects: vec!["GuideLens".to_string()],
            meetings: vec!["Design Sync".to_string()],
            summary_md: None,
            graph_md_path: None,
            updated_at: 1080,
        })
        .expect("upsert day meta preserves existing summary");

        let days = db.list_screenday_days(10).expect("list days");
        assert_eq!(days.len(), 1);
        assert_eq!(days[0].frame_count, 2);
        assert_eq!(days[0].total_bytes, 27000);
        assert_eq!(
            days[0].summary_md.as_deref(),
            Some("# Day Diary\nWorked on GuideLens.")
        );

        let detail = db
            .get_screenday_day_detail("2026-11-25")
            .expect("detail query")
            .expect("detail present");
        assert_eq!(detail.frames.len(), 2);
        assert_eq!(detail.project_groups.len(), 1);
        assert_eq!(detail.project_groups[0].name, "GuideLens");
        assert_eq!(detail.project_groups[0].apps, vec!["Code.exe", "Zoom.exe"]);
        assert_eq!(detail.meeting_groups.len(), 1);
        assert_eq!(detail.meeting_groups[0].name, "Design Sync");
        assert_eq!(detail.meeting_groups[0].started_at, 1060);
        assert_eq!(
            detail.day_diary_md.as_deref(),
            Some("# Day Diary\nWorked on GuideLens.")
        );
    }
}
