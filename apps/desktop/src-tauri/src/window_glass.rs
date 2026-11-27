use crate::db::DbState;
use crate::types::BarPosition;
use tauri::{AppHandle, Manager, PhysicalPosition, State};

/// Clamps `(x, y)` for a window of size `(w, h)` inside the virtual desktop bounds
/// with a 16px safety margin so the floating bar never gets lost off-screen.
pub fn clamp_position_to_virtual_desktop(x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
    let (vx, vy, vw, vh) = crate::overlay::virtual_desktop_bounds();
    let margin = 16;
    let safe_w = w.max(1);
    let safe_h = h.max(1);
    let min_x = vx + margin;
    let min_y = vy + margin;
    let max_x = (vx + vw as i32 - safe_w - margin).max(min_x);
    let max_y = (vy + vh as i32 - safe_h - margin).max(min_y);
    (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

#[cfg(windows)]
#[repr(C)]
struct AccentPolicy {
    accent_state: u32,
    accent_flags: u32,
    gradient_color: u32,
    animation_id: u32,
}

#[cfg(windows)]
#[repr(C)]
struct WindowCompositionAttribData {
    attrib: u32,
    pv_data: *mut std::ffi::c_void,
    cb_data: usize,
}

/// Applies real Windows 10/11 Acrylic frosted glass (`SetWindowCompositionAttribute`)
/// and Win11 rounded corners (`DwmSetWindowAttribute`) to the floating bar window.
pub fn apply_bar_acrylic(
    win: &tauri::WebviewWindow,
    opacity: f64,
    blur_enabled: bool,
    high_contrast: bool,
) {
    let _ = win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));

    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use std::ffi::c_void;
        use windows::core::{s, w};
        use windows::Win32::Foundation::{BOOL, HWND};
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWINDOWATTRIBUTE};
        use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

        const DWMWA_WINDOW_CORNER_PREFERENCE: DWMWINDOWATTRIBUTE = DWMWINDOWATTRIBUTE(33);
        const DWMWCP_ROUND: u32 = 2;
        const WCA_ACCENT_POLICY: u32 = 19;
        const ACCENT_DISABLED: u32 = 0;
        const ACCENT_ENABLE_ACRYLICBLURBEHIND: u32 = 4;

        type SetWindowCompositionAttributeFn =
            unsafe extern "system" fn(HWND, *mut WindowCompositionAttribData) -> BOOL;

        unsafe {
            let raw_hwnd = HWND(hwnd.0 as _);

            // Apply Windows 11 rounded corners
            let corner_pref: u32 = DWMWCP_ROUND;
            let _ = DwmSetWindowAttribute(
                raw_hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &corner_pref as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            );

            // Dynamically resolve SetWindowCompositionAttribute from user32.dll
            if let Ok(user32) = GetModuleHandleW(w!("user32.dll")) {
                if let Some(proc_addr) = GetProcAddress(user32, s!("SetWindowCompositionAttribute"))
                {
                    let set_wca: SetWindowCompositionAttributeFn =
                        std::mem::transmute(proc_addr);

                    let mut policy = if blur_enabled && !high_contrast {
                        let safe_opacity = if opacity.is_finite() {
                            opacity.clamp(0.12, 0.85)
                        } else {
                            0.28
                        };
                        let alpha = ((safe_opacity * 255.0).round() as u8).max(0x1E);
                        // AABBGGRR using obsidian tint 0x0016100E
                        let gradient_color = ((alpha as u32) << 24) | 0x0016100E;
                        AccentPolicy {
                            accent_state: ACCENT_ENABLE_ACRYLICBLURBEHIND,
                            accent_flags: 2,
                            gradient_color,
                            animation_id: 0,
                        }
                    } else {
                        AccentPolicy {
                            accent_state: ACCENT_DISABLED,
                            accent_flags: 0,
                            gradient_color: 0,
                            animation_id: 0,
                        }
                    };

                    let mut data = WindowCompositionAttribData {
                        attrib: WCA_ACCENT_POLICY,
                        pv_data: &mut policy as *mut AccentPolicy as *mut c_void,
                        cb_data: std::mem::size_of::<AccentPolicy>(),
                    };
                    let _ = set_wca(raw_hwnd, &mut data);
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (opacity, blur_enabled, high_contrast);
    }
}

#[tauri::command]
pub fn set_bar_glass(
    app: AppHandle,
    opacity: f64,
    blur_enabled: bool,
    high_contrast: bool,
) -> Result<(), String> {
    let win = app
        .get_webview_window("bar")
        .ok_or_else(|| "Floating bar window not found".to_string())?;
    apply_bar_acrylic(&win, opacity, blur_enabled, high_contrast);
    Ok(())
}

/// Updates `bar_position` directly in SQLite WITHOUT emitting `settings-changed`
/// so dragging the bar never triggers React re-render loops.
#[tauri::command]
pub fn save_bar_position(db: State<'_, DbState>, x: i32, y: i32) -> Result<(), String> {
    let mut settings = db.get_settings()?;
    settings.bar_position = Some(BarPosition { x, y });
    db.set_settings(&settings)
}

#[tauri::command]
pub fn clamp_bar_position(app: AppHandle) -> Result<(i32, i32), String> {
    let win = app
        .get_webview_window("bar")
        .ok_or_else(|| "Floating bar window not found".to_string())?;
    let pos = win
        .outer_position()
        .map_err(|e| format!("Failed to read bar outer position: {}", e))?;
    let size = win
        .outer_size()
        .map_err(|e| format!("Failed to read bar outer size: {}", e))?;
    let (cx, cy) =
        clamp_position_to_virtual_desktop(pos.x, pos.y, size.width as i32, size.height as i32);
    if (cx, cy) != (pos.x, pos.y) {
        let _ = win.set_position(PhysicalPosition::new(cx, cy));
    }
    Ok((cx, cy))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_position_keeps_window_inside_virtual_desktop_with_margin() {
        let (vx, vy, vw, vh) = crate::overlay::virtual_desktop_bounds();
        let (x_min, y_min) = clamp_position_to_virtual_desktop(vx - 500, vy - 500, 640, 54);
        assert_eq!(x_min, vx + 16);
        assert_eq!(y_min, vy + 16);

        let (x_max, y_max) =
            clamp_position_to_virtual_desktop(vx + vw as i32 + 500, vy + vh as i32 + 500, 640, 54);
        assert_eq!(x_max, (vx + vw as i32 - 640 - 16).max(vx + 16));
        assert_eq!(y_max, (vy + vh as i32 - 54 - 16).max(vy + 16));
    }
}
