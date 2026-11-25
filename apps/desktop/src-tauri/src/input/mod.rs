use crate::capture;
use crate::db::DbState;
use crate::overlay::{self, OverlayState};
use crate::screenday::ScreenDayState;
use crate::types::{RectPx, Settings};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static HOOKS_ACTIVE: AtomicBool = AtomicBool::new(false);
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutActionPayload {
    pub action: String,
    pub active: bool,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShortcutDescriptor {
    pub action: &'static str,
    pub keys: &'static str,
    pub description: &'static str,
    pub modifiers: Modifiers,
    pub code: Code,
}

pub const GLOBAL_SHORTCUTS: &[ShortcutDescriptor] = &[
    ShortcutDescriptor {
        action: "toggle_bar",
        keys: "Ctrl+Space",
        description: "Toggle floating bar visibility and focus",
        modifiers: Modifiers::CONTROL,
        code: Code::Space,
    },
    ShortcutDescriptor {
        action: "toggle_bar_only",
        keys: "Ctrl+Alt+H",
        description: "Hide or show top bar (companion-only mode)",
        modifiers: Modifiers::from_bits_truncate(Modifiers::CONTROL.bits() | Modifiers::ALT.bits()),
        code: Code::KeyH,
    },
    ShortcutDescriptor {
        action: "toggle_mic",
        keys: "Ctrl+Alt+M",
        description: "Toggle Mic On/Off",
        modifiers: Modifiers::from_bits_truncate(Modifiers::CONTROL.bits() | Modifiers::ALT.bits()),
        code: Code::KeyM,
    },
    ShortcutDescriptor {
        action: "toggle_live",
        keys: "Ctrl+Alt+L",
        description: "Toggle Live Guidance Session",
        modifiers: Modifiers::from_bits_truncate(Modifiers::CONTROL.bits() | Modifiers::ALT.bits()),
        code: Code::KeyL,
    },
    ShortcutDescriptor {
        action: "toggle_day",
        keys: "Ctrl+Alt+D",
        description: "Toggle Screen Day Recording",
        modifiers: Modifiers::from_bits_truncate(Modifiers::CONTROL.bits() | Modifiers::ALT.bits()),
        code: Code::KeyD,
    },
    ShortcutDescriptor {
        action: "use_local",
        keys: "Ctrl+Alt+O",
        description: "Switch brain mode to Use Local (local_vlm)",
        modifiers: Modifiers::from_bits_truncate(Modifiers::CONTROL.bits() | Modifiers::ALT.bits()),
        code: Code::KeyO,
    },
    ShortcutDescriptor {
        action: "use_agent",
        keys: "Ctrl+Alt+A",
        description: "Switch brain mode to Use Agent (agent_cli)",
        modifiers: Modifiers::from_bits_truncate(Modifiers::CONTROL.bits() | Modifiers::ALT.bits()),
        code: Code::KeyA,
    },
];

pub fn build_shortcut_action_payload(
    action: &str,
    active: bool,
    label: &str,
) -> ShortcutActionPayload {
    ShortcutActionPayload {
        action: action.to_string(),
        active,
        label: label.to_string(),
    }
}

pub fn compute_next_mic_state(settings: &mut Settings) -> (bool, ShortcutActionPayload) {
    let next = !settings.voice_enabled;
    settings.voice_enabled = next;
    let label = if next { "Mic On" } else { "Mic Off" };
    (next, build_shortcut_action_payload("toggle_mic", next, label))
}

pub fn compute_next_day_state(
    settings: &mut Settings,
    current_enabled: bool,
) -> (bool, ShortcutActionPayload) {
    let next = !current_enabled;
    settings.screenday_enabled = next;
    let label = if next { "Day On" } else { "Day Off" };
    (next, build_shortcut_action_payload("toggle_day", next, label))
}

pub fn apply_brain_mode_shortcut(
    settings: &mut Settings,
    brain_mode: &str,
    action: &str,
    label: &str,
) -> ShortcutActionPayload {
    settings.brain_mode = brain_mode.to_string();
    build_shortcut_action_payload(action, true, label)
}

fn emit_shortcut_action(app: &AppHandle, payload: &ShortcutActionPayload) {
    let _ = app.emit("shortcut-action", payload);
}

/// Extra hit-test padding (physical px) around `rect_px` to accommodate DPI rounding and small icons.
pub const CLICK_HIT_PADDING_PX: i32 = 28;

/// Pure hit-test function for smart auto-advance when a left-click occurs at `(click_x, click_y)`.
pub fn should_auto_advance_on_click(target_rect: Option<RectPx>, click_x: i32, click_y: i32) -> bool {
    match target_rect {
        Some(rect) if rect.w > 0 && rect.h > 0 => {
            let min_x = rect.x.saturating_sub(CLICK_HIT_PADDING_PX);
            let max_x = rect.x.saturating_add(rect.w).saturating_add(CLICK_HIT_PADDING_PX);
            let min_y = rect.y.saturating_sub(CLICK_HIT_PADDING_PX);
            let max_y = rect.y.saturating_add(rect.h).saturating_add(CLICK_HIT_PADDING_PX);
            click_x >= min_x && click_x <= max_x && click_y >= min_y && click_y <= max_y
        }
        _ => false,
    }
}

/// Pure predicate checking whether the foreground HWND or window title changed after a click outside `rect_px`.
pub fn has_foreground_window_changed(
    baseline_hwnd: isize,
    baseline_title: &str,
    before_hwnd: isize,
    before_title: &str,
    after_hwnd: isize,
    after_title: &str,
) -> bool {
    if after_hwnd != before_hwnd || after_title != before_title {
        return true;
    }
    baseline_hwnd != 0 && (after_hwnd != baseline_hwnd || after_title != baseline_title)
}

/// Toggles or focuses the floating `bar` window (<100ms) and emits `bar-summoned` when shown/focused.
/// When hiding `bar`, keeps the active overlay companion / live session alive on screen.
pub fn toggle_bar_window(app: &AppHandle) {
    if let Some(bar) = app.get_webview_window("bar") {
        let is_visible = bar.is_visible().unwrap_or(false);
        let is_focused = bar.is_focused().unwrap_or(false);

        if is_visible && is_focused {
            let _ = bar.hide();
        } else {
            capture::remember_foreground_window();
            let _ = bar.unminimize();
            let _ = bar.show();
            let _ = bar.set_focus();
            let _ = app.emit("bar-summoned", ());
        }
    }
}

/// Companion-Only Bar Toggle: hides or shows the floating `bar` while keeping the overlay
/// companion visible alone on screen when hidden. Returns `true` if `bar` is now hidden.
#[tauri::command]
pub fn toggle_bar_only(app: AppHandle) -> Result<bool, String> {
    let hidden = if let Some(bar) = app.get_webview_window("bar") {
        let is_visible = bar.is_visible().unwrap_or(false);
        if is_visible {
            let _ = bar.hide();
            true
        } else {
            capture::remember_foreground_window();
            let _ = bar.unminimize();
            let _ = bar.show();
            let _ = bar.set_focus();
            let _ = app.emit("bar-summoned", ());
            false
        }
    } else {
        !overlay::is_companion_only_mode()
    };

    overlay::set_companion_only_mode(&app, hidden);
    let payload = build_shortcut_action_payload(
        "toggle_bar_only",
        hidden,
        if hidden { "Companion Only" } else { "Bar Shown" },
    );
    emit_shortcut_action(&app, &payload);
    Ok(hidden)
}

fn toggle_mic_from_shortcut(app: &AppHandle) {
    if let Some(db) = app.try_state::<DbState>() {
        let mut settings = db.get_settings().unwrap_or_default();
        let (_next, payload) = compute_next_mic_state(&mut settings);
        if let Err(e) = db.set_settings(&settings) {
            log::warn!("Failed to persist Ctrl+Alt+M mic toggle: {}", e);
        }
        let _ = app.emit("settings-changed", &settings);
        emit_shortcut_action(app, &payload);
    }
}

fn toggle_live_from_shortcut(app: &AppHandle) {
    let currently_active = app
        .try_state::<crate::session::LiveSessionManager>()
        .map(|m| m.is_active())
        .unwrap_or(false);
    let next_expected = !currently_active;
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::session::toggle_live_session_from_tray(app_clone).await;
    });
    let payload = build_shortcut_action_payload("toggle_live", next_expected, "Live");
    emit_shortcut_action(app, &payload);
}

fn toggle_screenday_from_shortcut(app: &AppHandle) {
    if let Some(db) = app.try_state::<DbState>() {
        let mut settings = db.get_settings().unwrap_or_default();
        let current_enabled = app
            .try_state::<ScreenDayState>()
            .map(|sd| sd.is_enabled())
            .unwrap_or(settings.screenday_enabled);
        let (next, payload) = compute_next_day_state(&mut settings, current_enabled);
        if let Some(sd) = app.try_state::<ScreenDayState>() {
            sd.set_enabled(next);
        }
        if let Err(e) = db.set_settings(&settings) {
            log::warn!("Failed to persist Ctrl+Alt+D Screen Day toggle: {}", e);
        }
        overlay::sync_companion_with_settings(app, &settings);
        let _ = app.emit("settings-changed", &settings);
        emit_shortcut_action(app, &payload);
    }
}

fn switch_brain_mode_from_shortcut(
    app: &AppHandle,
    brain_mode: &str,
    action: &str,
    label: &str,
    cue_text: &str,
) {
    if let Some(db) = app.try_state::<DbState>() {
        let mut settings = db.get_settings().unwrap_or_default();
        let payload = apply_brain_mode_shortcut(&mut settings, brain_mode, action, label);
        if let Err(e) = db.set_settings(&settings) {
            log::warn!("Failed to persist {} brain mode switch: {}", action, e);
        }
        let _ = app.emit("settings-changed", &settings);
        emit_shortcut_action(app, &payload);
        overlay::show_companion_cue(app, cue_text);
    }
}

fn register_shortcut_with_warn<F>(
    app: &AppHandle,
    shortcut: Shortcut,
    name: &str,
    handler: F,
) -> bool
where
    F: Fn(&AppHandle) + Send + Sync + 'static,
{
    let app_clone = app.clone();
    match app.global_shortcut().on_shortcut(shortcut, move |_app, _sc, event| {
        if event.state == ShortcutState::Pressed {
            handler(&app_clone);
        }
    }) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("Could not register {} global shortcut: {}", name, e);
            false
        }
    }
}

/// Registers the full global shortcut suite (`Ctrl+Space` with `Ctrl+Shift+Space` fallback,
/// `Ctrl+Alt+H/M/L/D/O/A`). Logs warnings gracefully if any shortcut is already claimed by OS.
pub fn init_input_hooks(app: &AppHandle) -> Result<(), String> {
    let _ = APP_HANDLE.set(app.clone());

    let ctrl_space = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
    if !register_shortcut_with_warn(app, ctrl_space, "Ctrl+Space", toggle_bar_window) {
        let ctrl_shift_space =
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
        register_shortcut_with_warn(
            app,
            ctrl_shift_space,
            "Ctrl+Shift+Space",
            toggle_bar_window,
        );
    }

    let ctrl_alt = Some(Modifiers::CONTROL | Modifiers::ALT);
    register_shortcut_with_warn(
        app,
        Shortcut::new(ctrl_alt, Code::KeyH),
        "Ctrl+Alt+H",
        |a| {
            let _ = toggle_bar_only(a.clone());
        },
    );
    register_shortcut_with_warn(
        app,
        Shortcut::new(ctrl_alt, Code::KeyM),
        "Ctrl+Alt+M",
        toggle_mic_from_shortcut,
    );
    register_shortcut_with_warn(
        app,
        Shortcut::new(ctrl_alt, Code::KeyL),
        "Ctrl+Alt+L",
        toggle_live_from_shortcut,
    );
    register_shortcut_with_warn(
        app,
        Shortcut::new(ctrl_alt, Code::KeyD),
        "Ctrl+Alt+D",
        toggle_screenday_from_shortcut,
    );
    register_shortcut_with_warn(
        app,
        Shortcut::new(ctrl_alt, Code::KeyO),
        "Ctrl+Alt+O",
        |a| {
            switch_brain_mode_from_shortcut(
                a,
                "local_vlm",
                "use_local",
                "Use Local",
                "Switched to Local",
            );
        },
    );
    register_shortcut_with_warn(
        app,
        Shortcut::new(ctrl_alt, Code::KeyA),
        "Ctrl+Alt+A",
        |a| {
            switch_brain_mode_from_shortcut(
                a,
                "agent_cli",
                "use_agent",
                "Use Agent",
                "Switched to Agent",
            );
        },
    );

    Ok(())
}

/// Installs the global `WH_MOUSE_LL` (smart auto-advance) and `WH_KEYBOARD_LL` (Esc clear)
/// hooks while overlay guidance is active.
pub fn ensure_overlay_hooks(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    start_windows_ll_hooks();
}

/// Releases global `WH_MOUSE_LL` and `WH_KEYBOARD_LL` hooks when overlay guidance clears or finishes.
pub fn release_overlay_hooks() {
    stop_input_hooks();
}

/// Releases global hooks only when both static overlay guidance and any Live Session are inactive.
pub fn release_overlay_hooks_if_idle(app: &AppHandle) {
    let overlay_active = app
        .try_state::<OverlayState>()
        .map(|s| s.is_active())
        .unwrap_or(false);
    let session_active = app
        .try_state::<crate::session::LiveSessionManager>()
        .map(|s| s.is_active())
        .unwrap_or(false);
    if !overlay_active && !session_active {
        stop_input_hooks();
    }
}

#[cfg(windows)]
fn start_windows_ll_hooks() {
    if HOOKS_ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::Builder::new()
        .name("guidelens-win32-hooks".to_string())
        .spawn(|| unsafe {
            use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
            use windows::Win32::System::Threading::GetCurrentThreadId;
            use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
            use windows::Win32::UI::WindowsAndMessaging::{
                CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
                UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL,
                WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONUP, WM_SYSKEYDOWN,
            };

            HOOK_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);

            unsafe extern "system" fn mouse_proc(
                code: i32,
                wparam: WPARAM,
                lparam: LPARAM,
            ) -> LRESULT {
                if code >= 0 && wparam.0 as u32 == WM_LBUTTONUP {
                    let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
                    let click_x = info.pt.x;
                    let click_y = info.pt.y;

                    if let Some(app) = APP_HANDLE.get() {
                        let session_guiding = app
                            .try_state::<crate::session::LiveSessionManager>()
                            .map(|s| s.is_guiding())
                            .unwrap_or(false);

                        if session_guiding {
                            let app_clone = app.clone();
                            tauri::async_runtime::spawn(async move {
                                crate::session::notify_user_click(&app_clone, click_x, click_y);
                            });
                        } else if let Some(state) = app.try_state::<OverlayState>() {
                            if state.is_active() {
                                let hit_target = should_auto_advance_on_click(
                                    state.current_rect(),
                                    click_x,
                                    click_y,
                                );
                                let expected_gen = state.guidance_generation();
                                let (baseline_hwnd, baseline_title) = state.target_window();
                                let app_clone = app.clone();

                                tauri::async_runtime::spawn(async move {
                                    if crate::session::is_click_on_own_window(
                                        &app_clone, click_x, click_y,
                                    ) {
                                        return;
                                    }

                                    if hit_target {
                                        // Brief pause (110ms) so target app processes click before clearing/advancing
                                        tokio::time::sleep(Duration::from_millis(110)).await;
                                        let still_same_step = app_clone
                                            .try_state::<OverlayState>()
                                            .is_some_and(|s| {
                                                s.is_active()
                                                    && s.guidance_generation() == expected_gen
                                            });
                                        if still_same_step {
                                            let _ = overlay::advance_step(&app_clone);
                                        }
                                    } else {
                                        let before_win = tokio::task::spawn_blocking(
                                            capture::detect_active_window,
                                        )
                                        .await
                                        .ok();
                                        tokio::time::sleep(Duration::from_millis(240)).await;

                                        let still_same_step = app_clone
                                            .try_state::<OverlayState>()
                                            .is_some_and(|s| {
                                                s.is_active()
                                                    && s.guidance_generation() == expected_gen
                                            });
                                        if !still_same_step {
                                            return;
                                        }

                                        if let Ok(after_win) = tokio::task::spawn_blocking(
                                            capture::detect_active_window,
                                        )
                                        .await
                                        {
                                            let (before_hwnd, before_title) = before_win
                                                .map(|w| (w.hwnd, w.window_title))
                                                .unwrap_or_else(|| {
                                                    (baseline_hwnd, baseline_title.clone())
                                                });
                                            if has_foreground_window_changed(
                                                baseline_hwnd,
                                                &baseline_title,
                                                before_hwnd,
                                                &before_title,
                                                after_win.hwnd,
                                                &after_win.window_title,
                                            ) {
                                                let _ = overlay::advance_step(&app_clone);
                                            }
                                        }
                                    }
                                });
                            }
                        }
                    }
                }
                CallNextHookEx(HHOOK::default(), code, wparam, lparam)
            }

            unsafe extern "system" fn keyboard_proc(
                code: i32,
                wparam: WPARAM,
                lparam: LPARAM,
            ) -> LRESULT {
                let msg = wparam.0 as u32;
                if code >= 0 && (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
                    let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
                    if kb.vkCode == VK_ESCAPE.0 as u32 {
                        if let Some(app) = APP_HANDLE.get() {
                            if let Some(state) = app.try_state::<OverlayState>() {
                                if state.is_active() {
                                    let app_clone = app.clone();
                                    tauri::async_runtime::spawn(async move {
                                        let _ = overlay::clear_overlay_state(&app_clone);
                                    });
                                }
                            }
                        }
                    }
                }
                CallNextHookEx(HHOOK::default(), code, wparam, lparam)
            }

            let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0).ok();
            let kb_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), None, 0).ok();

            let mut msg = MSG::default();
            while HOOKS_ACTIVE.load(Ordering::SeqCst)
                && GetMessageW(&mut msg, None, 0, 0).into()
            {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            if let Some(h) = mouse_hook {
                let _ = UnhookWindowsHookEx(h);
            }
            if let Some(h) = kb_hook {
                let _ = UnhookWindowsHookEx(h);
            }

            HOOK_THREAD_ID.store(0, Ordering::SeqCst);
            HOOKS_ACTIVE.store(false, Ordering::SeqCst);
        })
        .ok();
}

#[cfg(not(windows))]
fn start_windows_ll_hooks() {}

pub fn stop_input_hooks() {
    HOOKS_ACTIVE.store(false, Ordering::SeqCst);
    #[cfg(windows)]
    {
        let tid = HOOK_THREAD_ID.load(Ordering::SeqCst);
        if tid != 0 {
            use windows::Win32::Foundation::{LPARAM, WPARAM};
            use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_auto_advance_on_click() {
        assert_eq!(CLICK_HIT_PADDING_PX, 28);
        let rect = Some(RectPx {
            x: 100,
            y: 200,
            w: 80,
            h: 40,
        });

        // Inside rect & exact edges
        assert!(should_auto_advance_on_click(rect, 140, 220));
        assert!(should_auto_advance_on_click(rect, 100, 200));
        assert!(should_auto_advance_on_click(rect, 180, 240));

        // Within 28px padding (covers DPI rounding and small icons)
        assert!(should_auto_advance_on_click(rect, 99, 220));
        assert!(should_auto_advance_on_click(rect, 72, 220)); // x = 100 - 28
        assert!(should_auto_advance_on_click(rect, 208, 220)); // x = 180 + 28
        assert!(should_auto_advance_on_click(rect, 140, 172)); // y = 200 - 28
        assert!(should_auto_advance_on_click(rect, 140, 268)); // y = 240 + 28
        assert!(should_auto_advance_on_click(rect, 72, 172));
        assert!(should_auto_advance_on_click(rect, 208, 268));

        // >28px outside on all sides
        assert!(!should_auto_advance_on_click(rect, 71, 220));
        assert!(!should_auto_advance_on_click(rect, 209, 220));
        assert!(!should_auto_advance_on_click(rect, 140, 171));
        assert!(!should_auto_advance_on_click(rect, 140, 269));
        assert!(!should_auto_advance_on_click(rect, 71, 171));

        // Negative multi-monitor coordinates
        let neg_rect = Some(RectPx {
            x: -500,
            y: -300,
            w: 32,
            h: 24,
        });
        assert!(should_auto_advance_on_click(neg_rect, -528, -328));
        assert!(!should_auto_advance_on_click(neg_rect, -529, -300));

        // None or invalid dimensions
        assert!(!should_auto_advance_on_click(None, 140, 220));
        assert!(!should_auto_advance_on_click(
            Some(RectPx {
                x: 100,
                y: 200,
                w: 0,
                h: 40,
            }),
            100,
            220
        ));
    }

    #[test]
    fn test_has_foreground_window_changed() {
        // Unchanged
        assert!(!has_foreground_window_changed(
            100, "Chrome", 100, "Chrome", 100, "Chrome"
        ));
        // Changed after click (HWND switched)
        assert!(has_foreground_window_changed(
            100, "Chrome", 100, "Chrome", 200, "Chrome"
        ));
        // Changed after click (title switched on same HWND)
        assert!(has_foreground_window_changed(
            100, "Inbox", 100, "Inbox", 100, "Settings"
        ));
        // Switched before WM_LBUTTONUP fired (before already matches after, differs from baseline)
        assert!(has_foreground_window_changed(
            100, "Chrome", 200, "Notepad", 200, "Notepad"
        ));
        // Headless baseline=0 unchanged
        assert!(!has_foreground_window_changed(0, "", 0, "", 0, ""));
    }

    #[test]
    fn test_global_shortcut_descriptors_and_state_helpers() {
        assert_eq!(GLOBAL_SHORTCUTS.len(), 7);
        let actions: Vec<&str> = GLOBAL_SHORTCUTS.iter().map(|s| s.action).collect();
        assert_eq!(
            actions,
            vec![
                "toggle_bar",
                "toggle_bar_only",
                "toggle_mic",
                "toggle_live",
                "toggle_day",
                "use_local",
                "use_agent",
            ]
        );
        for desc in GLOBAL_SHORTCUTS {
            assert!(!desc.keys.is_empty());
            assert!(!desc.description.is_empty());
            // Ensure Shortcut::new constructs cleanly without panic
            let sc = Shortcut::new(Some(desc.modifiers), desc.code);
            assert_ne!(sc.id(), 0);
        }

        let mut settings = Settings::default();
        assert!(!settings.voice_enabled);
        let (mic_on, mic_payload) = compute_next_mic_state(&mut settings);
        assert!(mic_on);
        assert!(settings.voice_enabled);
        assert_eq!(
            mic_payload,
            ShortcutActionPayload {
                action: "toggle_mic".to_string(),
                active: true,
                label: "Mic On".to_string(),
            }
        );

        let (mic_off, mic_off_payload) = compute_next_mic_state(&mut settings);
        assert!(!mic_off);
        assert_eq!(mic_off_payload.label, "Mic Off");

        let (day_on, day_payload) = compute_next_day_state(&mut settings, false);
        assert!(day_on);
        assert!(settings.screenday_enabled);
        assert_eq!(
            day_payload,
            ShortcutActionPayload {
                action: "toggle_day".to_string(),
                active: true,
                label: "Day On".to_string(),
            }
        );
        let (day_off, day_off_payload) = compute_next_day_state(&mut settings, true);
        assert!(!day_off);
        assert!(!settings.screenday_enabled);
        assert_eq!(day_off_payload.label, "Day Off");

        let local_payload =
            apply_brain_mode_shortcut(&mut settings, "local_vlm", "use_local", "Use Local");
        assert_eq!(settings.brain_mode, "local_vlm");
        assert!(local_payload.active);
        assert_eq!(local_payload.action, "use_local");
        assert_eq!(local_payload.label, "Use Local");

        let agent_payload =
            apply_brain_mode_shortcut(&mut settings, "agent_cli", "use_agent", "Use Agent");
        assert_eq!(settings.brain_mode, "agent_cli");
        assert!(agent_payload.active);
        assert_eq!(agent_payload.action, "use_agent");
        assert_eq!(agent_payload.label, "Use Agent");
    }
}
