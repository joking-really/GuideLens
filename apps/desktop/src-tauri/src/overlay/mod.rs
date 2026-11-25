use crate::db::DbState;
use crate::types::{
    MonitorInfo, OverlayCompanionPayload, RectPx, ResolvedStep, StepChangedPayload, StepMode,
    StepSource,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

static OVERLAY_EXCLUDED_FROM_CAPTURE: AtomicBool = AtomicBool::new(false);
static COMPANION_ONLY_MODE: AtomicBool = AtomicBool::new(false);
static CUE_GENERATION: AtomicU64 = AtomicU64::new(0);
static CURSOR_EMITTER_STARTED: AtomicBool = AtomicBool::new(false);

pub const CURSOR_GAZE_THRESHOLD_PX: i32 = 6;
const CURSOR_GAZE_INTERVAL_MS: u64 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorGazePayload {
    pub x: i32,
    pub y: i32,
}

/// Returns whether companion-only mode (bar hidden, companion kept visible on screen) is active.
pub fn is_companion_only_mode() -> bool {
    COMPANION_ONLY_MODE.load(Ordering::Relaxed)
}

/// Returns whether a cursor moved at least `threshold_px` (Euclidean) since `last`.
pub fn has_cursor_moved_enough(
    last: Option<(i32, i32)>,
    current: (i32, i32),
    threshold_px: i32,
) -> bool {
    match last {
        None => true,
        Some((lx, ly)) => {
            let dx = i64::from(current.0) - i64::from(lx);
            let dy = i64::from(current.1) - i64::from(ly);
            let thresh = i64::from(threshold_px.max(0));
            dx * dx + dy * dy >= thresh * thresh
        }
    }
}

#[cfg(windows)]
fn read_cursor_pos() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_ok() {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn read_cursor_pos() -> Option<(i32, i32)> {
    None
}

/// Starts a lightweight 120ms background cursor gaze emitter that skips work whenever `"overlay"`
/// is hidden and only emits `"overlay-cursor"` when cursor movement is >= 6px.
pub fn start_cursor_gaze_emitter(app: AppHandle) {
    if CURSOR_EMITTER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(CURSOR_GAZE_INTERVAL_MS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_pos: Option<(i32, i32)> = None;

        loop {
            ticker.tick().await;

            let overlay_visible = app
                .get_webview_window("overlay")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            if !overlay_visible {
                last_pos = None;
                continue;
            }

            if let Some(pos) = read_cursor_pos() {
                if has_cursor_moved_enough(last_pos, pos, CURSOR_GAZE_THRESHOLD_PX) {
                    last_pos = Some(pos);
                    let _ = app.emit("overlay-cursor", CursorGazePayload { x: pos.0, y: pos.1 });
                }
            }
        }
    });
}

/// Returns whether the overlay window was successfully excluded from OS screen capture
/// via `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`.
pub fn is_overlay_excluded_from_capture() -> bool {
    OVERLAY_EXCLUDED_FROM_CAPTURE.load(Ordering::Relaxed)
}

#[derive(Debug, Clone, Default)]
struct ActiveGuidance {
    steps: Vec<ResolvedStep>,
    current_index: usize,
    magnify: bool,
    high_contrast: bool,
    capture_path: Option<String>,
    monitor: Option<MonitorInfo>,
    mode: StepMode,
    session_id: Option<String>,
    active: bool,
    generation: u64,
    target_hwnd: isize,
    target_title: String,
}

#[derive(Clone, Default)]
pub struct OverlayState {
    inner: Arc<Mutex<ActiveGuidance>>,
}

impl OverlayState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn current_rect(&self) -> Option<RectPx> {
        let guard = self.inner.lock().ok()?;
        if !guard.active {
            return None;
        }
        guard
            .steps
            .get(guard.current_index)
            .and_then(|s| s.rect_px)
            .filter(|r| r.w > 0 && r.h > 0)
    }

    pub fn is_active(&self) -> bool {
        self.inner.lock().map(|g| g.active).unwrap_or(false)
    }

    pub fn current_step(&self) -> Option<ResolvedStep> {
        let guard = self.inner.lock().ok()?;
        if !guard.active {
            return None;
        }
        guard.steps.get(guard.current_index).cloned()
    }

    pub fn guidance_generation(&self) -> u64 {
        self.inner.lock().map(|g| g.generation).unwrap_or(0)
    }

    pub fn target_window(&self) -> (isize, String) {
        self.inner
            .lock()
            .map(|g| (g.target_hwnd, g.target_title.clone()))
            .unwrap_or((0, String::new()))
    }

    pub fn clear_in_memory(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.active = false;
            guard.steps.clear();
            guard.current_index = 0;
            guard.generation = guard.generation.wrapping_add(1);
            guard.target_hwnd = 0;
            guard.target_title.clear();
        }
    }
}

/// Returns virtual desktop bounds `(x, y, width, height)` in physical pixels across all monitors.
#[cfg(windows)]
pub fn virtual_desktop_bounds() -> (i32, i32, u32, u32) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1920) as u32;
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1080) as u32;
        (x, y, w, h)
    }
}

#[cfg(not(windows))]
pub fn virtual_desktop_bounds() -> (i32, i32, u32, u32) {
    (0, 0, 1920, 1080)
}

/// Applies Windows extended window styles `WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`
/// and spans the `overlay` window across the entire virtual desktop so clicks pass through 100%.
pub fn configure_overlay_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("overlay") else {
        return;
    };

    let (vx, vy, vw, vh) = virtual_desktop_bounds();
    let _ = win.set_position(PhysicalPosition::new(vx, vy));
    let _ = win.set_size(PhysicalSize::new(vw, vh));
    let _ = win.set_ignore_cursor_events(true);

    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowDisplayAffinity, SetWindowLongPtrW, SetWindowPos,
            GWL_EXSTYLE, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            WDA_EXCLUDEFROMCAPTURE, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
            WS_EX_TRANSPARENT,
        };
        unsafe {
            let raw_hwnd = HWND(hwnd.0 as _);
            let current_style = GetWindowLongPtrW(raw_hwnd, GWL_EXSTYLE);
            let flags = (WS_EX_TRANSPARENT.0
                | WS_EX_LAYERED.0
                | WS_EX_TOOLWINDOW.0
                | WS_EX_NOACTIVATE.0) as isize;
            let _ = SetWindowLongPtrW(raw_hwnd, GWL_EXSTYLE, current_style | flags);
            let _ = SetWindowPos(
                raw_hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
            let excluded = SetWindowDisplayAffinity(raw_hwnd, WDA_EXCLUDEFROMCAPTURE).is_ok();
            OVERLAY_EXCLUDED_FROM_CAPTURE.store(excluded, Ordering::Relaxed);
        }
    }
}

/// Ensures the overlay window is click-through and visible (unless companion is hidden) and emits `overlay-companion`.
pub fn emit_overlay_companion(
    app: &AppHandle,
    payload: OverlayCompanionPayload,
) -> Result<(), String> {
    if !payload.companion_id.trim().eq_ignore_ascii_case("none") && payload.mode != "hidden" {
        configure_overlay_window(app);
        if let Some(overlay_win) = app.get_webview_window("overlay") {
            let _ = overlay_win.show();
        }
    }
    app.emit("overlay-companion", payload)
        .map_err(|e| format!("Failed to emit overlay-companion: {}", e))
}

/// IPC command allowing Control Center / Companion Studio to preview companion poses and bubbles on Surface 1.
#[tauri::command]
pub fn preview_companion(
    app: AppHandle,
    companion_id: String,
    emotion: Option<String>,
    bubble_text: Option<String>,
) -> Result<(), String> {
    let settings = app
        .try_state::<DbState>()
        .and_then(|db| db.get_settings().ok())
        .unwrap_or_default();

    let clean_id = if companion_id.trim().is_empty() {
        settings.companion_id.clone()
    } else {
        companion_id.trim().to_string()
    };

    let mode = if clean_id.eq_ignore_ascii_case("none") {
        "hidden".to_string()
    } else {
        "preview".to_string()
    };

    let payload = OverlayCompanionPayload {
        mode,
        companion_id: clean_id,
        emotion: emotion
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| "happy".to_string()),
        wander: settings.companion_wander,
        x: None,
        y: None,
        bubble_text: bubble_text.and_then(|b| {
            let trimmed = b.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        }),
        screenday_recording: settings.screenday_enabled,
    };

    emit_overlay_companion(&app, payload)
}

fn emit_step_companion(app: &AppHandle, step: &ResolvedStep) {
    let settings = app
        .try_state::<DbState>()
        .and_then(|db| db.get_settings().ok())
        .unwrap_or_default();
    if settings.companion_id.trim().eq_ignore_ascii_case("none") {
        return;
    }

    let emotion = step
        .companion_emotion
        .clone()
        .unwrap_or_else(|| {
            if step.goal_complete {
                "celebrate".to_string()
            } else if step.rect_px.is_some() {
                "pointing".to_string()
            } else {
                "thinking".to_string()
            }
        });

    let (x, y) = step
        .rect_px
        .map(|r| (Some(r.x + r.w / 2), Some(r.y)))
        .unwrap_or((None, None));

    let payload = OverlayCompanionPayload {
        mode: if step.goal_complete {
            "celebrate".to_string()
        } else {
            "guiding".to_string()
        },
        companion_id: settings.companion_id,
        emotion,
        wander: settings.companion_wander,
        x,
        y,
        bubble_text: Some(step.instruction_line.clone()),
        screenday_recording: settings.screenday_enabled,
    };
    let _ = app.emit("overlay-companion", payload);
}

fn emit_current_step(app: &AppHandle, guidance: &ActiveGuidance) -> Result<(), String> {
    let Some(step) = guidance.steps.get(guidance.current_index).cloned() else {
        return Ok(());
    };
    let auto_tiny = step
        .rect_px
        .map(|r| r.w > 0 && r.h > 0 && (r.w < 24 || r.h < 24))
        .unwrap_or(false);
    emit_step_companion(app, &step);
    let payload = StepChangedPayload {
        step,
        index: guidance.current_index,
        total: guidance.steps.len(),
        magnify: guidance.magnify || auto_tiny,
        high_contrast: guidance.high_contrast,
        capture_path: guidance.capture_path.clone(),
        monitor: guidance.monitor.clone(),
        mode: guidance.mode,
    };
    app.emit("step-changed", payload)
        .map_err(|e| format!("Failed to emit step-changed: {}", e))
}

/// Starts a multi-step guidance session and emits `step-changed` for step 0.
pub fn start_guidance(
    app: &AppHandle,
    mut steps: Vec<ResolvedStep>,
    mode: StepMode,
    capture_path: Option<String>,
    monitor: Option<MonitorInfo>,
    session_id: Option<String>,
) -> Result<Option<ResolvedStep>, String> {
    if steps.is_empty() {
        clear_overlay_state(app)?;
        return Ok(None);
    }

    for (idx, step) in steps.iter_mut().enumerate() {
        if step.step_number == 0 {
            step.step_number = (idx + 1) as u32;
        }
        step.instruction_line = crate::types::Step::clamp_instruction(&step.instruction_line);
        if step.confidence < 0.5 && !matches!(step.source, StepSource::Uia | StepSource::Som) {
            step.rect_px = None;
            step.source = StepSource::None;
        }
    }

    let (always_magnify, high_contrast) = app
        .try_state::<DbState>()
        .and_then(|db| db.get_settings().ok())
        .map(|s| (s.always_magnify, s.high_contrast))
        .unwrap_or((false, false));

    configure_overlay_window(app);
    if let Some(overlay_win) = app.get_webview_window("overlay") {
        let _ = overlay_win.show();
    }

    let target_win = crate::capture::detect_active_window();
    let first_step = steps.first().cloned();
    let state = app.state::<OverlayState>();
    let snapshot = {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "OverlayState mutex poisoned".to_string())?;
        guard.steps = steps;
        guard.current_index = 0;
        guard.magnify = always_magnify;
        guard.high_contrast = high_contrast;
        guard.capture_path = capture_path;
        guard.monitor = monitor;
        guard.mode = mode;
        guard.session_id = session_id;
        guard.active = true;
        guard.generation = guard.generation.wrapping_add(1);
        guard.target_hwnd = target_win.hwnd;
        guard.target_title = target_win.window_title;
        guard.clone()
    };

    emit_current_step(app, &snapshot)?;
    crate::input::ensure_overlay_hooks(app);
    Ok(first_step)
}

/// Convenience entry point for `@brains` and `/v1/guide` with just `Vec<ResolvedStep>`.
pub fn start_overlay_guidance(
    app: &AppHandle,
    steps: Vec<ResolvedStep>,
) -> Result<Option<ResolvedStep>, String> {
    let mode = if steps.iter().any(|s| s.terminal_command.is_some()) {
        StepMode::Terminal
    } else {
        StepMode::Guide
    };
    start_guidance(app, steps, mode, None, None, None)
}

/// Advances to the next step (`index + 1`). If on the final step, clears the overlay.
pub fn advance_step(app: &AppHandle) -> Result<Option<ResolvedStep>, String> {
    let target_win = crate::capture::detect_active_window();
    let state = app.state::<OverlayState>();
    let (completed_session_step, next_snapshot) = {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "OverlayState mutex poisoned".to_string())?;
        if !guard.active || guard.steps.is_empty() {
            return Ok(None);
        }

        let completed = guard.session_id.as_ref().and_then(|sid| {
            guard
                .steps
                .get(guard.current_index)
                .map(|s| (sid.clone(), s.step_number))
        });

        guard.generation = guard.generation.wrapping_add(1);
        if guard.current_index + 1 < guard.steps.len() {
            guard.current_index += 1;
            guard.target_hwnd = target_win.hwnd;
            guard.target_title = target_win.window_title;
            (completed, Some(guard.clone()))
        } else {
            guard.active = false;
            guard.steps.clear();
            guard.current_index = 0;
            guard.target_hwnd = 0;
            guard.target_title.clear();
            (completed, None)
        }
    };

    if let Some((sid, step_num)) = completed_session_step {
        if let Some(db) = app.try_state::<DbState>() {
            let _ = db.mark_step_completed(&sid, step_num);
        }
    }

    match next_snapshot {
        Some(snapshot) => {
            let step = snapshot.steps.get(snapshot.current_index).cloned();
            emit_current_step(app, &snapshot)?;
            Ok(step)
        }
        None => {
            clear_overlay_visuals_only(app);
            Ok(None)
        }
    }
}

fn clear_overlay_visuals_only(app: &AppHandle) {
    crate::input::release_overlay_hooks_if_idle(app);

    let settings = app
        .try_state::<DbState>()
        .and_then(|db| db.get_settings().ok())
        .unwrap_or_default();

    let _ = app.emit("overlay-cleared", ());
    sync_companion_with_settings(app, &settings);
}

/// Immediately clears the active step highlight box while keeping the live companion visible
/// in `observing`/`thinking` mode (used during live click-to-advance so the old box disappears at once).
pub fn clear_step_keep_companion(app: &AppHandle, status_text: Option<String>) -> Result<(), String> {
    if let Some(state) = app.try_state::<OverlayState>() {
        state.clear_in_memory();
    }
    let _ = app.emit("overlay-cleared", ());

    let settings = app
        .try_state::<DbState>()
        .and_then(|db| db.get_settings().ok())
        .unwrap_or_default();

    if !settings.companion_id.trim().eq_ignore_ascii_case("none") {
        let bubble = status_text.and_then(|s| {
            let trimmed = s.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        let _ = app.emit(
            "overlay-companion",
            OverlayCompanionPayload {
                mode: "observing".to_string(),
                companion_id: settings.companion_id,
                emotion: "thinking".to_string(),
                wander: settings.companion_wander,
                x: None,
                y: None,
                bubble_text: bubble,
                screenday_recording: settings.screenday_enabled,
            },
        );
    }
    Ok(())
}

/// Clears active overlay guidance, releases global hooks (when no live session is guiding), and emits `overlay-cleared`.
pub fn clear_overlay_state(app: &AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<OverlayState>() {
        state.clear_in_memory();
    }
    clear_overlay_visuals_only(app);
    Ok(())
}

/// Toggles the 2.5x magnifier lens on or off and re-emits `step-changed`.
pub fn set_magnify(app: &AppHandle, on: bool) -> Result<(), String> {
    let state = app.state::<OverlayState>();
    let snapshot = {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "OverlayState mutex poisoned".to_string())?;
        guard.magnify = on;
        if guard.active {
            Some(guard.clone())
        } else {
            None
        }
    };

    if let Some(snap) = snapshot {
        emit_current_step(app, &snap)?;
    }
    Ok(())
}

/// Renders a terminal command & explanation in the floating bar (used by MCP `/v1/show_command`).
pub fn show_terminal_command(
    app: &AppHandle,
    command: String,
    explanation: String,
) -> Result<(), String> {
    let clamped_exp = crate::types::Step::clamp_instruction(&explanation);
    let step = ResolvedStep {
        step_number: 1,
        instruction_line: if clamped_exp.is_empty() {
            crate::types::Step::clamp_instruction(&format!("Run command: {}", command))
        } else {
            clamped_exp.clone()
        },
        target_name: None,
        control_type: None,
        bbox: None,
        confidence: 1.0,
        shortcut: None,
        terminal_command: Some(command),
        explanation: Some(clamped_exp),
        spoken_text: None,
        target_id: None,
        action_kind: Some("explain".to_string()),
        companion_emotion: Some("pointing".to_string()),
        goal_complete: false,
        rect_px: None,
        source: StepSource::None,
    };

    if let Some(bar_win) = app.get_webview_window("bar") {
        let _ = bar_win.show();
    }

    let _ = start_guidance(app, vec![step], StepMode::Terminal, None, None, None)?;
    Ok(())
}

/// Returns whether the overlay window should remain visible for an idle/companion-only pet.
pub fn should_keep_overlay_visible(
    companion_id: &str,
    screenday_enabled: bool,
    companion_only: bool,
) -> bool {
    !companion_id.trim().eq_ignore_ascii_case("none") && (screenday_enabled || companion_only)
}

/// Sets companion-only mode (top bar hidden, companion kept visible on screen in `wander` / `play` mode).
pub fn set_companion_only_mode(app: &AppHandle, on: bool) {
    COMPANION_ONLY_MODE.store(on, Ordering::SeqCst);

    let settings = app
        .try_state::<DbState>()
        .and_then(|db| db.get_settings().ok())
        .unwrap_or_default();

    let overlay_busy = app
        .try_state::<OverlayState>()
        .map(|s| s.is_active())
        .unwrap_or(false);
    if overlay_busy {
        return;
    }

    if on && !settings.companion_id.trim().eq_ignore_ascii_case("none") {
        let _ = emit_overlay_companion(
            app,
            OverlayCompanionPayload {
                mode: "wander".to_string(),
                companion_id: settings.companion_id,
                emotion: "play".to_string(),
                wander: settings.companion_wander,
                x: None,
                y: None,
                bubble_text: None,
                screenday_recording: settings.screenday_enabled,
            },
        );
    } else {
        sync_companion_with_settings(app, &settings);
    }
}

/// Shows a brief, quiet companion bubble cue (e.g. `"Switched to Local"`) and then restores
/// normal idle/companion-only/hidden state after ~2.4s.
pub fn show_companion_cue(app: &AppHandle, text: &str) {
    let settings = app
        .try_state::<DbState>()
        .and_then(|db| db.get_settings().ok())
        .unwrap_or_default();
    if settings.companion_id.trim().eq_ignore_ascii_case("none") {
        return;
    }
    let overlay_busy = app
        .try_state::<OverlayState>()
        .map(|s| s.is_active())
        .unwrap_or(false);
    if overlay_busy {
        return;
    }

    let gen = CUE_GENERATION.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let _ = emit_overlay_companion(
        app,
        OverlayCompanionPayload {
            mode: "preview".to_string(),
            companion_id: settings.companion_id.clone(),
            emotion: "curious".to_string(),
            wander: settings.companion_wander,
            x: None,
            y: None,
            bubble_text: Some(text.to_string()),
            screenday_recording: settings.screenday_enabled,
        },
    );

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(2400)).await;
        if CUE_GENERATION.load(Ordering::SeqCst) != gen {
            return;
        }
        let latest = app_clone
            .try_state::<DbState>()
            .and_then(|db| db.get_settings().ok())
            .unwrap_or_default();
        sync_companion_with_settings(&app_clone, &latest);
    });
}

/// Syncs idle companion visibility/peek mode with updated settings when overlay guidance is not active.
pub fn sync_companion_with_settings(app: &AppHandle, settings: &crate::types::Settings) {
    let overlay_busy = app
        .try_state::<OverlayState>()
        .map(|s| s.is_active())
        .unwrap_or(false);
    if overlay_busy {
        return;
    }

    let companion_only = is_companion_only_mode();
    if !should_keep_overlay_visible(&settings.companion_id, settings.screenday_enabled, companion_only) {
        let _ = app.emit(
            "overlay-companion",
            OverlayCompanionPayload {
                mode: "hidden".to_string(),
                companion_id: settings.companion_id.clone(),
                emotion: "idle".to_string(),
                wander: settings.companion_wander,
                x: None,
                y: None,
                bubble_text: None,
                screenday_recording: settings.screenday_enabled,
            },
        );
        if let Some(overlay_win) = app.get_webview_window("overlay") {
            let _ = overlay_win.hide();
        }
    } else {
        let _ = emit_overlay_companion(
            app,
            OverlayCompanionPayload {
                mode: if companion_only || settings.companion_wander {
                    "wander".to_string()
                } else {
                    "idle".to_string()
                },
                companion_id: settings.companion_id.clone(),
                emotion: if companion_only {
                    "play".to_string()
                } else {
                    "peeking".to_string()
                },
                wander: settings.companion_wander,
                x: None,
                y: None,
                bubble_text: None,
                screenday_recording: settings.screenday_enabled,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_state_tracks_active_rect_and_step() {
        let state = OverlayState::new();
        assert!(!state.is_active());
        assert_eq!(state.current_rect(), None);
        assert_eq!(state.current_step(), None);

        let rect = RectPx {
            x: 100,
            y: 200,
            w: 120,
            h: 36,
        };
        let step = ResolvedStep {
            step_number: 1,
            instruction_line: "Click Export".to_string(),
            target_name: Some("Export".to_string()),
            control_type: Some("Button".to_string()),
            bbox: None,
            confidence: 0.9,
            shortcut: None,
            terminal_command: None,
            explanation: None,
            spoken_text: Some("Tap Export!".to_string()),
            target_id: Some(4),
            action_kind: Some("click".to_string()),
            companion_emotion: Some("pointing".to_string()),
            goal_complete: false,
            rect_px: Some(rect),
            source: StepSource::Som,
        };

        {
            let mut guard = state.inner.lock().unwrap();
            guard.steps = vec![step.clone()];
            guard.current_index = 0;
            guard.active = true;
        }

        assert!(state.is_active());
        assert_eq!(state.current_rect(), Some(rect));
        assert_eq!(state.current_step(), Some(step));

        let gen_before = state.guidance_generation();
        state.clear_in_memory();
        assert!(!state.is_active());
        assert_eq!(state.current_rect(), None);
        assert_eq!(state.current_step(), None);
        assert_eq!(state.target_window(), (0, String::new()));
        assert_ne!(state.guidance_generation(), gen_before);
    }

    #[test]
    fn cursor_gaze_threshold_and_companion_only_visibility() {
        assert_eq!(CURSOR_GAZE_THRESHOLD_PX, 6);
        assert!(has_cursor_moved_enough(None, (100, 100), 6));
        assert!(!has_cursor_moved_enough(Some((100, 100)), (100, 100), 6));
        assert!(!has_cursor_moved_enough(Some((100, 100)), (103, 104), 6)); // dist^2 = 25 < 36
        assert!(has_cursor_moved_enough(Some((100, 100)), (106, 100), 6)); // dist^2 = 36
        assert!(has_cursor_moved_enough(Some((100, 100)), (94, 100), 6));
        assert!(has_cursor_moved_enough(Some((100, 100)), (105, 104), 6)); // dist^2 = 41 >= 36

        assert!(!should_keep_overlay_visible("none", true, true));
        assert!(!should_keep_overlay_visible("pixel_cat", false, false));
        assert!(should_keep_overlay_visible("pixel_cat", true, false));
        assert!(should_keep_overlay_visible("pixel_cat", false, true));
        assert!(should_keep_overlay_visible("minimal_orb", true, true));
    }
}
