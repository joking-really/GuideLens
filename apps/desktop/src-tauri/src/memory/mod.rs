//! Self-improving Knowledge Graph memory, per-session `.graph.md` persistence,
//! and Tauri IPC commands for inspecting and pruning learned UI workflows.

pub mod graph_md;
pub mod retriever;

pub use graph_md::{
    days_root_dir, memory_root_dir, today_day_key, write_master_knowledge_graph_md,
    write_session_graph_md,
};
pub use retriever::retrieve_memory_hints;

use crate::db::{unix_now, DbState};
use crate::types::{
    KgEdgeDto, KgNodeDto, KnowledgeGraphDto, LiveSessionTurn, ResolvedStep,
    SessionGraphSummaryDto,
};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

fn pretty_app_name(app_exe: &str) -> String {
    let trimmed = app_exe.trim();
    if trimmed.is_empty() {
        return "Unknown App".to_string();
    }
    if trimmed.to_ascii_lowercase().ends_with(".exe") && trimmed.len() > 4 {
        trimmed[..trimmed.len() - 4].to_string()
    } else {
        trimmed.to_string()
    }
}

struct PersistableStep {
    instruction: String,
    control_name: String,
    control_type: Option<String>,
    shortcut: Option<String>,
    norm_bbox: Option<[f64; 4]>,
    window_title: Option<String>,
}

fn collect_persistable_steps(
    steps: &[ResolvedStep],
    turns: &[LiveSessionTurn],
) -> Vec<PersistableStep> {
    if !steps.is_empty() && steps.len() >= turns.len() {
        return steps
            .iter()
            .enumerate()
            .map(|(idx, step)| {
                let turn_ref = turns.get(idx).or_else(|| turns.last());
                let control_name = step
                    .target_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        step.shortcut
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| format!("Shortcut {}", s))
                    })
                    .or_else(|| {
                        step.terminal_command
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|c| format!("Command {}", c))
                    })
                    .unwrap_or_else(|| {
                        let clipped: String = step.instruction_line.chars().take(48).collect();
                        clipped
                    });

                PersistableStep {
                    instruction: step.instruction_line.clone(),
                    control_name,
                    control_type: step.control_type.clone(),
                    shortcut: step.shortcut.clone(),
                    norm_bbox: step.bbox,
                    window_title: turn_ref
                        .map(|t| t.window_title.trim().to_string())
                        .filter(|w| !w.is_empty()),
                }
            })
            .collect();
    }

    turns
        .iter()
        .enumerate()
        .map(|(idx, turn)| {
            let step_ref = steps.get(idx);
            let control_name = turn
                .target_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    step_ref
                        .and_then(|s| s.target_name.as_deref())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| turn.instruction_line.chars().take(48).collect());
            PersistableStep {
                instruction: turn.instruction_line.clone(),
                control_name,
                control_type: step_ref
                    .and_then(|s| s.control_type.clone())
                    .or_else(|| turn.action_kind.clone()),
                shortcut: step_ref.and_then(|s| s.shortcut.clone()),
                norm_bbox: step_ref.and_then(|s| s.bbox),
                window_title: if turn.window_title.trim().is_empty() {
                    None
                } else {
                    Some(turn.window_title.trim().to_string())
                },
            }
        })
        .collect()
}

/// Records a completed or ongoing guidance session into the SQLite Knowledge Graph,
/// writes its per-session `.graph.md`, refreshes `knowledge-graph.md` and today's
/// `day-graph.md`, and returns the `SessionGraphSummaryDto`.
pub fn record_session_and_write_graph(
    db: &DbState,
    session_id: &str,
    active_app: &str,
    goal: &str,
    steps: &[ResolvedStep],
    turns: &[LiveSessionTurn],
    completed: bool,
) -> Result<SessionGraphSummaryDto, String> {
    let days_dir = graph_md::days_root_dir();
    let mem_dir = graph_md::memory_root_dir();
    let summary = record_session_and_write_graph_in(
        db,
        &days_dir,
        &mem_dir,
        session_id,
        active_app,
        goal,
        steps,
        turns,
        completed,
    )?;

    // Keep today's Screen Day graph & diary synchronized with new live sessions.
    let _ = crate::screenday::packager::refresh_day_package_from_db(
        db,
        &summary.day_key,
        None,
    );

    Ok(summary)
}

/// Testable variant of `record_session_and_write_graph` writing markdown files inside explicit directories.
#[allow(clippy::too_many_arguments)]
pub fn record_session_and_write_graph_in(
    db: &DbState,
    days_dir: &Path,
    memory_dir: &Path,
    session_id: &str,
    active_app: &str,
    goal: &str,
    steps: &[ResolvedStep],
    turns: &[LiveSessionTurn],
    completed: bool,
) -> Result<SessionGraphSummaryDto, String> {
    let now = unix_now();
    let day_key = graph_md::today_day_key();
    let app_clean = if active_app.trim().is_empty() {
        "Unknown"
    } else {
        active_app.trim()
    };
    let goal_clean = if goal.trim().is_empty() {
        "Guided workflow"
    } else {
        goal.trim()
    };

    let app_slug = graph_md::app_slug(app_clean);
    let app_node_id = format!("app:{}", app_slug);

    db.upsert_kg_node(&KgNodeDto {
        id: app_node_id.clone(),
        node_type: "app".to_string(),
        app_exe: app_clean.to_string(),
        label: pretty_app_name(app_clean),
        metadata_json: None,
        hit_count: 1,
        updated_at: now,
    })?;

    let persistable = collect_persistable_steps(steps, turns);
    let screen_title = persistable
        .iter()
        .rev()
        .find_map(|s| s.window_title.as_deref())
        .or_else(|| {
            turns
                .iter()
                .rev()
                .map(|t| t.window_title.trim())
                .find(|w| !w.is_empty())
        });

    let screen_node_id = if let Some(title) = screen_title {
        let sid = format!(
            "screen:{}:{}",
            app_slug,
            graph_md::fnv1a_64_hex(&title.to_ascii_lowercase())
        );
        db.upsert_kg_node(&KgNodeDto {
            id: sid.clone(),
            node_type: "screen".to_string(),
            app_exe: app_clean.to_string(),
            label: title.chars().take(120).collect(),
            metadata_json: None,
            hit_count: 1,
            updated_at: now,
        })?;
        Some(sid)
    } else {
        None
    };

    let goal_node_id = format!(
        "goal:{}:{}",
        app_slug,
        graph_md::fnv1a_64_hex(&goal_clean.to_ascii_lowercase())
    );
    db.upsert_kg_node(&KgNodeDto {
        id: goal_node_id.clone(),
        node_type: "goal".to_string(),
        app_exe: app_clean.to_string(),
        label: goal_clean.chars().take(140).collect(),
        metadata_json: None,
        hit_count: 1,
        updated_at: now,
    })?;

    let goal_parent = screen_node_id.as_deref().unwrap_or(&app_node_id);
    db.upsert_kg_edge(&KgEdgeDto {
        id: format!(
            "edge:goal:{}:{}",
            app_slug,
            graph_md::fnv1a_64_hex(&format!("{}->{}", goal_parent, goal_node_id))
        ),
        from_node: goal_parent.to_string(),
        to_node: goal_node_id.clone(),
        relation: "targets_goal".to_string(),
        intent: goal_clean.to_string(),
        control_name: None,
        control_type: None,
        shortcut: None,
        norm_bbox: None,
        success_count: 1,
        updated_at: now,
    })?;

    for item in &persistable {
        let ctrl_key = format!(
            "{}::{}",
            item.control_name.to_ascii_lowercase(),
            item.control_type
                .as_deref()
                .unwrap_or("")
                .to_ascii_lowercase()
        );
        let ctrl_node_id = format!("ctrl:{}:{}", app_slug, graph_md::fnv1a_64_hex(&ctrl_key));
        db.upsert_kg_node(&KgNodeDto {
            id: ctrl_node_id.clone(),
            node_type: "control".to_string(),
            app_exe: app_clean.to_string(),
            label: item.control_name.clone(),
            metadata_json: None,
            hit_count: 1,
            updated_at: now,
        })?;

        let combined_intent = if item
            .instruction
            .to_ascii_lowercase()
            .contains(&goal_clean.to_ascii_lowercase())
        {
            item.instruction.clone()
        } else {
            let joined = format!("{} — {}", goal_clean, item.instruction);
            joined.chars().take(180).collect()
        };

        let edge_id = format!(
            "edge:step:{}:{}",
            app_slug,
            graph_md::fnv1a_64_hex(&format!(
                "{}::{}::{}",
                ctrl_node_id,
                item.instruction.to_ascii_lowercase(),
                item.shortcut.as_deref().unwrap_or("")
            ))
        );
        db.upsert_kg_edge(&KgEdgeDto {
            id: edge_id,
            from_node: goal_parent.to_string(),
            to_node: ctrl_node_id,
            relation: if completed {
                "verified_step".to_string()
            } else {
                "observed_step".to_string()
            },
            intent: combined_intent,
            control_name: Some(item.control_name.clone()),
            control_type: item.control_type.clone(),
            shortcut: item.shortcut.clone(),
            norm_bbox: item.norm_bbox,
            success_count: 1,
            updated_at: now,
        })?;
    }

    let (graph_md_path, node_count, edge_count) = graph_md::write_session_graph_md_in(
        days_dir,
        session_id,
        app_clean,
        goal_clean,
        "live",
        steps,
        turns,
        completed,
    )?;

    let summary = SessionGraphSummaryDto {
        session_id: session_id.to_string(),
        day_key,
        active_app: app_clean.to_string(),
        goal: goal_clean.to_string(),
        graph_md_path,
        node_count,
        edge_count,
        completed,
        created_at: now,
    };
    db.insert_session_graph(&summary)?;

    if let Ok(full_kg) = db.get_knowledge_graph(None) {
        let _ = graph_md::write_master_knowledge_graph_md_in(memory_dir, &full_kg);
    }

    Ok(summary)
}

/// Safely reads a `.md` file ONLY if its canonicalized path lies inside one of `allowed_roots`.
pub fn read_graph_markdown_in(allowed_roots: &[PathBuf], raw_path: &str) -> Result<String, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("Invalid markdown path".to_string());
    }

    let req_path = Path::new(trimmed);
    let ext = req_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "md" {
        return Err("Only .md files can be read via read_graph_markdown".to_string());
    }

    let canon_target = fs::canonicalize(req_path)
        .map_err(|e| format!("Markdown file not found or inaccessible: {}", e))?;

    if !canon_target.is_file() {
        return Err("Requested path is not a regular file".to_string());
    }

    let mut allowed = false;
    for root in allowed_roots {
        if let Ok(canon_root) = fs::canonicalize(root) {
            if canon_target.starts_with(&canon_root) {
                allowed = true;
                break;
            }
        }
    }

    if !allowed {
        return Err(
            "Access denied: path is outside GuideLens days/ and memory/ directories".to_string(),
        );
    }

    fs::read_to_string(&canon_target)
        .map_err(|e| format!("Failed to read markdown file: {}", e))
}

/// Returns the Knowledge Graph DTO (nodes, edges, session graphs, and `knowledge-graph.md` path).
#[tauri::command]
pub fn get_knowledge_graph(
    db: State<'_, DbState>,
    app_filter: Option<String>,
) -> Result<KnowledgeGraphDto, String> {
    let mut kg = db.get_knowledge_graph(app_filter.as_deref())?;
    let mem_dir = graph_md::memory_root_dir();
    let master_path = mem_dir.join("knowledge-graph.md");

    if app_filter.is_none() || !master_path.exists() {
        let full_kg = if app_filter.is_none() {
            kg.clone()
        } else {
            db.get_knowledge_graph(None).unwrap_or_else(|_| kg.clone())
        };
        if let Ok(written) = graph_md::write_master_knowledge_graph_md_in(&mem_dir, &full_kg) {
            kg.master_md_path = Some(written);
            return Ok(kg);
        }
    }

    if master_path.exists() {
        kg.master_md_path = Some(master_path.to_string_lossy().into_owned());
    }
    Ok(kg)
}

/// Lists recorded session graphs, optionally filtered by `day_key` (`YYYY-MM-DD`).
#[tauri::command]
pub fn list_session_graphs(
    db: State<'_, DbState>,
    day_key: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<SessionGraphSummaryDto>, String> {
    db.list_session_graphs(day_key.as_deref(), limit.unwrap_or(50))
}

/// Reads a `.graph.md`, `day-graph.md`, `day-diary.md`, or `knowledge-graph.md` file safely
/// after canonicalizing and verifying it resides under `%LOCALAPPDATA%\GuideLens\days` or `memory`.
#[tauri::command]
pub fn read_graph_markdown(path: String) -> Result<String, String> {
    let allowed = vec![graph_md::days_root_dir(), graph_md::memory_root_dir()];
    read_graph_markdown_in(&allowed, &path)
}

/// Deletes a Knowledge Graph node (and referencing edges) and refreshes `knowledge-graph.md`.
#[tauri::command]
pub fn delete_memory_node(db: State<'_, DbState>, node_id: String) -> Result<(), String> {
    db.delete_kg_node(&node_id)?;
    if let Ok(full_kg) = db.get_knowledge_graph(None) {
        let _ = graph_md::write_master_knowledge_graph_md(&full_kg);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{RectPx, StepSource};
    use tempfile::tempdir;

    #[test]
    fn test_read_graph_markdown_blocks_traversal_and_allows_valid_paths() {
        let tmp = tempdir().expect("tempdir");
        let days_dir = tmp.path().join("days");
        let memory_dir = tmp.path().join("memory");
        let sibling_evil = tmp.path().join("days_evil");
        let outside_secret = tmp.path().join("secret.md");
        let db_like = tmp.path().join("days").join("not_markdown.db");

        fs::create_dir_all(days_dir.join("2026-11-25").join("sessions")).unwrap();
        fs::create_dir_all(&memory_dir).unwrap();
        fs::create_dir_all(&sibling_evil).unwrap();

        let valid_session = days_dir
            .join("2026-11-25")
            .join("sessions")
            .join("120000-code-test.graph.md");
        let valid_kg = memory_dir.join("knowledge-graph.md");
        let evil_md = sibling_evil.join("pwn.md");

        fs::write(&valid_session, "# Session Graph").unwrap();
        fs::write(&valid_kg, "# Master KG").unwrap();
        fs::write(&evil_md, "# Evil").unwrap();
        fs::write(&outside_secret, "# Secret").unwrap();
        fs::write(&db_like, "SQLite").unwrap();

        let allowed = vec![days_dir.clone(), memory_dir.clone()];

        assert_eq!(
            read_graph_markdown_in(&allowed, &valid_session.to_string_lossy()).unwrap(),
            "# Session Graph"
        );
        assert_eq!(
            read_graph_markdown_in(&allowed, &valid_kg.to_string_lossy()).unwrap(),
            "# Master KG"
        );

        // Traversal via .. into outside secret must fail
        let traversal = days_dir.join("2026-11-25").join("..").join("..").join("secret.md");
        assert!(read_graph_markdown_in(&allowed, &traversal.to_string_lossy()).is_err());

        // Traversal into sibling prefix `days_evil` must fail
        let evil_traversal = days_dir.join("..").join("days_evil").join("pwn.md");
        assert!(read_graph_markdown_in(&allowed, &evil_traversal.to_string_lossy()).is_err());
        assert!(read_graph_markdown_in(&allowed, &evil_md.to_string_lossy()).is_err());

        // Non-markdown inside allowed root must fail
        assert!(read_graph_markdown_in(&allowed, &db_like.to_string_lossy()).is_err());

        // Empty or NUL byte must fail
        assert!(read_graph_markdown_in(&allowed, "").is_err());
        assert!(read_graph_markdown_in(&allowed, "foo.md\0bar").is_err());
    }

    #[test]
    fn test_record_session_and_write_graph_self_improves_hints() {
        let tmp = tempdir().expect("tempdir");
        let db = DbState::open(&tmp.path().join("mem.db")).expect("open db");
        let days_dir = tmp.path().join("days");
        let mem_dir = tmp.path().join("memory");

        let steps = vec![ResolvedStep {
            step_number: 1,
            instruction_line: "Click Terminal -> New Terminal".to_string(),
            target_name: Some("New Terminal".to_string()),
            control_type: Some("MenuItem".to_string()),
            bbox: Some([110.0, 24.0, 90.0, 22.0]),
            confidence: 0.95,
            shortcut: Some("Ctrl+Shift+`".to_string()),
            terminal_command: None,
            explanation: None,
            spoken_text: None,
            target_id: Some(7),
            action_kind: Some("click".to_string()),
            companion_emotion: Some("pointing".to_string()),
            goal_complete: true,
            rect_px: Some(RectPx {
                x: 211,
                y: 26,
                w: 173,
                h: 24,
            }),
            source: StepSource::Som,
        }];
        let turns = vec![LiveSessionTurn {
            turn_number: 1,
            user_text: Some("Open integrated terminal".to_string()),
            instruction_line: "Click Terminal -> New Terminal".to_string(),
            spoken_text: None,
            action_kind: Some("click".to_string()),
            companion_emotion: Some("pointing".to_string()),
            target_name: Some("New Terminal".to_string()),
            rect_px: None,
            active_app: "Code.exe".to_string(),
            window_title: "lib.rs - GuideLens - Visual Studio Code".to_string(),
            latency: None,
            timestamp: 1_764_000_000,
        }];

        // Record twice to verify success_count increments on repeat workflows
        let s1 = record_session_and_write_graph_in(
            &db,
            &days_dir,
            &mem_dir,
            "sess-1",
            "Code.exe",
            "Open integrated terminal",
            &steps,
            &turns,
            true,
        )
        .expect("record sess-1");
        assert!(Path::new(&s1.graph_md_path).exists());

        let _s2 = record_session_and_write_graph_in(
            &db,
            &days_dir,
            &mem_dir,
            "sess-2",
            "Code.exe",
            "Open integrated terminal",
            &steps,
            &turns,
            true,
        )
        .expect("record sess-2");

        let kg = db.query_kg_for_app("Code.exe", 20).expect("query kg");
        assert!(kg.edges.iter().any(|e| e.success_count >= 2));

        let hints = retrieve_memory_hints(
            &db,
            "Code.exe",
            "GuideLens - Visual Studio Code",
            "open terminal",
        );
        assert!(hints.contains("New Terminal"));
        assert!(hints.contains("Ctrl+Shift+`"));
        assert!(hints.contains("Verified 2x"));
        assert!(mem_dir.join("knowledge-graph.md").exists());
    }
}
