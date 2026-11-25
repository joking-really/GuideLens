use crate::db::DbState;
use crate::types::{
    MonitorInfo, OverlayCompanionPayload, RectPx, ResolvedStep, StepChangedPayload, StepMode,
    StepSource,
};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

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
            GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
            SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_LAYERED,
            WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
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

        if guard.current_index + 1 < guard.steps.len() {
            guard.current_index += 1;
            (completed, Some(guard.clone()))
        } else {
            guard.active = false;
            guard.steps.clear();
            guard.current_index = 0;
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

    if !settings.screenday_enabled || settings.companion_id.trim().eq_ignore_ascii_case("none") {
        if let Some(overlay_win) = app.get_webview_window("overlay") {
            let _ = overlay_win.hide();
        }
    } else {
        let _ = app.emit(
            "overlay-companion",
            OverlayCompanionPayload {
                mode: if settings.companion_wander {
                    "wander".to_string()
                } else {
                    "idle".to_string()
                },
                companion_id: settings.companion_id,
                emotion: "peeking".to_string(),
                wander: settings.companion_wander,
                x: None,
                y: None,
                bubble_text: None,
                screenday_recording: settings.screenday_enabled,
            },
        );
    }
    let _ = app.emit("overlay-cleared", ());
}

/// Clears active overlay guidance, releases global hooks (when no live session is guiding), and emits `overlay-cleared`.
pub fn clear_overlay_state(app: &AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<OverlayState>() {
        if let Ok(mut guard) = state.inner.lock() {
            guard.active = false;
            guard.steps.clear();
            guard.current_index = 0;
        }
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

/// Syncs idle companion visibility/peek mode with updated settings when overlay guidance is not active.
pub fn sync_companion_with_settings(app: &AppHandle, settings: &crate::types::Settings) {
    let overlay_busy = app
        .try_state::<OverlayState>()
        .map(|s| s.is_active())
        .unwrap_or(false);
    if overlay_busy {
        return;
    }

    if settings.companion_id.trim().eq_ignore_ascii_case("none") || !settings.screenday_enabled {
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
                mode: if settings.companion_wander {
                    "wander".to_string()
                } else {
                    "idle".to_string()
                },
                companion_id: settings.companion_id.clone(),
                emotion: "peeking".to_string(),
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
    }
}
