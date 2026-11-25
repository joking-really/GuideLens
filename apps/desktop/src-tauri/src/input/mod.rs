use crate::capture;
use crate::overlay::{self, OverlayState};
use crate::types::RectPx;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static HOOKS_ACTIVE: AtomicBool = AtomicBool::new(false);
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);

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
pub fn toggle_bar_window(app: &AppHandle) {
    if let Some(bar) = app.get_webview_window("bar") {
        let is_visible = bar.is_visible().unwrap_or(false);
        let is_focused = bar.is_focused().unwrap_or(false);

        if is_visible && is_focused {
            let _ = bar.hide();
            let _ = overlay::clear_overlay_state(app);
        } else {
            capture::remember_foreground_window();
            let _ = bar.unminimize();
            let _ = bar.show();
            let _ = bar.set_focus();
            let _ = app.emit("bar-summoned", ());
        }
    }
}

/// Registers the `Ctrl+Space` global shortcut (`<100ms` summon/focus).
pub fn init_input_hooks(app: &AppHandle) -> Result<(), String> {
    let _ = APP_HANDLE.set(app.clone());

    let ctrl_space = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
    let app_for_shortcut = app.clone();

    let _ = app.global_shortcut().on_shortcut(ctrl_space, move |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            toggle_bar_window(&app_for_shortcut);
        }
    });

    if let Err(e) = app.global_shortcut().register(ctrl_space) {
        log::warn!("Could not register Ctrl+Space global shortcut: {}", e);
        let ctrl_shift_space =
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
        let app_for_fallback = app.clone();
        let _ = app
            .global_shortcut()
            .on_shortcut(ctrl_shift_space, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_bar_window(&app_for_fallback);
                }
            });
        if let Err(fallback_err) = app.global_shortcut().register(ctrl_shift_space) {
            log::warn!(
                "Could not register Ctrl+Shift+Space fallback global shortcut: {}",
                fallback_err
            );
        }
    }

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
}
