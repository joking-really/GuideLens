use crate::types::{MonitorInfo, RectPx};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ColorType, ImageBuffer, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use uuid::Uuid;

static LAST_EXTERNAL_WINDOW: OnceLock<Mutex<Option<ActiveWindowInfo>>> = OnceLock::new();

fn last_external_slot() -> &'static Mutex<Option<ActiveWindowInfo>> {
    LAST_EXTERNAL_WINDOW.get_or_init(|| Mutex::new(None))
}

/// Snapshots the current foreground window if it does not belong to GuideLens itself.
/// Call this right before focusing the floating bar so we remember the target app.
pub fn remember_foreground_window() {
    let info = detect_active_window_raw(false);
    if info.hwnd != 0 {
        if let Ok(mut guard) = last_external_slot().lock() {
            *guard = Some(info);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capture {
    pub image_path: String,
    #[serde(skip)]
    pub jpeg_bytes: Vec<u8>,
    pub image_base64: String,
    pub monitor: MonitorInfo,
    pub active_app: String,
    pub window_title: String,
    pub hwnd: isize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveWindowInfo {
    pub active_app: String,
    pub window_title: String,
    pub hwnd: isize,
    pub center_x: i32,
    pub center_y: i32,
}

#[derive(Debug, Clone)]
pub struct LiveCaptureFrame {
    pub image: RgbaImage,
    pub monitor: MonitorInfo,
    pub active_app: String,
    pub window_title: String,
    pub hwnd: isize,
    pub dhash64: u64,
    pub capture_ms: u64,
}

/// Returns the `%LOCALAPPDATA%\GuideLens\captures` directory, creating it if missing.
pub fn captures_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base.join("GuideLens").join("captures");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Converts a normalized 0..1000 bounding box `[x, y, w, h]` on `monitor` into physical
/// virtual-desktop coordinates (`RectPx`).
pub fn normalized_to_physical(bbox: [f64; 4], monitor: &MonitorInfo) -> RectPx {
    let clamped_x = bbox[0].clamp(0.0, 1000.0);
    let clamped_y = bbox[1].clamp(0.0, 1000.0);
    let clamped_w = bbox[2].clamp(0.0, 1000.0 - clamped_x);
    let clamped_h = bbox[3].clamp(0.0, 1000.0 - clamped_y);

    let mon_w = monitor.w as f64;
    let mon_h = monitor.h as f64;

    RectPx {
        x: monitor.x + ((clamped_x / 1000.0) * mon_w).round() as i32,
        y: monitor.y + ((clamped_y / 1000.0) * mon_h).round() as i32,
        w: ((clamped_w / 1000.0) * mon_w).round() as i32,
        h: ((clamped_h / 1000.0) * mon_h).round() as i32,
    }
}

/// Converts physical virtual-desktop pixel coordinates back to 0..1000 normalized coordinates
/// relative to `monitor`.
pub fn physical_to_normalized(rect: RectPx, monitor: &MonitorInfo) -> [f64; 4] {
    let mon_w = (monitor.w.max(1)) as f64;
    let mon_h = (monitor.h.max(1)) as f64;

    let nx = (((rect.x - monitor.x) as f64 / mon_w) * 1000.0).clamp(0.0, 1000.0);
    let ny = (((rect.y - monitor.y) as f64 / mon_h) * 1000.0).clamp(0.0, 1000.0);
    let nw = ((rect.w.max(0) as f64 / mon_w) * 1000.0).clamp(0.0, 1000.0 - nx);
    let nh = ((rect.h.max(0) as f64 / mon_h) * 1000.0).clamp(0.0, 1000.0 - ny);

    [nx, ny, nw, nh]
}

/// Helper to build a `MonitorInfo` from logical coordinates and a Windows DPI scale factor
/// (e.g., 1.0 = 100%, 1.25 = 125%, 1.5 = 150%, 2.0 = 200%).
pub fn monitor_from_logical(
    logical_x: i32,
    logical_y: i32,
    logical_w: u32,
    logical_h: u32,
    scale: f64,
) -> MonitorInfo {
    let safe_scale = if scale > 0.0 { scale } else { 1.0 };
    MonitorInfo {
        x: (logical_x as f64 * safe_scale).round() as i32,
        y: (logical_y as f64 * safe_scale).round() as i32,
        w: (logical_w as f64 * safe_scale).round() as u32,
        h: (logical_h as f64 * safe_scale).round() as u32,
        scale: safe_scale,
    }
}

/// Detects the current foreground target window executable name, title, HWND, and center coordinates.
/// Skips GuideLens's own windows so asking from the floating bar still targets the underlying app.
pub fn detect_active_window() -> ActiveWindowInfo {
    let info = detect_active_window_raw(true);
    if info.hwnd != 0 {
        return info;
    }
    if let Ok(guard) = last_external_slot().lock() {
        if let Some(ref prev) = *guard {
            return prev.clone();
        }
    }
    ActiveWindowInfo {
        active_app: "explorer.exe".to_string(),
        window_title: "Desktop".to_string(),
        hwnd: 0,
        center_x: 0,
        center_y: 0,
    }
}

#[cfg(windows)]
fn inspect_hwnd(hwnd: windows::Win32::Foundation::HWND) -> Option<(u32, ActiveWindowInfo)> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, RECT};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        if hwnd.0.is_null() {
            return None;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w < 40 || h < 40 {
            return None;
        }

        let mut title_buf = [0u16; 512];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        let window_title = if title_len > 0 {
            String::from_utf16_lossy(&title_buf[..title_len as usize])
        } else {
            String::new()
        };

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut active_app = "unknown.exe".to_string();

        if pid != 0 {
            if let Ok(proc_handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut path_buf = [0u16; 1024];
                let mut size = path_buf.len() as u32;
                if QueryFullProcessImageNameW(
                    proc_handle,
                    PROCESS_NAME_WIN32,
                    PWSTR(path_buf.as_mut_ptr()),
                    &mut size,
                )
                .is_ok()
                    && size > 0
                {
                    let full_path = String::from_utf16_lossy(&path_buf[..size as usize]);
                    if let Some(exe_name) = std::path::Path::new(&full_path)
                        .file_name()
                        .and_then(|n| n.to_str())
                    {
                        active_app = exe_name.to_string();
                    }
                }
                let _ = CloseHandle(proc_handle);
            }
        }

        Some((
            pid,
            ActiveWindowInfo {
                active_app,
                window_title,
                hwnd: hwnd.0 as isize,
                center_x: rect.left + w / 2,
                center_y: rect.top + h / 2,
            },
        ))
    }
}

#[cfg(windows)]
fn detect_active_window_raw(walk_z_order: bool) -> ActiveWindowInfo {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindow, GetWindowLongPtrW, IsWindowVisible, GWL_EXSTYLE,
        GW_HWNDNEXT, WS_EX_TOOLWINDOW,
    };

    let self_pid = std::process::id();

    unsafe {
        let mut cur = GetForegroundWindow();
        if let Some((pid, info)) = inspect_hwnd(cur) {
            if pid != self_pid {
                return info;
            }
        }

        if !walk_z_order {
            return ActiveWindowInfo {
                active_app: String::new(),
                window_title: String::new(),
                hwnd: 0,
                center_x: 0,
                center_y: 0,
            };
        }

        let mut steps = 0usize;
        while !cur.0.is_null() && steps < 64 {
            steps += 1;
            let Ok(next) = GetWindow(cur, GW_HWNDNEXT) else {
                break;
            };
            cur = next;
            if cur.0.is_null() || !IsWindowVisible(cur).as_bool() {
                continue;
            }
            let ex_style = GetWindowLongPtrW(cur, GWL_EXSTYLE) as u32;
            if (ex_style & WS_EX_TOOLWINDOW.0) != 0 {
                continue;
            }
            if let Some((pid, info)) = inspect_hwnd(cur) {
                if pid != self_pid && !info.window_title.is_empty() {
                    return info;
                }
            }
        }
    }

    ActiveWindowInfo {
        active_app: String::new(),
        window_title: String::new(),
        hwnd: 0,
        center_x: 0,
        center_y: 0,
    }
}

#[cfg(not(windows))]
fn detect_active_window_raw(_walk_z_order: bool) -> ActiveWindowInfo {
    ActiveWindowInfo {
        active_app: "unknown.exe".to_string(),
        window_title: String::new(),
        hwnd: 0,
        center_x: 0,
        center_y: 0,
    }
}

fn capture_active_monitor_rgba() -> Result<(RgbaImage, MonitorInfo, ActiveWindowInfo), String> {
    let win_info = detect_active_window();
    let monitors = xcap::Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {}", e))?;

    let target_monitor = monitors
        .iter()
        .find(|m| {
            let mx = m.x();
            let my = m.y();
            let mw = m.width() as i32;
            let mh = m.height() as i32;
            win_info.center_x >= mx
                && win_info.center_x < mx + mw
                && win_info.center_y >= my
                && win_info.center_y < my + mh
        })
        .or_else(|| monitors.iter().find(|m| m.is_primary()))
        .or_else(|| monitors.first());

    let (rgba_img, monitor_info) = if let Some(mon) = target_monitor {
        let captured = mon
            .capture_image()
            .map_err(|e| format!("xcap screen capture failed: {}", e))?;
        let w = captured.width();
        let h = captured.height();
        let raw = captured.into_raw();
        let buf: RgbaImage = ImageBuffer::from_raw(w, h, raw)
            .ok_or_else(|| "Failed to construct RGBA image buffer".to_string())?;
        let scale = mon.scale_factor() as f64;
        (
            buf,
            MonitorInfo {
                x: mon.x(),
                y: mon.y(),
                w,
                h,
                scale: if scale > 0.0 { scale } else { 1.0 },
            },
        )
    } else {
        // Headless fallback (e.g. CI without physical display)
        let buf: RgbaImage = ImageBuffer::from_pixel(1920, 1080, Rgba([24, 24, 28, 255]));
        (buf, MonitorInfo::default())
    };

    Ok((rgba_img, monitor_info, win_info))
}

pub(crate) fn encode_rgba_as_jpeg(img: &RgbaImage, quality: u8) -> Result<Vec<u8>, String> {
    let w = img.width();
    let h = img.height();
    if w == 0 || h == 0 {
        return Err("Cannot JPEG-encode an empty image".to_string());
    }
    let mut rgb = Vec::with_capacity((w as usize) * (h as usize) * 3);
    for px in img.pixels() {
        rgb.push(px[0]);
        rgb.push(px[1]);
        rgb.push(px[2]);
    }
    let mut jpeg_bytes = Vec::with_capacity((w as usize * h as usize) / 4);
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, quality.clamp(1, 100));
    encoder
        .encode(&rgb, w, h, ColorType::Rgb8.into())
        .map_err(|e| format!("JPEG encode failed: {}", e))?;
    Ok(jpeg_bytes)
}

/// Resizes `img` proportionally only if larger than `(max_w, max_h)`.
pub(crate) fn resize_within_bounds(img: &RgbaImage, max_w: u32, max_h: u32) -> Cow<'_, RgbaImage> {
    let w = img.width();
    let h = img.height();
    if w == 0 || h == 0 || (max_w == 0 && max_h == 0) {
        return Cow::Borrowed(img);
    }
    let scale_x = if max_w > 0 && w > max_w {
        max_w as f64 / w as f64
    } else {
        1.0
    };
    let scale_y = if max_h > 0 && h > max_h {
        max_h as f64 / h as f64
    } else {
        1.0
    };
    let scale = scale_x.min(scale_y);
    if scale >= 1.0 {
        return Cow::Borrowed(img);
    }
    let new_w = ((w as f64 * scale).round() as u32).max(1);
    let new_h = ((h as f64 * scale).round() as u32).max(1);
    Cow::Owned(image::imageops::resize(img, new_w, new_h, FilterType::Triangle))
}

/// Computes a fast 64-bit difference hash (dHash) over a 9x8 luma grid.
pub fn compute_dhash64(img: &RgbaImage) -> u64 {
    let w = img.width() as usize;
    let h = img.height() as usize;
    if w == 0 || h == 0 {
        return 0;
    }

    let raw = img.as_raw();
    let mut grid = [[0u32; 9]; 8];

    for (gy, row) in grid.iter_mut().enumerate() {
        let y0 = ((gy * h) / 8).min(h - 1);
        let y1 = (((gy + 1) * h) / 8).max(y0 + 1).min(h);
        let step_y = ((y1 - y0) / 4).max(1);

        for (gx, cell) in row.iter_mut().enumerate() {
            let x0 = ((gx * w) / 9).min(w - 1);
            let x1 = (((gx + 1) * w) / 9).max(x0 + 1).min(w);
            let step_x = ((x1 - x0) / 4).max(1);

            let mut sum = 0u64;
            let mut count = 0u64;
            let mut y = y0;
            while y < y1 {
                let row_off = y * w;
                let mut x = x0;
                while x < x1 {
                    let idx = (row_off + x) * 4;
                    let r = raw[idx] as u64;
                    let g = raw[idx + 1] as u64;
                    let b = raw[idx + 2] as u64;
                    // ITU-R BT.601 integer luma scaled by 256
                    sum += 77 * r + 150 * g + 29 * b;
                    count += 1;
                    x += step_x;
                }
                y += step_y;
            }
            *cell = (sum / count.max(1)) as u32;
        }
    }

    let mut hash = 0u64;
    for (gy, row) in grid.iter().enumerate() {
        for gx in 0..8 {
            if row[gx] < row[gx + 1] {
                hash |= 1u64 << (gy * 8 + gx);
            }
        }
    }
    hash
}

/// Formats a 64-bit dHash as a fixed 16-character lowercase hex string.
pub fn dhash_to_hex(hash: u64) -> String {
    format!("{:016x}", hash)
}

/// Returns the Hamming distance (differing bit count) between two 64-bit dHashes.
pub fn hamming_distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Returns the Hamming distance between two hex-encoded 64-bit dHashes.
/// Missing or malformed hex strings return `64` so initial frames always treat content as changed.
pub fn hamming_distance_hex(a: &str, b: &str) -> u32 {
    let Ok(ua) = u64::from_str_radix(a.trim(), 16) else {
        return 64;
    };
    let Ok(ub) = u64::from_str_radix(b.trim(), 16) else {
        return 64;
    };
    (ua ^ ub).count_ones()
}

/// Resizes `img` to fit within `max_dim` (if > 0) and encodes as JPEG + base64.
pub fn encode_resized_jpeg_base64(
    img: &RgbaImage,
    max_dim: u32,
    quality: u8,
) -> Result<(Vec<u8>, String), String> {
    let resized = resize_within_bounds(img, max_dim, max_dim);
    let q = if quality == 0 { 78 } else { quality.clamp(1, 100) };
    let jpeg_bytes = encode_rgba_as_jpeg(resized.as_ref(), q)?;
    let b64 = BASE64.encode(&jpeg_bytes);
    Ok((jpeg_bytes, b64))
}

/// Encodes an ultra-compressed Screen Day JPEG frame (defaults to 1280px max width, quality 52).
pub fn encode_compressed_day_frame(
    img: &RgbaImage,
    max_width: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let target_w = if max_width == 0 { 1280 } else { max_width };
    let q = if quality == 0 { 52 } else { quality.clamp(1, 100) };
    let resized = resize_within_bounds(img, target_w, 0);
    encode_rgba_as_jpeg(resized.as_ref(), q)
}

/// Writes `bytes` to `path` on a background blocking thread without stalling the live pipeline.
pub fn save_bytes_async(path: PathBuf, bytes: Vec<u8>) {
    let write_fn = move || {
        if let Some(parent) = path.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                log::warn!("save_bytes_async failed creating dir {:?}: {}", parent, e);
                return;
            }
        }
        if let Err(e) = fs::write(&path, &bytes) {
            log::warn!("save_bytes_async failed writing {:?}: {}", path, e);
        }
    };
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn_blocking(write_fn);
    } else {
        std::thread::spawn(write_fn);
    }
}

/// Captures the active monitor into memory with zero disk I/O for low-latency live grounding.
pub fn capture_for_live_grounding(_app: Option<&AppHandle>) -> Result<LiveCaptureFrame, String> {
    let started = Instant::now();
    let (image, monitor, win_info) = capture_active_monitor_rgba()?;
    let dhash64 = compute_dhash64(&image);
    let capture_ms = started.elapsed().as_millis() as u64;

    Ok(LiveCaptureFrame {
        image,
        monitor,
        active_app: win_info.active_app,
        window_title: win_info.window_title,
        hwnd: win_info.hwnd,
        dhash64,
        capture_ms,
    })
}

/// Captures the active monitor with `xcap`, compresses as JPEG (quality 82 for <80ms speed),
/// saves to `%LOCALAPPDATA%\GuideLens\captures`, and returns `Capture`.
pub fn capture_active(_app: &AppHandle) -> Result<Capture, String> {
    capture_active_screen()
}

pub fn capture_active_screen() -> Result<Capture, String> {
    let (rgba_img, monitor_info, win_info) = capture_active_monitor_rgba()?;
    let jpeg_bytes = encode_rgba_as_jpeg(&rgba_img, 82)?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let filename = format!("capture_{}_{}.jpg", ts, Uuid::new_v4().simple());
    let file_path = captures_dir().join(filename);
    fs::write(&file_path, &jpeg_bytes)
        .map_err(|e| format!("Failed to write capture file {:?}: {}", file_path, e))?;

    let image_path = file_path.to_string_lossy().to_string();
    let image_base64 = BASE64.encode(&jpeg_bytes);

    Ok(Capture {
        image_path,
        jpeg_bytes,
        image_base64,
        monitor: monitor_info,
        active_app: win_info.active_app,
        window_title: win_info.window_title,
        hwnd: win_info.hwnd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalized_to_physical_1080p_100_dpi() {
        let mon = MonitorInfo {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
            scale: 1.0,
        };
        let rect = normalized_to_physical([500.0, 250.0, 100.0, 50.0], &mon);
        assert_eq!(
            rect,
            RectPx {
                x: 960,
                y: 270,
                w: 192,
                h: 54
            }
        );
    }

    #[test]
    fn test_normalized_to_physical_dpi_125_150_200() {
        // 125% DPI on 1920x1080 logical -> 2400x1350 physical
        let mon_125 = monitor_from_logical(0, 0, 1920, 1080, 1.25);
        assert_eq!(mon_125.w, 2400);
        assert_eq!(mon_125.h, 1350);
        let rect_125 = normalized_to_physical([100.0, 200.0, 50.0, 40.0], &mon_125);
        assert_eq!(
            rect_125,
            RectPx {
                x: 240,
                y: 270,
                w: 120,
                h: 54
            }
        );

        // 150% DPI on 1920x1080 logical -> 2880x1620 physical
        let mon_150 = monitor_from_logical(0, 0, 1920, 1080, 1.5);
        assert_eq!(mon_150.w, 2880);
        assert_eq!(mon_150.h, 1620);
        let rect_150 = normalized_to_physical([500.0, 500.0, 250.0, 250.0], &mon_150);
        assert_eq!(
            rect_150,
            RectPx {
                x: 1440,
                y: 810,
                w: 720,
                h: 405
            }
        );

        // 200% DPI (4K 3840x2160 physical)
        let mon_200 = monitor_from_logical(0, 0, 1920, 1080, 2.0);
        assert_eq!(mon_200.w, 3840);
        assert_eq!(mon_200.h, 2160);
        let rect_200 = normalized_to_physical([25.0, 50.0, 10.0, 20.0], &mon_200);
        assert_eq!(
            rect_200,
            RectPx {
                x: 96,
                y: 108,
                w: 38,
                h: 43
            }
        );
    }

    #[test]
    fn test_normalized_to_physical_multi_monitor_offsets() {
        // Left secondary monitor with negative X offset (-1920, 0)
        let left_mon = MonitorInfo {
            x: -1920,
            y: -120,
            w: 1920,
            h: 1080,
            scale: 1.0,
        };
        let rect_left = normalized_to_physical([500.0, 500.0, 100.0, 100.0], &left_mon);
        assert_eq!(
            rect_left,
            RectPx {
                x: -960,
                y: 420,
                w: 192,
                h: 108
            }
        );

        // Right 4K secondary monitor at offset (+2560, 0)
        let right_mon = MonitorInfo {
            x: 2560,
            y: 0,
            w: 3840,
            h: 2160,
            scale: 1.5,
        };
        let rect_right = normalized_to_physical([250.0, 500.0, 50.0, 50.0], &right_mon);
        assert_eq!(
            rect_right,
            RectPx {
                x: 2560 + 960,
                y: 1080,
                w: 192,
                h: 108
            }
        );
    }

    #[test]
    fn test_clamping_and_roundtrip() {
        let mon = MonitorInfo {
            x: 100,
            y: 200,
            w: 2000,
            h: 1000,
            scale: 1.25,
        };
        // Out of bounds values are safely clamped to monitor bounds
        let clamped = normalized_to_physical([-50.0, 900.0, 1200.0, 300.0], &mon);
        assert_eq!(
            clamped,
            RectPx {
                x: 100,
                y: 1100,
                w: 2000,
                h: 100
            }
        );

        let norm = physical_to_normalized(
            RectPx {
                x: 600,
                y: 450,
                w: 200,
                h: 100,
            },
            &mon,
        );
        assert_eq!(norm, [250.0, 250.0, 100.0, 100.0]);
    }

    #[test]
    fn test_dhash64_similarity_and_hex_distance() {
        let make_gradient = |offset: i16, flip: bool| -> RgbaImage {
            ImageBuffer::from_fn(180, 120, |x, y| {
                let base = if flip {
                    255 - ((x * 255) / 180) as i16
                } else {
                    ((x * 200 + y * 55) / 180) as i16
                };
                let v = (base + offset).clamp(0, 255) as u8;
                Rgba([v, v.saturating_sub(10), v, 255])
            })
        };

        let img_a = make_gradient(0, false);
        let img_a_shifted = make_gradient(12, false);
        let img_b = make_gradient(0, true);

        let h_a = compute_dhash64(&img_a);
        let h_a2 = compute_dhash64(&img_a_shifted);
        let h_b = compute_dhash64(&img_b);

        assert_eq!(hamming_distance(h_a, h_a), 0);
        assert!(
            hamming_distance(h_a, h_a2) <= 4,
            "slight brightness shift should keep dHash nearly identical (dist={})",
            hamming_distance(h_a, h_a2)
        );
        assert!(
            hamming_distance(h_a, h_b) >= 24,
            "reversed image gradient must produce large dHash distance (dist={})",
            hamming_distance(h_a, h_b)
        );

        let hex_a = dhash_to_hex(h_a);
        let hex_b = dhash_to_hex(h_b);
        assert_eq!(hex_a.len(), 16);
        assert_eq!(hamming_distance_hex(&hex_a, &hex_a), 0);
        assert_eq!(hamming_distance_hex(&hex_a, &hex_b), hamming_distance(h_a, h_b));
        assert_eq!(hamming_distance_hex("", &hex_a), 64);
        assert_eq!(hamming_distance_hex("not-hex", &hex_b), 64);
    }

    #[test]
    fn test_encode_resized_and_compressed_day_frame() {
        let img: RgbaImage = ImageBuffer::from_fn(1920, 1080, |x, y| {
            Rgba([
                ((x / 8) % 255) as u8,
                ((y / 6) % 255) as u8,
                (((x + y) / 12) % 255) as u8,
                255,
            ])
        });

        let (som_bytes, som_b64) = encode_resized_jpeg_base64(&img, 1344, 78).unwrap();
        assert!(som_bytes.starts_with(&[0xFF, 0xD8, 0xFF]));
        assert!(!som_b64.is_empty());
        let decoded_som = image::load_from_memory(&som_bytes).unwrap();
        assert_eq!(decoded_som.width(), 1344);
        assert_eq!(decoded_som.height(), 756);

        let day_bytes = encode_compressed_day_frame(&img, 1280, 52).unwrap();
        assert!(day_bytes.starts_with(&[0xFF, 0xD8, 0xFF]));
        assert!(day_bytes.len() < som_bytes.len());
        let decoded_day = image::load_from_memory(&day_bytes).unwrap();
        assert_eq!(decoded_day.width(), 1280);
        assert_eq!(decoded_day.height(), 720);
    }

    #[test]
    fn test_save_bytes_async_creates_parent_and_writes() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("nested").join("dir").join("frame.jpg");
        let payload = vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4];
        save_bytes_async(target.clone(), payload.clone());

        let start = Instant::now();
        while !target.exists() && start.elapsed() < std::time::Duration::from_secs(2) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(target.exists(), "async write should create target file");
        assert_eq!(fs::read(&target).unwrap(), payload);
    }
}
