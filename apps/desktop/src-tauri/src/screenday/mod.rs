//! All-Day Screen Day Tracker: privacy-shielded background capture loop, project/meeting
//! classification, local OCR indexing, daily diary packaging, and Nightly AI Wrap-Up.

pub mod classifier;
pub mod packager;

use crate::db::{unix_now, DbState};
use crate::memory::graph_md::{
    format_day_key_from_unix, local_now_components, today_day_key, validate_day_key,
};
use crate::types::{
    OverlayCompanionPayload, ScreenDayDetailDto, ScreenDayFrameDto, ScreenDayStatusDto,
    ScreenDaySummaryDto,
};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

const WORKER_POLL_INTERVAL_SECS: u64 = 3;
const SCREENDAY_DHASH_THRESHOLD: u32 = 6;
const SCREENDAY_OCR_MAX_CHARS: usize = 280;

#[derive(Debug, Default)]
struct ScreenDayRuntime {
    last_captured_at: Option<i64>,
    last_capture_instant: Option<Instant>,
    last_window_key: Option<String>,
    last_dhash: Option<String>,
    last_day_key: Option<String>,
    current_project: Option<String>,
    current_meeting: Option<String>,
    skipped_private: bool,
}

/// Shared runtime state for Screen Day tracking, registered in Tauri `.manage(ScreenDayState::new())`.
#[derive(Clone, Default)]
pub struct ScreenDayState {
    enabled: Arc<AtomicBool>,
    runtime: Arc<Mutex<ScreenDayRuntime>>,
}

impl ScreenDayState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
    }

    pub fn build_status(&self, db: &DbState) -> ScreenDayStatusDto {
        let settings = db.get_settings().unwrap_or_default();
        let today = today_day_key();
        let detail = db.get_screenday_day_detail(&today).ok().flatten();

        let (today_frames, today_bytes, db_last_at) = match detail {
            Some(d) => (
                d.summary.frame_count,
                d.summary.total_bytes,
                d.frames.last().map(|f| f.captured_at),
            ),
            None => (0, 0, None),
        };

        let rt = self.runtime.lock().ok();
        let last_captured_at = rt
            .as_ref()
            .and_then(|g| g.last_captured_at)
            .or(db_last_at);
        let current_project = rt.as_ref().and_then(|g| g.current_project.clone());
        let current_meeting = rt.as_ref().and_then(|g| g.current_meeting.clone());
        let skipped_private = rt.as_ref().map(|g| g.skipped_private).unwrap_or(false);

        ScreenDayStatusDto {
            enabled: self.is_enabled(),
            interval_sec: settings.screenday_interval_sec.max(5),
            today_key: today,
            today_frames,
            today_bytes,
            last_captured_at,
            current_project,
            current_meeting,
            skipped_private,
        }
    }
}

fn clamp_chars(raw: &str, max_chars: usize) -> String {
    let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        collapsed
    } else {
        collapsed.chars().take(max_chars).collect()
    }
}

fn emit_screenday_companion_peek(
    app: &AppHandle,
    companion_id: &str,
    wander: bool,
    recording: bool,
    emotion: &str,
    bubble_text: Option<String>,
) {
    let overlay_busy = app
        .try_state::<crate::overlay::OverlayState>()
        .map(|o| o.is_active())
        .unwrap_or(false);
    if overlay_busy {
        return;
    }

    let _ = app.emit(
        "overlay-companion",
        OverlayCompanionPayload {
            mode: if recording {
                "wander".to_string()
            } else {
                "idle".to_string()
            },
            companion_id: companion_id.to_string(),
            emotion: emotion.to_string(),
            wander,
            x: None,
            y: None,
            bubble_text,
            screenday_recording: recording,
        },
    );
}

fn allocate_frame_path(frames_dir: &Path, now_unix: i64) -> std::path::PathBuf {
    let dt = local_now_components();
    let hhmmss = format!("{:02}{:02}{:02}", dt.hour, dt.minute, dt.second);
    let primary = frames_dir.join(format!("{}.jpg", hhmmss));
    if !primary.exists() {
        return primary;
    }
    for idx in 2..100 {
        let candidate = frames_dir.join(format!("{}-{}.jpg", hhmmss, idx));
        if !candidate.exists() {
            return candidate;
        }
    }
    frames_dir.join(format!("{}-{}.jpg", hhmmss, now_unix))
}

async fn capture_and_record_frame(
    app: &AppHandle,
    db: &DbState,
    sd: &ScreenDayState,
    force_immediate: bool,
) -> Result<Option<ScreenDayFrameDto>, String> {
    let settings = db.get_settings().unwrap_or_default();

    // Pre-check foreground window before capturing screen pixels so private apps are never grabbed.
    let pre_win = tokio::task::spawn_blocking(crate::capture::detect_active_window)
        .await
        .map_err(|e| format!("Active window check failed: {}", e))?;

    if classifier::is_private_window(
        &pre_win.active_app,
        &pre_win.window_title,
        &settings.screenday_excluded_apps,
        settings.screenday_skip_private,
    ) {
        if let Ok(mut rt) = sd.runtime.lock() {
            rt.skipped_private = true;
            rt.current_project = None;
            rt.current_meeting = None;
        }
        return Ok(None);
    }

    let interval = Duration::from_secs(u64::from(settings.screenday_interval_sec.max(5)));
    let pre_window_key = format!(
        "{}::{}",
        pre_win.active_app.trim().to_ascii_lowercase(),
        pre_win.window_title.trim()
    );

    if !force_immediate {
        if let Ok(mut rt) = sd.runtime.lock() {
            let same_window = rt.last_window_key.as_deref() == Some(pre_window_key.as_str());
            let interval_elapsed = rt
                .last_capture_instant
                .map(|t| t.elapsed() >= interval)
                .unwrap_or(true);
            if same_window && !interval_elapsed {
                rt.skipped_private = false;
                return Ok(None);
            }
        }
    }

    let app_for_cap = app.clone();
    let frame = tokio::task::spawn_blocking(move || {
        crate::capture::capture_for_live_grounding(Some(&app_for_cap))
    })
    .await
    .map_err(|e| format!("Screen Day capture task failed: {}", e))??;

    // Re-check privacy against the exact captured window metadata.
    if classifier::is_private_window(
        &frame.active_app,
        &frame.window_title,
        &settings.screenday_excluded_apps,
        settings.screenday_skip_private,
    ) {
        if let Ok(mut rt) = sd.runtime.lock() {
            rt.skipped_private = true;
            rt.current_project = None;
            rt.current_meeting = None;
        }
        return Ok(None);
    }

    let day_key = today_day_key();
    let window_key = format!(
        "{}::{}",
        frame.active_app.trim().to_ascii_lowercase(),
        frame.window_title.trim()
    );
    let dhash_hex = crate::capture::dhash_to_hex(frame.dhash64);

    let should_capture = if force_immediate {
        true
    } else {
        let mut prev_dhash = sd
            .runtime
            .lock()
            .ok()
            .and_then(|rt| rt.last_dhash.clone());
        if prev_dhash.is_none() {
            prev_dhash = db.get_latest_screenday_dhash(Some(&day_key)).ok().flatten();
        }

        let (window_changed, interval_elapsed) = if let Ok(rt) = sd.runtime.lock() {
            let w_changed = rt
                .last_window_key
                .as_deref()
                .map(|prev| prev != window_key)
                .unwrap_or(true);
            let elapsed = rt
                .last_capture_instant
                .map(|t| t.elapsed() >= interval)
                .unwrap_or(true);
            (w_changed, elapsed)
        } else {
            (true, true)
        };

        let hamming = prev_dhash
            .as_deref()
            .map(|prev| crate::capture::hamming_distance_hex(prev, &dhash_hex))
            .unwrap_or(64);

        window_changed || (interval_elapsed && hamming >= SCREENDAY_DHASH_THRESHOLD)
    };

    if !should_capture {
        if let Ok(mut rt) = sd.runtime.lock() {
            rt.skipped_private = false;
        }
        return Ok(None);
    }

    let now_unix = unix_now();
    let frames_dir = packager::day_frames_dir(&day_key);
    let _ = fs::create_dir_all(&frames_dir);
    let out_path = allocate_frame_path(&frames_dir, now_unix);
    let out_path_str = out_path.to_string_lossy().into_owned();

    let (jpeg_bytes, ocr_excerpt, project_name, meeting_name, active_app_cap, window_title_cap) =
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let bytes = crate::capture::encode_compressed_day_frame(&frame.image, 1280, 52)?;
            let raw_ocr = crate::grounding::extract_ocr_text_only(&frame.image);
            let ocr_clamped = clamp_chars(&raw_ocr, SCREENDAY_OCR_MAX_CHARS);
            let ocr_opt = if ocr_clamped.is_empty() {
                None
            } else {
                Some(ocr_clamped)
            };
            let (proj, meet) = classifier::classify_project_and_meeting(
                &frame.active_app,
                &frame.window_title,
                ocr_opt.as_deref().unwrap_or(""),
            );
            Ok((
                bytes,
                ocr_opt,
                proj,
                meet,
                pre_win_or_frame_app(&frame.active_app),
                frame.window_title,
            ))
        })
        .await
        .map_err(|e| format!("Screen Day compression/OCR failed: {}", e))??;

    let file_bytes = jpeg_bytes.len() as u64;
    crate::capture::save_bytes_async(out_path, jpeg_bytes);

    let dto = ScreenDayFrameDto {
        id: Uuid::new_v4().to_string(),
        day_key: day_key.clone(),
        captured_at: now_unix,
        image_path: out_path_str,
        active_app: active_app_cap,
        window_title: window_title_cap,
        project_name: project_name.clone(),
        meeting_name: meeting_name.clone(),
        ocr_excerpt,
        dhash: dhash_hex.clone(),
        file_bytes,
    };

    db.insert_screenday_frame(&dto)?;
    let _ = packager::refresh_day_package_from_db(db, &day_key, None);

    if let Ok(mut rt) = sd.runtime.lock() {
        rt.last_captured_at = Some(now_unix);
        rt.last_capture_instant = Some(Instant::now());
        rt.last_window_key = Some(window_key);
        rt.last_dhash = Some(dhash_hex);
        rt.last_day_key = Some(day_key);
        rt.current_project = project_name.clone();
        rt.current_meeting = meeting_name.clone();
        rt.skipped_private = false;
    }

    let _ = app.emit("screenday-frame", &dto);

    let peek_bubble = meeting_name
        .as_ref()
        .map(|m| format!("Noting: {}", m))
        .or_else(|| project_name.as_ref().map(|p| format!("Diary: {}", p)));

    emit_screenday_companion_peek(
        app,
        &settings.companion_id,
        settings.companion_wander,
        sd.is_enabled(),
        "peeking",
        peek_bubble,
    );

    Ok(Some(dto))
}

fn pre_win_or_frame_app(app: &str) -> String {
    let trimmed = app.trim();
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Starts the background Screen Day Tokio worker waking every 3 seconds.
pub fn start_screenday_worker(app: AppHandle) {
    let initial_enabled = app
        .try_state::<DbState>()
        .and_then(|db| db.get_settings().ok())
        .map(|s| s.screenday_enabled)
        .unwrap_or(false);

    if let Some(sd) = app.try_state::<ScreenDayState>() {
        sd.set_enabled(initial_enabled);
        if let Some(db) = app.try_state::<DbState>() {
            let today = today_day_key();
            if let Ok(Some(dhash)) = db.get_latest_screenday_dhash(Some(&today)) {
                if let Ok(mut rt) = sd.runtime.lock() {
                    rt.last_dhash = Some(dhash);
                    rt.last_day_key = Some(today);
                }
            }
        }
    }

    tauri::async_runtime::spawn(async move {
        let mut last_db_enabled = initial_enabled;
        loop {
            tokio::time::sleep(Duration::from_secs(WORKER_POLL_INTERVAL_SECS)).await;

            let Some(sd_state) = app.try_state::<ScreenDayState>() else {
                continue;
            };
            let Some(db_state) = app.try_state::<DbState>() else {
                continue;
            };

            if let Ok(settings) = db_state.get_settings() {
                if settings.screenday_enabled != last_db_enabled {
                    last_db_enabled = settings.screenday_enabled;
                    sd_state.set_enabled(settings.screenday_enabled);
                }
            }

            if !sd_state.is_enabled() {
                continue;
            }

            if let Err(err) =
                capture_and_record_frame(&app, &db_state, &sd_state, false).await
            {
                log::warn!("Screen Day background capture warning: {}", err);
            }
        }
    });
}

/// Toggles Screen Day recording on or off, persists the setting, and returns updated status.
#[tauri::command]
pub fn screenday_set_enabled(
    app: AppHandle,
    db: State<'_, DbState>,
    sd: State<'_, ScreenDayState>,
    enabled: bool,
) -> Result<ScreenDayStatusDto, String> {
    sd.set_enabled(enabled);
    let mut settings = db.get_settings().unwrap_or_default();
    if settings.screenday_enabled != enabled {
        settings.screenday_enabled = enabled;
        db.set_settings(&settings)?;
        let _ = app.emit("settings-changed", &settings);
    }

    emit_screenday_companion_peek(
        &app,
        &settings.companion_id,
        settings.companion_wander,
        enabled,
        if enabled { "peeking" } else { "idle" },
        None,
    );

    Ok(sd.build_status(&db))
}

/// Returns current Screen Day status, today's capture counts, active project/meeting, and privacy state.
#[tauri::command]
pub fn screenday_status(
    db: State<'_, DbState>,
    sd: State<'_, ScreenDayState>,
) -> Result<ScreenDayStatusDto, String> {
    Ok(sd.build_status(&db))
}

/// Immediately captures and indexes one Screen Day frame (respecting Privacy Shield).
#[tauri::command]
pub async fn screenday_capture_now(
    app: AppHandle,
    db: State<'_, DbState>,
    sd: State<'_, ScreenDayState>,
) -> Result<Option<ScreenDayFrameDto>, String> {
    capture_and_record_frame(&app, &db, &sd, true).await
}

/// Lists recorded Screen Days ordered newest-first.
#[tauri::command]
pub fn screenday_list_days(
    db: State<'_, DbState>,
    limit: Option<u32>,
) -> Result<Vec<ScreenDaySummaryDto>, String> {
    db.list_screenday_days(limit.unwrap_or(30))
}

/// Returns full details (frames, project groups, meeting groups, sessions, markdown files) for `day_key`.
#[tauri::command]
pub fn screenday_get_day(
    db: State<'_, DbState>,
    day_key: String,
) -> Result<Option<ScreenDayDetailDto>, String> {
    let valid_key = validate_day_key(&day_key)?;
    let mut detail = match db.get_screenday_day_detail(&valid_key)? {
        Some(d) => d,
        None => return Ok(None),
    };

    let day_dir = if detail.summary.folder_path.trim().is_empty() {
        packager::day_folder_path(&valid_key)
    } else {
        std::path::PathBuf::from(&detail.summary.folder_path)
    };

    if detail.day_graph_md.is_none() {
        let gp = day_dir.join("day-graph.md");
        if gp.is_file() {
            detail.day_graph_md = fs::read_to_string(gp).ok();
        }
    }
    if detail.day_diary_md.is_none() {
        let dp = day_dir.join("day-diary.md");
        if dp.is_file() {
            detail.day_diary_md = fs::read_to_string(dp).ok();
        }
    }

    Ok(Some(detail))
}

/// Generates (or refreshes) the Nightly AI Summary + `day-diary.md` + `day-graph.md` for `day_key`.
/// Automatically falls back to the structured local summary when offline or no summary brain is configured.
#[tauri::command]
pub async fn screenday_generate_summary(
    _app: AppHandle,
    db: State<'_, DbState>,
    brain_state: State<'_, crate::brain::BrainState>,
    day_key: String,
) -> Result<Option<ScreenDayDetailDto>, String> {
    let target_day = if day_key.trim().is_empty() {
        format_day_key_from_unix(unix_now())
    } else {
        validate_day_key(&day_key)?
    };

    let Some(detail) = db.get_screenday_day_detail(&target_day)? else {
        return Ok(None);
    };

    let prompt =
        packager::build_nightly_summary_prompt(&target_day, &detail.frames, &detail.sessions);
    let ai_or_fallback =
        match crate::brain::commands::generate_day_summary_text(&db, &brain_state, &prompt).await {
            Ok(text) if !text.trim().is_empty() => text,
            Err(err) => {
                log::info!(
                    "Nightly summary AI unavailable ({}); using local structured summary",
                    err
                );
                packager::build_structured_local_summary(
                    &target_day,
                    &detail.frames,
                    &detail.sessions,
                )
            }
            Ok(_) => packager::build_structured_local_summary(
                &target_day,
                &detail.frames,
                &detail.sessions,
            ),
        };

    let updated =
        packager::refresh_day_package_from_db(&db, &target_day, Some(&ai_or_fallback))?;
    Ok(Some(updated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_screenday_state_status_and_clamp() {
        let tmp = tempdir().expect("tempdir");
        let db = DbState::open(&tmp.path().join("sd_state.db")).expect("open db");
        let sd = ScreenDayState::new();

        assert!(!sd.is_enabled());
        sd.set_enabled(true);
        assert!(sd.is_enabled());

        let status = sd.build_status(&db);
        assert!(status.enabled);
        assert_eq!(status.interval_sec, 15);
        assert_eq!(status.today_frames, 0);

        let long = "hello   world ".repeat(40);
        let clamped = clamp_chars(&long, SCREENDAY_OCR_MAX_CHARS);
        assert!(clamped.chars().count() <= SCREENDAY_OCR_MAX_CHARS);
        assert!(!clamped.contains("   "));

        assert!(validate_day_key("2026-11-25").is_ok());
        assert!(validate_day_key("../2026-11-25").is_err());
        assert!(validate_day_key("2026-11-25/../../secret").is_err());
    }
}
