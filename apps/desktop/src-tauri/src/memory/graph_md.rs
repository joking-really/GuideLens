//! Markdown & Mermaid `.graph.md` serialization, local date/time helpers, and GuideLens folder paths.

use crate::types::{KnowledgeGraphDto, LiveSessionTurn, ResolvedStep};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Local calendar date & clock components without requiring extra crate dependencies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalDateTime {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct WinSystemTime {
    w_year: u16,
    w_month: u16,
    w_day_of_week: u16,
    w_day: u16,
    w_hour: u16,
    w_minute: u16,
    w_second: u16,
    w_milliseconds: u16,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetLocalTime(lp_system_time: *mut WinSystemTime);
    fn GetSystemTime(lp_system_time: *mut WinSystemTime);
}

#[cfg(windows)]
fn win_system_time_to_local_dt(st: WinSystemTime) -> LocalDateTime {
    LocalDateTime {
        year: st.w_year as i32,
        month: (st.w_month as u32).clamp(1, 12),
        day: (st.w_day as u32).clamp(1, 31),
        hour: (st.w_hour as u32).min(23),
        minute: (st.w_minute as u32).min(59),
        second: (st.w_second as u32).min(59),
    }
}

/// Converts a Gregorian civil date `(year, month, day)` to days since `1970-01-01`
/// using Howard Hinnant's civil calendar algorithm.
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Converts days since `1970-01-01` to Gregorian civil `(year, month, day)`.
pub fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year as i32, m as u32, d as u32)
}

/// Converts a timestamp in seconds since Unix epoch to calendar & clock components.
pub fn unix_to_civil_components(unix_secs: i64) -> LocalDateTime {
    let days = unix_secs.div_euclid(86_400);
    let secs_of_day = unix_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = (secs_of_day / 3600) as u32;
    let minute = ((secs_of_day % 3600) / 60) as u32;
    let second = (secs_of_day % 60) as u32;
    LocalDateTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn civil_dt_to_unix_secs(dt: LocalDateTime) -> i64 {
    let days = days_from_civil(dt.year as i64, dt.month, dt.day);
    days * 86_400 + dt.hour as i64 * 3600 + dt.minute as i64 * 60 + dt.second as i64
}

/// Returns the current local timezone offset in seconds east of UTC.
#[cfg(windows)]
pub fn local_utc_offset_secs() -> i64 {
    let mut local_st = WinSystemTime::default();
    let mut utc_st = WinSystemTime::default();
    unsafe {
        GetLocalTime(&mut local_st);
        GetSystemTime(&mut utc_st);
    }
    let local_s = civil_dt_to_unix_secs(win_system_time_to_local_dt(local_st));
    let utc_s = civil_dt_to_unix_secs(win_system_time_to_local_dt(utc_st));
    local_s - utc_s
}

/// Returns the current local timezone offset in seconds east of UTC.
#[cfg(not(windows))]
pub fn local_utc_offset_secs() -> i64 {
    0
}

/// Returns the current local date and clock components using Win32 `GetLocalTime` on Windows.
#[cfg(windows)]
pub fn local_now_components() -> LocalDateTime {
    let mut st = WinSystemTime::default();
    unsafe {
        GetLocalTime(&mut st);
    }
    win_system_time_to_local_dt(st)
}

/// Returns the current local date and clock components using civil calendar math on non-Windows.
#[cfg(not(windows))]
pub fn local_now_components() -> LocalDateTime {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    unix_to_civil_components(now_secs)
}

/// Converts a Unix timestamp (seconds) into approximate local date/time components.
pub fn unix_to_local_components(unix_secs: i64) -> LocalDateTime {
    let offset = local_utc_offset_secs();
    unix_to_civil_components(unix_secs.saturating_add(offset))
}

/// Returns today's local date key formatted as `YYYY-MM-DD`.
pub fn today_day_key() -> String {
    let dt = local_now_components();
    format!("{:04}-{:02}-{:02}", dt.year, dt.month, dt.day)
}

/// Formats a Unix timestamp (seconds) as local `YYYY-MM-DD`.
pub fn format_day_key_from_unix(unix_secs: i64) -> String {
    let dt = unix_to_local_components(unix_secs);
    format!("{:04}-{:02}-{:02}", dt.year, dt.month, dt.day)
}

/// Formats a Unix timestamp (seconds) as local `HH:MM:SS`.
pub fn format_hhmmss_from_unix(unix_secs: i64) -> String {
    let dt = unix_to_local_components(unix_secs);
    format!("{:02}:{:02}:{:02}", dt.hour, dt.minute, dt.second)
}

/// Formats a Unix timestamp (seconds) as local `HH:MM`.
pub fn format_hhmm_from_unix(unix_secs: i64) -> String {
    let dt = unix_to_local_components(unix_secs);
    format!("{:02}:{:02}", dt.hour, dt.minute)
}

/// Validates that `day_key` strictly matches `YYYY-MM-DD` (preventing path traversal).
pub fn validate_day_key(day_key: &str) -> Result<String, String> {
    let trimmed = day_key.trim();
    let bytes = trimmed.as_bytes();
    let ok = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !ok {
        return Err(format!("Invalid day key '{}': expected YYYY-MM-DD", day_key));
    }
    Ok(trimmed.to_string())
}

/// Returns `%LOCALAPPDATA%\GuideLens`, creating it if needed.
pub fn guidelens_root_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base.join("GuideLens");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Returns `%LOCALAPPDATA%\GuideLens\days`, creating it if needed.
pub fn days_root_dir() -> PathBuf {
    let dir = guidelens_root_dir().join("days");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Returns `%LOCALAPPDATA%\GuideLens\memory`, creating it if needed.
pub fn memory_root_dir() -> PathBuf {
    let dir = guidelens_root_dir().join("memory");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Computes a deterministic 64-bit FNV-1a hash encoded as 16 lowercase hex digits.
pub fn fnv1a_64_hex(input: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:016x}", hash)
}

/// Converts arbitrary text into a filesystem-safe lowercase kebab slug.
pub fn sanitize_slug(input: &str, max_len: usize, fallback: &str) -> String {
    let mut out = String::with_capacity(max_len.min(64));
    let mut prev_dash = true;
    for ch in input.chars() {
        if out.len() >= max_len {
            break;
        }
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

/// Normalizes an executable name into a short app slug (stripping `.exe` if present).
pub fn app_slug(active_app: &str) -> String {
    let trimmed = active_app.trim();
    let base = if trimmed.to_ascii_lowercase().ends_with(".exe") && trimmed.len() > 4 {
        &trimmed[..trimmed.len() - 4]
    } else {
        trimmed
    };
    sanitize_slug(base, 24, "app")
}

/// Builds a Mermaid-safe identifier (`[A-Za-z][A-Za-z0-9_]*`).
pub fn sanitize_mermaid_id(prefix: &str, raw: &str) -> String {
    let mut id = String::new();
    for ch in prefix.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            id.push(ch);
        }
    }
    if id.is_empty() || !id.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
        id.insert(0, 'n');
    }
    id.push('_');
    let mut body = String::new();
    for ch in raw.chars() {
        if body.len() >= 20 {
            break;
        }
        if ch.is_ascii_alphanumeric() {
            body.push(ch.to_ascii_lowercase());
        } else if !body.ends_with('_') && !body.is_empty() {
            body.push('_');
        }
    }
    let clean_body = body.trim_matches('_');
    if !clean_body.is_empty() {
        id.push_str(clean_body);
        id.push('_');
    }
    id.push_str(&fnv1a_64_hex(raw)[..8]);
    id
}

/// Escapes text for safe inclusion inside Mermaid `["..."]` or `|"..."|` labels.
pub fn escape_mermaid_label(raw: &str, max_len: usize) -> String {
    let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut cleaned = String::with_capacity(collapsed.len().min(max_len + 4));
    for ch in collapsed.chars() {
        let mapped = match ch {
            '"' => '\'',
            '[' | '{' => '(',
            ']' | '}' => ')',
            '<' | '>' | '`' | '#' | ';' | '|' => ' ',
            _ if ch.is_control() => ' ',
            other => other,
        };
        cleaned.push(mapped);
    }
    let normalized: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_len {
        if normalized.is_empty() {
            "Item".to_string()
        } else {
            normalized
        }
    } else {
        let trunc: String = normalized.chars().take(max_len.saturating_sub(3)).collect();
        format!("{}...", trunc.trim_end())
    }
}

/// Quotes and escapes a string for safe single-line YAML frontmatter output.
pub fn escape_yaml_string(raw: &str) -> String {
    let collapsed: String = raw
        .chars()
        .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        .collect::<String>();
    let escaped = collapsed
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("\"{}\"", escaped.trim())
}

struct SessionActionItem {
    step_number: u32,
    instruction: String,
    target_name: Option<String>,
    control_type: Option<String>,
    shortcut: Option<String>,
    terminal_command: Option<String>,
    action_kind: Option<String>,
    bbox: Option<[f64; 4]>,
    rect_str: Option<String>,
    window_title: Option<String>,
}

fn collect_session_actions(
    steps: &[ResolvedStep],
    turns: &[LiveSessionTurn],
) -> Vec<SessionActionItem> {
    if !steps.is_empty() && steps.len() >= turns.len() {
        return steps
            .iter()
            .enumerate()
            .map(|(idx, step)| {
                let matching_turn = turns.get(idx).or_else(|| turns.last());
                SessionActionItem {
                    step_number: if step.step_number > 0 {
                        step.step_number
                    } else {
                        (idx + 1) as u32
                    },
                    instruction: step.instruction_line.clone(),
                    target_name: step.target_name.clone().or_else(|| {
                        matching_turn.and_then(|t| t.target_name.clone())
                    }),
                    control_type: step.control_type.clone(),
                    shortcut: step.shortcut.clone(),
                    terminal_command: step.terminal_command.clone(),
                    action_kind: step.action_kind.clone().or_else(|| {
                        matching_turn.and_then(|t| t.action_kind.clone())
                    }),
                    bbox: step.bbox,
                    rect_str: step
                        .rect_px
                        .map(|r| format!("({}, {}, {}x{})", r.x, r.y, r.w, r.h)),
                    window_title: matching_turn
                        .map(|t| t.window_title.clone())
                        .filter(|w| !w.trim().is_empty()),
                }
            })
            .collect();
    }

    turns
        .iter()
        .enumerate()
        .map(|(idx, turn)| {
            let matching_step = steps.get(idx);
            SessionActionItem {
                step_number: if turn.turn_number > 0 {
                    turn.turn_number
                } else {
                    (idx + 1) as u32
                },
                instruction: turn.instruction_line.clone(),
                target_name: turn
                    .target_name
                    .clone()
                    .or_else(|| matching_step.and_then(|s| s.target_name.clone())),
                control_type: matching_step.and_then(|s| s.control_type.clone()),
                shortcut: matching_step.and_then(|s| s.shortcut.clone()),
                terminal_command: matching_step.and_then(|s| s.terminal_command.clone()),
                action_kind: turn
                    .action_kind
                    .clone()
                    .or_else(|| matching_step.and_then(|s| s.action_kind.clone())),
                bbox: matching_step.and_then(|s| s.bbox),
                rect_str: turn
                    .rect_px
                    .or_else(|| matching_step.and_then(|s| s.rect_px))
                    .map(|r| format!("({}, {}, {}x{})", r.x, r.y, r.w, r.h)),
                window_title: if turn.window_title.trim().is_empty() {
                    None
                } else {
                    Some(turn.window_title.clone())
                },
            }
        })
        .collect()
}

/// Writes a per-session `.graph.md` file under `%LOCALAPPDATA%\GuideLens\days\<YYYY-MM-DD>\sessions\<HHMMSS>-<app>-<slug>.graph.md`.
///
/// Returns `(file_path, node_count, edge_count)`.
pub fn write_session_graph_md(
    session_id: &str,
    active_app: &str,
    goal: &str,
    brain_label: &str,
    steps: &[ResolvedStep],
    turns: &[LiveSessionTurn],
    completed: bool,
) -> Result<(String, usize, usize), String> {
    let days_dir = days_root_dir();
    write_session_graph_md_in(
        &days_dir,
        session_id,
        active_app,
        goal,
        brain_label,
        steps,
        turns,
        completed,
    )
}

/// Writes a per-session `.graph.md` inside the given `days_dir` root (unit-test friendly).
///
/// Returns `(file_path, node_count, edge_count)`.
#[allow(clippy::too_many_arguments)]
pub fn write_session_graph_md_in(
    days_dir: &Path,
    session_id: &str,
    active_app: &str,
    goal: &str,
    brain_label: &str,
    steps: &[ResolvedStep],
    turns: &[LiveSessionTurn],
    completed: bool,
) -> Result<(String, usize, usize), String> {
    let now_dt = local_now_components();
    let day_key = format!("{:04}-{:02}-{:02}", now_dt.year, now_dt.month, now_dt.day);
    let hhmmss = format!("{:02}{:02}{:02}", now_dt.hour, now_dt.minute, now_dt.second);
    let iso_ts = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        now_dt.year, now_dt.month, now_dt.day, now_dt.hour, now_dt.minute, now_dt.second
    );
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let sessions_dir = days_dir.join(&day_key).join("sessions");
    fs::create_dir_all(&sessions_dir).map_err(|e| {
        format!(
            "Failed to create session graphs directory {:?}: {}",
            sessions_dir, e
        )
    })?;

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
    let brain_clean = if brain_label.trim().is_empty() {
        "live"
    } else {
        brain_label.trim()
    };

    let app_part = app_slug(app_clean);
    let goal_part = sanitize_slug(goal_clean, 40, "session");
    let base_name = format!("{}-{}-{}.graph.md", hhmmss, app_part, goal_part);
    let mut out_path = sessions_dir.join(&base_name);

    // Avoid clobbering a different session saved within the same second.
    if out_path.exists() {
        let same_session = fs::read_to_string(&out_path)
            .map(|c| c.contains(session_id))
            .unwrap_or(false);
        if !same_session {
            let short_sid = sanitize_slug(session_id, 8, "s");
            out_path = sessions_dir.join(format!(
                "{}-{}-{}-{}.graph.md",
                hhmmss, app_part, goal_part, short_sid
            ));
        }
    }

    let actions = collect_session_actions(steps, turns);
    let screen_title = actions
        .iter()
        .rev()
        .find_map(|a| a.window_title.as_deref())
        .or_else(|| {
            turns
                .iter()
                .rev()
                .map(|t| t.window_title.trim())
                .find(|w| !w.is_empty())
        })
        .unwrap_or("Active Workspace");

    let app_id = sanitize_mermaid_id("app", app_clean);
    let screen_id = sanitize_mermaid_id("scr", &format!("{}:{}", app_clean, screen_title));
    let goal_id = sanitize_mermaid_id("goal", &format!("{}:{}", session_id, goal_clean));

    let mut mermaid_lines = vec![
        "```mermaid".to_string(),
        "flowchart LR".to_string(),
        format!(
            "    {}[\"App: {}\"]",
            app_id,
            escape_mermaid_label(app_clean, 40)
        ),
        format!(
            "    {}[\"Screen: {}\"]",
            screen_id,
            escape_mermaid_label(screen_title, 48)
        ),
        format!(
            "    {}[\"Goal: {}\"]",
            goal_id,
            escape_mermaid_label(goal_clean, 56)
        ),
        format!("    {} -->|\"focus\"| {}", app_id, screen_id),
        format!("    {} -->|\"intent\"| {}", screen_id, goal_id),
    ];

    let mut distinct_nodes: BTreeSet<String> =
        [app_id.clone(), screen_id.clone(), goal_id.clone()]
            .into_iter()
            .collect();
    let mut edge_count = 2usize;

    let mut prev_node_id = goal_id.clone();
    for (idx, action) in actions.iter().enumerate() {
        let ctrl_display = action
            .target_name
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .or_else(|| {
                action
                    .shortcut
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| format!("Shortcut {}", s))
            })
            .or_else(|| {
                action
                    .terminal_command
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .map(|c| format!("Run {}", c))
            })
            .unwrap_or_else(|| format!("Step {}", action.step_number));

        let ctrl_type_suffix = action
            .control_type
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|t| format!(" ({})", t))
            .unwrap_or_default();

        let ctrl_id = sanitize_mermaid_id(
            "ctrl",
            &format!(
                "{}:{}:{}:{}",
                idx, action.step_number, ctrl_display, session_id
            ),
        );
        let node_label = escape_mermaid_label(&format!("{}{}", ctrl_display, ctrl_type_suffix), 48);

        if distinct_nodes.insert(ctrl_id.clone()) {
            mermaid_lines.push(format!("    {}[\"{}\"]", ctrl_id, node_label));
        }

        let edge_text = match (&action.action_kind, &action.shortcut) {
            (Some(kind), Some(sc)) if !sc.trim().is_empty() => {
                format!("{}. {} [{}]", action.step_number, kind, sc)
            }
            (Some(kind), _) if !kind.trim().is_empty() => {
                format!("{}. {}", action.step_number, kind)
            }
            (_, Some(sc)) if !sc.trim().is_empty() => {
                format!("{}. [{}]", action.step_number, sc)
            }
            _ => format!("step {}", action.step_number),
        };
        mermaid_lines.push(format!(
            "    {} -->|\"{}\"| {}",
            prev_node_id,
            escape_mermaid_label(&edge_text, 36),
            ctrl_id
        ));
        edge_count += 1;
        prev_node_id = ctrl_id;
    }

    if completed {
        let done_id = sanitize_mermaid_id("done", session_id);
        distinct_nodes.insert(done_id.clone());
        mermaid_lines.push(format!("    {}((\"Completed\"))", done_id));
        mermaid_lines.push(format!("    {} -->|\"done\"| {}", prev_node_id, done_id));
        edge_count += 1;
    }

    mermaid_lines.push("```".to_string());
    let node_count = distinct_nodes.len();

    let mut md = String::new();
    md.push_str("---\n");
    md.push_str(&format!("session_id: {}\n", escape_yaml_string(session_id)));
    md.push_str(&format!("day_key: {}\n", escape_yaml_string(&day_key)));
    md.push_str(&format!("app: {}\n", escape_yaml_string(app_clean)));
    md.push_str(&format!("goal: {}\n", escape_yaml_string(goal_clean)));
    md.push_str(&format!("brain: {}\n", escape_yaml_string(brain_clean)));
    md.push_str(&format!("completed: {}\n", completed));
    md.push_str(&format!("timestamp: {}\n", escape_yaml_string(&iso_ts)));
    md.push_str(&format!("created_at: {}\n", created_at));
    md.push_str(&format!("node_count: {}\n", node_count));
    md.push_str(&format!("edge_count: {}\n", edge_count));
    md.push_str("---\n\n");

    md.push_str(&format!("# {} — {}\n\n", app_clean, goal_clean));
    md.push_str(&format!(
        "- **Session:** `{}`  \n- **Screen:** {}  \n- **Status:** {}  \n- **Captured:** {}\n\n",
        session_id,
        screen_title,
        if completed { "Completed" } else { "In Progress" },
        iso_ts
    ));

    md.push_str("## State Graph\n\n");
    md.push_str(&mermaid_lines.join("\n"));
    md.push_str("\n\n## Verified Step-by-Step Action Log\n\n");

    if actions.is_empty() {
        md.push_str("_No resolved UI actions recorded for this session._\n");
    } else {
        for action in &actions {
            md.push_str(&format!(
                "### Step {}\n- **Instruction:** {}\n",
                action.step_number, action.instruction
            ));
            if let Some(ref target) = action.target_name {
                let ctype = action
                    .control_type
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .map(|t| format!(" ({})", t))
                    .unwrap_or_default();
                md.push_str(&format!("- **UI Control:** {}{}\n", target, ctype));
            }
            if let Some(ref kind) = action.action_kind {
                md.push_str(&format!("- **Action:** `{}`\n", kind));
            }
            if let Some(ref sc) = action.shortcut {
                md.push_str(&format!("- **Shortcut:** `{}`\n", sc));
            }
            if let Some(ref cmd) = action.terminal_command {
                md.push_str(&format!("- **Command:** `{}`\n", cmd));
            }
            if let Some(ref rect) = action.rect_str {
                md.push_str(&format!("- **Verified Screen Rect:** `{}`\n", rect));
            }
            if let Some(bbox) = action.bbox {
                md.push_str(&format!(
                    "- **Normalized BBox:** `[{:.1}, {:.1}, {:.1}, {:.1}]`\n",
                    bbox[0], bbox[1], bbox[2], bbox[3]
                ));
            }
            md.push('\n');
        }
    }

    fs::write(&out_path, md)
        .map_err(|e| format!("Failed to write session graph {:?}: {}", out_path, e))?;

    Ok((
        out_path.to_string_lossy().into_owned(),
        node_count,
        edge_count,
    ))
}

/// Writes the master Knowledge Graph markdown summary to `%LOCALAPPDATA%\GuideLens\memory\knowledge-graph.md`.
pub fn write_master_knowledge_graph_md(kg: &KnowledgeGraphDto) -> Result<String, String> {
    let mem_dir = memory_root_dir();
    write_master_knowledge_graph_md_in(&mem_dir, kg)
}

/// Writes `knowledge-graph.md` inside `memory_dir` (unit-test friendly).
pub fn write_master_knowledge_graph_md_in(
    memory_dir: &Path,
    kg: &KnowledgeGraphDto,
) -> Result<String, String> {
    fs::create_dir_all(memory_dir).map_err(|e| {
        format!(
            "Failed to create memory directory {:?}: {}",
            memory_dir, e
        )
    })?;
    let out_path = memory_dir.join("knowledge-graph.md");
    let now_dt = local_now_components();
    let iso_ts = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        now_dt.year, now_dt.month, now_dt.day, now_dt.hour, now_dt.minute, now_dt.second
    );

    let mut apps: BTreeSet<String> = BTreeSet::new();
    let mut node_map: BTreeMap<&str, &crate::types::KgNodeDto> = BTreeMap::new();
    for node in &kg.nodes {
        node_map.insert(node.id.as_str(), node);
        if !node.app_exe.trim().is_empty() {
            apps.insert(node.app_exe.clone());
        }
    }

    let mut md = String::new();
    md.push_str("---\n");
    md.push_str(&format!("updated_at: {}\n", escape_yaml_string(&iso_ts)));
    md.push_str(&format!("node_count: {}\n", kg.nodes.len()));
    md.push_str(&format!("edge_count: {}\n", kg.edges.len()));
    md.push_str(&format!("session_count: {}\n", kg.sessions.len()));
    md.push_str(&format!("app_count: {}\n", apps.len()));
    md.push_str("---\n\n");

    md.push_str("# GuideLens Master Knowledge Graph\n\n");
    md.push_str(&format!(
        "- **Learned Nodes:** {}\n- **Verified Action Edges:** {}\n- **Tracked Apps:** {}\n- **Recorded Sessions:** {}\n\n",
        kg.nodes.len(),
        kg.edges.len(),
        apps.len(),
        kg.sessions.len()
    ));

    md.push_str("## Knowledge Graph Topology\n\n");
    md.push_str("```mermaid\nflowchart LR\n");
    if kg.edges.is_empty() && kg.nodes.is_empty() {
        md.push_str("    empty[\"No learned workflows yet — start a Live Session to build memory\"]\n");
    } else {
        let mut declared: BTreeSet<String> = BTreeSet::new();
        for node in kg.nodes.iter().take(40) {
            let nid = sanitize_mermaid_id(&node.node_type, &node.id);
            if declared.insert(nid.clone()) {
                let lbl = escape_mermaid_label(
                    &format!("{}: {}", node.node_type, node.label),
                    44,
                );
                md.push_str(&format!("    {}[\"{}\"]\n", nid, lbl));
            }
        }
        for edge in kg.edges.iter().take(40) {
            let from_nid = node_map
                .get(edge.from_node.as_str())
                .map(|n| sanitize_mermaid_id(&n.node_type, &n.id))
                .unwrap_or_else(|| sanitize_mermaid_id("node", &edge.from_node));
            let to_nid = node_map
                .get(edge.to_node.as_str())
                .map(|n| sanitize_mermaid_id(&n.node_type, &n.id))
                .unwrap_or_else(|| sanitize_mermaid_id("node", &edge.to_node));

            if declared.insert(from_nid.clone()) {
                let lbl = node_map
                    .get(edge.from_node.as_str())
                    .map(|n| n.label.as_str())
                    .unwrap_or(&edge.from_node);
                md.push_str(&format!(
                    "    {}[\"{}\"]\n",
                    from_nid,
                    escape_mermaid_label(lbl, 40)
                ));
            }
            if declared.insert(to_nid.clone()) {
                let lbl = node_map
                    .get(edge.to_node.as_str())
                    .map(|n| n.label.as_str())
                    .unwrap_or(&edge.to_node);
                md.push_str(&format!(
                    "    {}[\"{}\"]\n",
                    to_nid,
                    escape_mermaid_label(lbl, 40)
                ));
            }

            let edge_lbl = match &edge.shortcut {
                Some(sc) if !sc.trim().is_empty() => format!("{} [{}]", edge.intent, sc),
                _ => edge.intent.clone(),
            };
            md.push_str(&format!(
                "    {} -->|\"{}\"| {}\n",
                from_nid,
                escape_mermaid_label(&edge_lbl, 36),
                to_nid
            ));
        }
    }
    md.push_str("```\n\n");

    md.push_str("## Top Verified Controls & Shortcuts\n\n");
    if kg.edges.is_empty() {
        md.push_str("_No learned controls yet._\n\n");
    } else {
        md.push_str("| App | Intent | Control | Shortcut | Successes |\n");
        md.push_str("| --- | --- | --- | --- | --- |\n");
        for edge in kg.edges.iter().take(50) {
            let app = node_map
                .get(edge.from_node.as_str())
                .or_else(|| node_map.get(edge.to_node.as_str()))
                .map(|n| n.app_exe.as_str())
                .unwrap_or("Unknown");
            let ctrl = edge
                .control_name
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("-");
            let sc = edge
                .shortcut
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("-");
            md.push_str(&format!(
                "| {} | {} | {} | {} | {} |\n",
                app.replace('|', "/"),
                edge.intent.replace('|', "/"),
                ctrl.replace('|', "/"),
                sc.replace('|', "/"),
                edge.success_count
            ));
        }
        md.push('\n');
    }

    md.push_str("## Recent Session Graphs\n\n");
    if kg.sessions.is_empty() {
        md.push_str("_No session graphs recorded yet._\n");
    } else {
        for sess in kg.sessions.iter().take(30) {
            md.push_str(&format!(
                "- `{}` **{}** — {} ({} nodes, {} edges, {})\n",
                sess.day_key,
                sess.active_app,
                sess.goal,
                sess.node_count,
                sess.edge_count,
                if sess.completed { "completed" } else { "in-progress" }
            ));
        }
    }

    fs::write(&out_path, md)
        .map_err(|e| format!("Failed to write master knowledge graph {:?}: {}", out_path, e))?;

    Ok(out_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{KgEdgeDto, KgNodeDto, RectPx, SessionGraphSummaryDto, StepSource};
    use tempfile::tempdir;

    #[test]
    fn test_civil_calendar_math_and_today_key() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        // Leap day 2024-02-29
        let d_leap = days_from_civil(2024, 2, 29);
        assert_eq!(civil_from_days(d_leap), (2024, 2, 29));
        assert_eq!(civil_from_days(d_leap + 1), (2024, 3, 1));
        // Non-leap 2100
        let d_2100 = days_from_civil(2100, 2, 28);
        assert_eq!(civil_from_days(d_2100 + 1), (2100, 3, 1));

        let key = today_day_key();
        assert_eq!(key.len(), 10);
        assert_eq!(&key[4..5], "-");
        assert_eq!(&key[7..8], "-");
    }

    #[test]
    fn test_write_session_graph_md_and_mermaid_validity() {
        let tmp = tempdir().expect("tempdir");
        let steps = vec![
            ResolvedStep {
                step_number: 1,
                instruction_line: "Open the integrated terminal from the top menu".to_string(),
                target_name: Some("Terminal -> New Terminal".to_string()),
                control_type: Some("MenuItem".to_string()),
                bbox: Some([100.0, 20.0, 80.0, 24.0]),
                confidence: 0.96,
                shortcut: Some("Ctrl+Shift+`".to_string()),
                terminal_command: None,
                explanation: None,
                spoken_text: None,
                target_id: Some(12),
                action_kind: Some("click".to_string()),
                companion_emotion: Some("pointing".to_string()),
                goal_complete: false,
                rect_px: Some(RectPx {
                    x: 192,
                    y: 22,
                    w: 154,
                    h: 26,
                }),
                source: StepSource::Som,
            },
            ResolvedStep {
                step_number: 2,
                instruction_line: "Run cargo test inside the shell".to_string(),
                target_name: Some("PowerShell Input".to_string()),
                control_type: Some("Edit".to_string()),
                bbox: Some([200.0, 700.0, 600.0, 200.0]),
                confidence: 0.9,
                shortcut: None,
                terminal_command: Some("cargo test".to_string()),
                explanation: None,
                spoken_text: None,
                target_id: Some(25),
                action_kind: Some("type".to_string()),
                companion_emotion: Some("happy".to_string()),
                goal_complete: true,
                rect_px: Some(RectPx {
                    x: 384,
                    y: 756,
                    w: 1152,
                    h: 216,
                }),
                source: StepSource::Uia,
            },
        ];
        let turns = vec![LiveSessionTurn {
            turn_number: 1,
            user_text: Some("Open terminal and run tests".to_string()),
            instruction_line: "Open the integrated terminal".to_string(),
            spoken_text: Some("Click Terminal up top!".to_string()),
            action_kind: Some("click".to_string()),
            companion_emotion: Some("pointing".to_string()),
            target_name: Some("Terminal".to_string()),
            rect_px: None,
            active_app: "Code.exe".to_string(),
            window_title: "lib.rs - GuideLens [SSH: dev] - Visual Studio Code".to_string(),
            latency: None,
            timestamp: 1_764_000_000,
        }];

        let (path_str, nodes, edges) = write_session_graph_md_in(
            tmp.path(),
            "sess-abc-123",
            "Code.exe",
            "Open \"terminal\" & run [tests]",
            "byo_api",
            &steps,
            &turns,
            true,
        )
        .expect("write session graph");

        let path = Path::new(&path_str);
        assert!(path.exists());
        assert!(path_str.ends_with(".graph.md"));
        assert!(path_str.contains("sessions"));
        assert_eq!(nodes, 6); // App, Screen, Goal, 2 Controls, Completed
        assert_eq!(edges, 5); // App->Screen, Screen->Goal, Goal->C1, C1->C2, C2->Done

        let content = fs::read_to_string(path).expect("read .graph.md");
        assert!(content.starts_with("---\n"));
        assert!(content.contains("session_id: \"sess-abc-123\""));
        assert!(content.contains("app: \"Code.exe\""));
        assert!(content.contains("completed: true"));
        assert!(content.contains("```mermaid\nflowchart LR"));
        assert!(content.contains("-->|\"focus\"|"));
        assert!(content.contains("-->|\"intent\"|"));
        assert!(content.contains("Ctrl+Shift+`"));
        assert!(content.contains("cargo test"));
        // Dangerous characters inside Mermaid node labels must be sanitized
        let mermaid_block = content
            .split("```mermaid")
            .nth(1)
            .and_then(|s| s.split("```").next())
            .expect("mermaid block");
        assert!(!mermaid_block.contains("[tests]"));
    }

    #[test]
    fn test_write_master_knowledge_graph_md() {
        let tmp = tempdir().expect("tempdir");
        let kg = KnowledgeGraphDto {
            nodes: vec![
                KgNodeDto {
                    id: "app:code".to_string(),
                    node_type: "app".to_string(),
                    app_exe: "Code.exe".to_string(),
                    label: "Visual Studio Code".to_string(),
                    metadata_json: None,
                    hit_count: 5,
                    updated_at: 100,
                },
                KgNodeDto {
                    id: "ctrl:term".to_string(),
                    node_type: "control".to_string(),
                    app_exe: "Code.exe".to_string(),
                    label: "New Terminal".to_string(),
                    metadata_json: None,
                    hit_count: 3,
                    updated_at: 101,
                },
            ],
            edges: vec![KgEdgeDto {
                id: "edge:1".to_string(),
                from_node: "app:code".to_string(),
                to_node: "ctrl:term".to_string(),
                relation: "verified_step".to_string(),
                intent: "Open integrated terminal".to_string(),
                control_name: Some("New Terminal".to_string()),
                control_type: Some("MenuItem".to_string()),
                shortcut: Some("Ctrl+Shift+`".to_string()),
                norm_bbox: Some([120.0, 40.0, 80.0, 24.0]),
                success_count: 3,
                updated_at: 102,
            }],
            sessions: vec![SessionGraphSummaryDto {
                session_id: "s1".to_string(),
                day_key: "2026-11-25".to_string(),
                active_app: "Code.exe".to_string(),
                goal: "Open integrated terminal".to_string(),
                graph_md_path: "C:\\tmp\\s1.graph.md".to_string(),
                node_count: 4,
                edge_count: 3,
                completed: true,
                created_at: 102,
            }],
            master_md_path: None,
        };

        let out = write_master_knowledge_graph_md_in(tmp.path(), &kg).expect("write master kg");
        assert!(Path::new(&out).ends_with("knowledge-graph.md"));
        let md = fs::read_to_string(&out).expect("read master kg");
        assert!(md.contains("```mermaid\nflowchart LR"));
        assert!(md.contains("Open integrated terminal"));
        assert!(md.contains("Ctrl+Shift+`"));
    }
}
