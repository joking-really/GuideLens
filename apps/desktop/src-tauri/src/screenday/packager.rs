//! Daily packaging: `day-graph.md`, `day-diary.md`, structured offline summaries,
//! and Nightly AI Wrap-Up prompt builder.

use crate::db::{unix_now, DbState};
use crate::memory::graph_md::{
    days_root_dir, escape_mermaid_label, escape_yaml_string, format_hhmm_from_unix,
    format_hhmmss_from_unix, sanitize_mermaid_id, today_day_key, validate_day_key,
};
use crate::types::{
    ScreenDayDetailDto, ScreenDayFrameDto, ScreenDayMeetingGroup, ScreenDayProjectGroup,
    ScreenDaySummaryDto, SessionGraphSummaryDto,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Returns `%LOCALAPPDATA%\GuideLens\days\<day_key>` (falling back safely to today if invalid).
pub fn day_folder_path(day_key: &str) -> PathBuf {
    let safe_key = validate_day_key(day_key).unwrap_or_else(|_| today_day_key());
    days_root_dir().join(safe_key)
}

/// Returns `%LOCALAPPDATA%\GuideLens\days\<day_key>\frames`.
pub fn day_frames_dir(day_key: &str) -> PathBuf {
    day_folder_path(day_key).join("frames")
}

/// Returns `%LOCALAPPDATA%\GuideLens\days\<day_key>\sessions`.
pub fn day_sessions_dir(day_key: &str) -> PathBuf {
    day_folder_path(day_key).join("sessions")
}

/// Aggregates frames into sorted project groups.
pub fn summarize_projects(frames: &[ScreenDayFrameDto]) -> Vec<ScreenDayProjectGroup> {
    let mut map: BTreeMap<String, (usize, BTreeSet<String>)> = BTreeMap::new();
    for frame in frames {
        let Some(proj) = frame
            .project_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let entry = map
            .entry(proj.to_string())
            .or_insert_with(|| (0, BTreeSet::new()));
        entry.0 += 1;
        if !frame.active_app.trim().is_empty() {
            entry.1.insert(frame.active_app.clone());
        }
    }
    let mut out: Vec<ScreenDayProjectGroup> = map
        .into_iter()
        .map(|(name, (frame_count, apps))| ScreenDayProjectGroup {
            name,
            frame_count,
            apps: apps.into_iter().collect(),
        })
        .collect();
    out.sort_by(|a, b| {
        b.frame_count
            .cmp(&a.frame_count)
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// Aggregates frames into chronological meeting groups with captured screen topics.
pub fn summarize_meetings(frames: &[ScreenDayFrameDto]) -> Vec<ScreenDayMeetingGroup> {
    struct Accum {
        started_at: i64,
        ended_at: i64,
        frame_count: usize,
        topics: Vec<String>,
    }

    let mut map: BTreeMap<String, Accum> = BTreeMap::new();
    for frame in frames {
        let Some(meeting) = frame
            .meeting_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let entry = map.entry(meeting.to_string()).or_insert_with(|| Accum {
            started_at: frame.captured_at,
            ended_at: frame.captured_at,
            frame_count: 0,
            topics: Vec::new(),
        });
        entry.started_at = entry.started_at.min(frame.captured_at);
        entry.ended_at = entry.ended_at.max(frame.captured_at);
        entry.frame_count += 1;

        let mut topic_parts = Vec::new();
        if !frame.window_title.trim().is_empty() {
            topic_parts.push(frame.window_title.trim().to_string());
        }
        if let Some(ocr) = frame
            .ocr_excerpt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let short_ocr: String = ocr.chars().take(120).collect();
            topic_parts.push(format!("OCR: {}", short_ocr));
        }
        let topic = topic_parts.join(" — ");
        if !topic.is_empty() && entry.topics.len() < 12 && !entry.topics.contains(&topic) {
            entry.topics.push(topic);
        }
    }

    let mut out: Vec<ScreenDayMeetingGroup> = map
        .into_iter()
        .map(|(name, acc)| ScreenDayMeetingGroup {
            name,
            started_at: acc.started_at,
            ended_at: acc.ended_at,
            frame_count: acc.frame_count,
            screen_topics: acc.topics,
        })
        .collect();
    out.sort_by(|a, b| {
        a.started_at
            .cmp(&b.started_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// Builds valid Mermaid `day-graph.md` linking Day -> Projects -> Meetings -> Apps -> Live Sessions.
pub fn build_day_graph_md(
    day_key: &str,
    frames: &[ScreenDayFrameDto],
    sessions: &[SessionGraphSummaryDto],
) -> String {
    let projects = summarize_projects(frames);
    let meetings = summarize_meetings(frames);

    let mut app_counts: BTreeMap<String, usize> = BTreeMap::new();
    for frame in frames {
        if !frame.active_app.trim().is_empty() {
            *app_counts.entry(frame.active_app.clone()).or_insert(0) += 1;
        }
    }

    let mut md = String::new();
    md.push_str("---\n");
    md.push_str(&format!("day_key: {}\n", escape_yaml_string(day_key)));
    md.push_str(&format!("frame_count: {}\n", frames.len()));
    md.push_str(&format!("session_count: {}\n", sessions.len()));
    md.push_str(&format!("project_count: {}\n", projects.len()));
    md.push_str(&format!("meeting_count: {}\n", meetings.len()));
    md.push_str("---\n\n");
    md.push_str(&format!("# Screen Day Graph — {}\n\n", day_key));
    md.push_str("```mermaid\nflowchart LR\n");

    let day_id = sanitize_mermaid_id("day", day_key);
    md.push_str(&format!(
        "    {}[\"Day: {} ({} frames)\"]\n",
        day_id,
        escape_mermaid_label(day_key, 24),
        frames.len()
    ));

    let mut declared: BTreeSet<String> = [day_id.clone()].into_iter().collect();
    let mut linked_apps: BTreeSet<String> = BTreeSet::new();

    // Projects -> Apps
    for proj in projects.iter().take(12) {
        let proj_id = sanitize_mermaid_id("proj", &proj.name);
        if declared.insert(proj_id.clone()) {
            md.push_str(&format!(
                "    {}[\"Project: {} ({})\"]\n",
                proj_id,
                escape_mermaid_label(&proj.name, 36),
                proj.frame_count
            ));
        }
        md.push_str(&format!("    {} -->|\"project\"| {}\n", day_id, proj_id));

        for app in proj.apps.iter().take(6) {
            let app_id = sanitize_mermaid_id("app", app);
            if declared.insert(app_id.clone()) {
                let count = app_counts.get(app).copied().unwrap_or(1);
                md.push_str(&format!(
                    "    {}[\"{} ({})\"]\n",
                    app_id,
                    escape_mermaid_label(app, 28),
                    count
                ));
            }
            linked_apps.insert(app.clone());
            md.push_str(&format!("    {} -->|\"used\"| {}\n", proj_id, app_id));
        }
    }

    // Meetings -> Apps / Screen Topics
    for meet in meetings.iter().take(10) {
        let meet_id = sanitize_mermaid_id("meet", &meet.name);
        let span = format!(
            "{}-{}",
            format_hhmm_from_unix(meet.started_at),
            format_hhmm_from_unix(meet.ended_at)
        );
        if declared.insert(meet_id.clone()) {
            md.push_str(&format!(
                "    {}[\"Meeting: {} ({})\"]\n",
                meet_id,
                escape_mermaid_label(&meet.name, 36),
                span
            ));
        }
        md.push_str(&format!("    {} -->|\"meeting\"| {}\n", day_id, meet_id));

        if let Some(first_topic) = meet.screen_topics.first() {
            let topic_id = sanitize_mermaid_id("mscr", &format!("{}:{}", meet.name, first_topic));
            if declared.insert(topic_id.clone()) {
                md.push_str(&format!(
                    "    {}[\"On Screen: {}\"]\n",
                    topic_id,
                    escape_mermaid_label(first_topic, 44)
                ));
            }
            md.push_str(&format!("    {} -->|\"showed\"| {}\n", meet_id, topic_id));
        }
    }

    // Standalone Apps not yet linked under a project
    for (app, count) in app_counts.iter().take(14) {
        if linked_apps.contains(app) {
            continue;
        }
        let app_id = sanitize_mermaid_id("app", app);
        if declared.insert(app_id.clone()) {
            md.push_str(&format!(
                "    {}[\"{} ({})\"]\n",
                app_id,
                escape_mermaid_label(app, 28),
                count
            ));
        }
        md.push_str(&format!("    {} -->|\"app\"| {}\n", day_id, app_id));
    }

    // GuideLens Live Sessions -> Apps
    for sess in sessions.iter().take(12) {
        let sess_id = sanitize_mermaid_id("sess", &sess.session_id);
        if declared.insert(sess_id.clone()) {
            md.push_str(&format!(
                "    {}[\"Copilot: {}\"]\n",
                sess_id,
                escape_mermaid_label(&sess.goal, 42)
            ));
        }
        md.push_str(&format!("    {} -->|\"session\"| {}\n", day_id, sess_id));

        let app_id = sanitize_mermaid_id("app", &sess.active_app);
        if declared.insert(app_id.clone()) {
            md.push_str(&format!(
                "    {}[\"{}\"]\n",
                app_id,
                escape_mermaid_label(&sess.active_app, 28)
            ));
        }
        md.push_str(&format!("    {} -->|\"in\"| {}\n", sess_id, app_id));
    }

    md.push_str("```\n");
    md
}

/// Builds a rich structured local summary fallback when offline or before AI Nightly Wrap-Up.
pub fn build_structured_local_summary(
    day_key: &str,
    frames: &[ScreenDayFrameDto],
    sessions: &[SessionGraphSummaryDto],
) -> String {
    let projects = summarize_projects(frames);
    let meetings = summarize_meetings(frames);

    let mut app_counts: BTreeMap<String, usize> = BTreeMap::new();
    for frame in frames {
        *app_counts.entry(frame.active_app.clone()).or_insert(0) += 1;
    }
    let mut top_apps: Vec<(String, usize)> = app_counts.into_iter().collect();
    top_apps.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let mut out = String::new();
    out.push_str(&format!("### Daily Snapshot ({})\n\n", day_key));
    out.push_str(&format!(
        "- **Captured Frames:** {}\n- **Projects Touched:** {}\n- **Meetings Detected:** {}\n- **Copilot Sessions:** {}\n\n",
        frames.len(),
        projects.len(),
        meetings.len(),
        sessions.len()
    ));

    if !projects.is_empty() {
        out.push_str("#### Projects\n");
        for p in &projects {
            out.push_str(&format!(
                "- **{}** — {} frames (apps: {})\n",
                p.name,
                p.frame_count,
                p.apps.join(", ")
            ));
        }
        out.push('\n');
    }

    if !meetings.is_empty() {
        out.push_str("#### Meetings & What Was On Screen\n");
        for m in &meetings {
            out.push_str(&format!(
                "- **{}** ({}–{}, {} frames)\n",
                m.name,
                format_hhmm_from_unix(m.started_at),
                format_hhmm_from_unix(m.ended_at),
                m.frame_count
            ));
            for topic in m.screen_topics.iter().take(4) {
                out.push_str(&format!("  - Screen: {}\n", topic));
            }
        }
        out.push('\n');
    }

    if !top_apps.is_empty() {
        out.push_str("#### Top Applications\n");
        for (app, count) in top_apps.iter().take(6) {
            out.push_str(&format!("- `{}` — {} captures\n", app, count));
        }
        out.push('\n');
    }

    if !sessions.is_empty() {
        out.push_str("#### GuideLens Guided Sessions\n");
        for s in sessions {
            out.push_str(&format!(
                "- **{}** in `{}` ({})\n",
                s.goal,
                s.active_app,
                if s.completed { "completed" } else { "in progress" }
            ));
        }
    }

    out.trim_end().to_string()
}

/// Builds the full `day-diary.md` combining the Nightly Summary, Meetings & Screen Context,
/// Projects, Copilot Sessions, and Visual Timeline.
pub fn build_day_diary_md(
    day_key: &str,
    frames: &[ScreenDayFrameDto],
    sessions: &[SessionGraphSummaryDto],
    ai_or_local_summary: Option<&str>,
) -> String {
    let projects = summarize_projects(frames);
    let meetings = summarize_meetings(frames);
    let summary_section = ai_or_local_summary
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| build_structured_local_summary(day_key, frames, sessions));

    let mut md = String::new();
    md.push_str(&format!("# Screen Day Diary — {}\n\n", day_key));
    md.push_str("## Nightly Summary\n\n");
    md.push_str(&summary_section);
    md.push_str("\n\n");

    md.push_str("## Meetings & What Was Shown On Screen\n\n");
    if meetings.is_empty() {
        md.push_str("_No meetings detected today._\n\n");
    } else {
        for m in &meetings {
            md.push_str(&format!(
                "### {} ({} – {}, {} frames)\n",
                m.name,
                format_hhmm_from_unix(m.started_at),
                format_hhmm_from_unix(m.ended_at),
                m.frame_count
            ));
            if m.screen_topics.is_empty() {
                md.push_str("- _No screen text captured during meeting._\n");
            } else {
                for topic in &m.screen_topics {
                    md.push_str(&format!("- {}\n", topic));
                }
            }
            md.push('\n');
        }
    }

    md.push_str("## Projects\n\n");
    if projects.is_empty() {
        md.push_str("_No named projects grouped yet._\n\n");
    } else {
        for p in &projects {
            md.push_str(&format!(
                "- **{}** — {} frames across {}\n",
                p.name,
                p.frame_count,
                p.apps.join(", ")
            ));
        }
        md.push('\n');
    }

    md.push_str("## GuideLens Copilot Sessions\n\n");
    if sessions.is_empty() {
        md.push_str("_No GuideLens guidance sessions recorded today._\n\n");
    } else {
        for s in sessions {
            let file_name = Path::new(&s.graph_md_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&s.graph_md_path);
            md.push_str(&format!(
                "- **{}** (`{}`) — {} nodes, {} edges (`sessions/{}`)\n",
                s.goal, s.active_app, s.node_count, s.edge_count, file_name
            ));
        }
        md.push('\n');
    }

    md.push_str("## Visual Timeline\n\n");
    if frames.is_empty() {
        md.push_str("_No frames captured yet._\n");
    } else {
        md.push_str("| Time | App | Window | Tag | OCR Excerpt |\n");
        md.push_str("| --- | --- | --- | --- | --- |\n");
        for frame in frames.iter().take(200) {
            let time = format_hhmmss_from_unix(frame.captured_at);
            let tag = match (&frame.meeting_name, &frame.project_name) {
                (Some(m), _) => format!("Meeting: {}", m),
                (None, Some(p)) => format!("Project: {}", p),
                _ => "-".to_string(),
            };
            let ocr = frame
                .ocr_excerpt
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(100).collect::<String>())
                .unwrap_or_else(|| "-".to_string());
            md.push_str(&format!(
                "| {} | {} | {} | {} | {} |\n",
                time,
                frame.active_app.replace('|', "/"),
                frame.window_title.replace('|', "/").replace('\n', " "),
                tag.replace('|', "/"),
                ocr.replace('|', "/").replace('\n', " ")
            ));
        }
    }

    md
}

/// Condenses a day's frames and sessions into a high-signal prompt for the Nightly AI Wrap-Up.
pub fn build_nightly_summary_prompt(
    day_key: &str,
    frames: &[ScreenDayFrameDto],
    sessions: &[SessionGraphSummaryDto],
) -> String {
    let projects = summarize_projects(frames);
    let meetings = summarize_meetings(frames);

    let mut prompt = String::new();
    prompt.push_str(&format!(
        "You are GuideLens Nightly Diary. Write a concise, insightful markdown wrap-up for {}.\n\
        Focus on: (1) Key Accomplishments & Projects, (2) Meetings & What Was Shown On Screen, (3) Notable Patterns or Next Steps.\n\n",
        day_key
    ));

    if !projects.is_empty() {
        prompt.push_str("PROJECTS:\n");
        for p in &projects {
            prompt.push_str(&format!(
                "- {} ({} frames; apps: {})\n",
                p.name,
                p.frame_count,
                p.apps.join(", ")
            ));
        }
        prompt.push('\n');
    }

    if !meetings.is_empty() {
        prompt.push_str("MEETINGS & SCREEN CONTEXT:\n");
        for m in &meetings {
            prompt.push_str(&format!(
                "- {} ({}-{}, {} frames): {}\n",
                m.name,
                format_hhmm_from_unix(m.started_at),
                format_hhmm_from_unix(m.ended_at),
                m.frame_count,
                m.screen_topics.join(" | ")
            ));
        }
        prompt.push('\n');
    }

    if !sessions.is_empty() {
        prompt.push_str("GUIDELENS COPILOT SESSIONS:\n");
        for s in sessions {
            prompt.push_str(&format!(
                "- [{}] {} (completed={})\n",
                s.active_app, s.goal, s.completed
            ));
        }
        prompt.push('\n');
    }

    prompt.push_str("TIMELINE HIGHLIGHTS (deduplicated transitions):\n");
    let mut last_key = String::new();
    let mut count = 0usize;
    for frame in frames {
        let key = format!("{}::{}", frame.active_app, frame.window_title);
        if key == last_key {
            continue;
        }
        last_key = key;
        let ocr = frame
            .ocr_excerpt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| format!(" | OCR: {}", s.chars().take(120).collect::<String>()))
            .unwrap_or_default();
        prompt.push_str(&format!(
            "- {} [{}] {}{}\n",
            format_hhmm_from_unix(frame.captured_at),
            frame.active_app,
            frame.window_title,
            ocr
        ));
        count += 1;
        if count >= 45 {
            break;
        }
    }

    prompt
}

/// Writes `day-graph.md` and `day-diary.md` inside `day_dir`.
///
/// Returns `(graph_md_path, diary_md_path, diary_md_content)`.
pub fn write_day_package_in(
    day_dir: &Path,
    day_key: &str,
    frames: &[ScreenDayFrameDto],
    sessions: &[SessionGraphSummaryDto],
    ai_summary: Option<&str>,
) -> Result<(String, String, String), String> {
    fs::create_dir_all(day_dir)
        .map_err(|e| format!("Failed to create Screen Day dir {:?}: {}", day_dir, e))?;

    let graph_md = build_day_graph_md(day_key, frames, sessions);
    let diary_md = build_day_diary_md(day_key, frames, sessions, ai_summary);

    let graph_path = day_dir.join("day-graph.md");
    let diary_path = day_dir.join("day-diary.md");

    fs::write(&graph_path, &graph_md)
        .map_err(|e| format!("Failed to write {:?}: {}", graph_path, e))?;
    fs::write(&diary_path, &diary_md)
        .map_err(|e| format!("Failed to write {:?}: {}", diary_path, e))?;

    Ok((
        graph_path.to_string_lossy().into_owned(),
        diary_path.to_string_lossy().into_owned(),
        diary_md,
    ))
}

const AI_SUMMARY_MARKER: &str = "<!-- guidelens-ai-nightly-summary -->";

/// Marks an AI-generated summary so subsequent automatic frame captures do not overwrite it
/// with the local structured fallback.
pub fn tag_ai_summary(summary: &str) -> String {
    let trimmed = summary.trim();
    if trimmed.contains(AI_SUMMARY_MARKER) {
        trimmed.to_string()
    } else {
        format!("{}\n{}", AI_SUMMARY_MARKER, trimmed)
    }
}

fn extract_existing_ai_summary(summary_md: Option<&str>) -> Option<String> {
    let raw = summary_md?;
    if !raw.contains(AI_SUMMARY_MARKER) {
        return None;
    }
    if let Some(after_heading) = raw.split("## Nightly Summary").nth(1) {
        let section = after_heading
            .split("\n## ")
            .next()
            .unwrap_or(after_heading)
            .trim();
        if !section.is_empty() {
            return Some(section.to_string());
        }
    }
    Some(raw.to_string())
}

/// Refreshes `day-graph.md`, `day-diary.md`, and `screenday_days` metadata in SQLite
/// from the latest DB frames and sessions for `day_key`.
pub fn refresh_day_package_from_db(
    db: &DbState,
    day_key: &str,
    ai_summary: Option<&str>,
) -> Result<ScreenDayDetailDto, String> {
    let day_dir = day_folder_path(day_key);
    refresh_day_package_from_db_in(db, &day_dir, day_key, ai_summary)
}

/// Testable helper refreshing day markdown & SQLite metadata inside `day_dir`.
pub fn refresh_day_package_from_db_in(
    db: &DbState,
    day_dir: &Path,
    day_key: &str,
    ai_summary: Option<&str>,
) -> Result<ScreenDayDetailDto, String> {
    let existing = db.get_screenday_day_detail(day_key)?;
    let frames = existing
        .as_ref()
        .map(|d| d.frames.clone())
        .unwrap_or_default();
    let sessions = db.list_session_graphs(Some(day_key), 200)?;

    let tagged_ai = ai_summary
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(tag_ai_summary)
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|d| extract_existing_ai_summary(d.summary.summary_md.as_deref()))
        });

    let (graph_md_path, _diary_path, diary_md) =
        write_day_package_in(day_dir, day_key, &frames, &sessions, tagged_ai.as_deref())?;

    let project_groups = summarize_projects(&frames);
    let meeting_groups = summarize_meetings(&frames);
    let total_bytes: u64 = frames.iter().map(|f| f.file_bytes).sum();
    let now = unix_now();

    let summary_meta = ScreenDaySummaryDto {
        day_key: day_key.to_string(),
        folder_path: day_dir.to_string_lossy().into_owned(),
        frame_count: frames.len(),
        total_bytes,
        session_count: sessions.len(),
        projects: project_groups.iter().map(|p| p.name.clone()).collect(),
        meetings: meeting_groups.iter().map(|m| m.name.clone()).collect(),
        summary_md: Some(diary_md.clone()),
        graph_md_path: Some(graph_md_path.clone()),
        updated_at: now,
    };
    db.upsert_screenday_day_meta(&summary_meta)?;

    if ai_summary.is_some() {
        db.update_screenday_day_summary(day_key, &diary_md, Some(&graph_md_path), now)?;
    }

    let graph_md = fs::read_to_string(&graph_md_path).ok();
    Ok(ScreenDayDetailDto {
        summary: summary_meta,
        frames,
        project_groups,
        meeting_groups,
        sessions,
        day_graph_md: graph_md,
        day_diary_md: Some(diary_md),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_daily_folder_packaging_writes_valid_graph_and_diary() {
        let tmp = tempdir().expect("tempdir");
        let db = DbState::open(&tmp.path().join("day_pkg.db")).expect("open db");
        let day_key = "2026-11-25";
        let day_dir = tmp.path().join("days").join(day_key);

        let f1 = ScreenDayFrameDto {
            id: "f1".to_string(),
            day_key: day_key.to_string(),
            captured_at: 1_764_050_000,
            image_path: day_dir.join("frames").join("100000.jpg").to_string_lossy().into_owned(),
            active_app: "Code.exe".to_string(),
            window_title: "packager.rs - GuideLens - Visual Studio Code".to_string(),
            project_name: Some("GuideLens".to_string()),
            meeting_name: None,
            ocr_excerpt: Some("pub fn build_day_graph_md".to_string()),
            dhash: "0123456789abcdef".to_string(),
            file_bytes: 42_000,
        };
        let f2 = ScreenDayFrameDto {
            id: "f2".to_string(),
            day_key: day_key.to_string(),
            captured_at: 1_764_053_600,
            image_path: day_dir.join("frames").join("110000.jpg").to_string_lossy().into_owned(),
            active_app: "Zoom.exe".to_string(),
            window_title: "Architecture Sync - Zoom".to_string(),
            project_name: None,
            meeting_name: Some("Architecture Sync".to_string()),
            ocr_excerpt: Some("Screen Day timeline review".to_string()),
            dhash: "fedcba9876543210".to_string(),
            file_bytes: 51_000,
        };

        db.insert_screenday_frame(&f1).unwrap();
        db.insert_screenday_frame(&f2).unwrap();
        db.insert_session_graph(&SessionGraphSummaryDto {
            session_id: "sess-live-1".to_string(),
            day_key: day_key.to_string(),
            active_app: "Code.exe".to_string(),
            goal: "Fix clippy warnings".to_string(),
            graph_md_path: day_dir
                .join("sessions")
                .join("100500-code-fix-clippy.graph.md")
                .to_string_lossy()
                .into_owned(),
            node_count: 4,
            edge_count: 3,
            completed: true,
            created_at: 1_764_050_300,
        })
        .unwrap();

        let detail =
            refresh_day_package_from_db_in(&db, &day_dir, day_key, None).expect("refresh day");
        assert!(day_dir.join("day-graph.md").exists());
        assert!(day_dir.join("day-diary.md").exists());

        let graph_md = detail.day_graph_md.as_deref().expect("day_graph_md");
        assert!(graph_md.contains("```mermaid\nflowchart LR"));
        assert!(graph_md.contains("Project: GuideLens"));
        assert!(graph_md.contains("Meeting: Architecture Sync"));
        assert!(graph_md.contains("Copilot: Fix clippy warnings"));

        let diary_md = detail.day_diary_md.as_deref().expect("day_diary_md");
        assert!(diary_md.contains("## Nightly Summary"));
        assert!(diary_md.contains("## Meetings & What Was Shown On Screen"));
        assert!(diary_md.contains("Screen Day timeline review"));

        // Applying AI nightly summary preserves it across subsequent refreshes
        let with_ai = refresh_day_package_from_db_in(
            &db,
            &day_dir,
            day_key,
            Some("Great focus on GuideLens packaging and Architecture Sync."),
        )
        .expect("apply ai summary");
        assert!(with_ai
            .day_diary_md
            .as_deref()
            .unwrap()
            .contains("Great focus on GuideLens packaging"));

        let refreshed_again =
            refresh_day_package_from_db_in(&db, &day_dir, day_key, None).expect("preserve ai");
        assert!(refreshed_again
            .day_diary_md
            .as_deref()
            .unwrap()
            .contains("Great focus on GuideLens packaging"));
    }
}
