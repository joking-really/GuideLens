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

/// Pure hit-test function for smart auto-advance when a left-click occurs at `(click_x, click_y)`.
pub fn should_auto_advance_on_click(target_rect: Option<RectPx>, click_x: i32, click_y: i32) -> bool {
    match target_rect {
        Some(rect) if rect.w > 0 && rect.h > 0 => rect.contains(click_x, click_y),
        _ => false,
    }
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
                        if let Some(state) = app.try_state::<OverlayState>() {
                            if should_auto_advance_on_click(state.current_rect(), click_x, click_y)
                            {
                                let app_clone = app.clone();
                                tauri::async_runtime::spawn(async move {
                                    // Brief pause (120ms, within <=500ms budget) so target app processes click
                                    tokio::time::sleep(Duration::from_millis(120)).await;
                                    let _ = overlay::advance_step(&app_clone);
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
        let rect = Some(RectPx {
            x: 100,
            y: 200,
            w: 80,
            h: 40,
        });

        assert!(should_auto_advance_on_click(rect, 140, 220));
        assert!(should_auto_advance_on_click(rect, 100, 200));
        assert!(should_auto_advance_on_click(rect, 180, 240));
        assert!(!should_auto_advance_on_click(rect, 99, 220));
        assert!(!should_auto_advance_on_click(rect, 181, 220));
        assert!(!should_auto_advance_on_click(rect, 140, 241));
        assert!(!should_auto_advance_on_click(None, 140, 220));
    }
}
