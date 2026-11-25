//! Pure-Rust ~480p Sobel gradient + connected-component detector for unlabeled icon/pill buttons.

use crate::grounding::GroundingCandidate;
use crate::types::{GroundedElementSource, MonitorInfo, RectPx};
use image::RgbaImage;

const TARGET_DOWNSAMPLE_HEIGHT: u32 = 480;
const SOBEL_THRESHOLD: i32 = 88;
const MIN_BOX_W: i32 = 18;
const MAX_BOX_W: i32 = 260;
const MIN_BOX_H: i32 = 18;
const MAX_BOX_H: i32 = 72;
const MAX_VISION_CANDIDATES: usize = 40;

#[derive(Debug, Clone)]
struct VisionBoxScored {
    rect: RectPx,
    score: f32,
}

/// Detects enclosed icon / pill button regions (`18..260px` wide x `18..72px` tall in physical
/// pixels) via ~480p downsampled Sobel edges and 3x3 morphological bridging.
pub fn detect_vision_boxes(img: &RgbaImage, monitor: &MonitorInfo) -> Vec<GroundingCandidate> {
    let orig_w = img.width();
    let orig_h = img.height();
    if orig_w < 24 || orig_h < 24 {
        return Vec::new();
    }

    let (dw, dh) = if orig_h > TARGET_DOWNSAMPLE_HEIGHT {
        let ratio = TARGET_DOWNSAMPLE_HEIGHT as f64 / orig_h as f64;
        (
            ((orig_w as f64 * ratio).round() as usize).max(16),
            TARGET_DOWNSAMPLE_HEIGHT as usize,
        )
    } else {
        (orig_w as usize, orig_h as usize)
    };

    let inv_scale_x = orig_w as f64 / dw as f64;
    let inv_scale_y = orig_h as f64 / dh as f64;

    // 1. Grayscale downsample using integer Rec.601 luminance.
    let raw = img.as_raw();
    let ow = orig_w as usize;
    let oh = orig_h as usize;
    let mut gray = vec![0u8; dw * dh];
    for y in 0..dh {
        let sy = ((y as f64 + 0.5) * inv_scale_y).floor() as usize;
        let sy = sy.min(oh - 1);
        let row_offset = sy * ow;
        for x in 0..dw {
            let sx = ((x as f64 + 0.5) * inv_scale_x).floor() as usize;
            let sx = sx.min(ow - 1);
            let idx = (row_offset + sx) * 4;
            let r = raw[idx] as u32;
            let g = raw[idx + 1] as u32;
            let b = raw[idx + 2] as u32;
            gray[y * dw + x] = ((299 * r + 587 * g + 114 * b) / 1000) as u8;
        }
    }

    // 2. Sobel L1 gradient magnitude thresholded into binary edge map.
    let mut edges = vec![0u8; dw * dh];
    for y in 1..(dh - 1) {
        let row_m1 = (y - 1) * dw;
        let row_0 = y * dw;
        let row_p1 = (y + 1) * dw;
        for x in 1..(dw - 1) {
            let p00 = gray[row_m1 + x - 1] as i32;
            let p01 = gray[row_m1 + x] as i32;
            let p02 = gray[row_m1 + x + 1] as i32;
            let p10 = gray[row_0 + x - 1] as i32;
            let p12 = gray[row_0 + x + 1] as i32;
            let p20 = gray[row_p1 + x - 1] as i32;
            let p21 = gray[row_p1 + x] as i32;
            let p22 = gray[row_p1 + x + 1] as i32;

            let gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;
            let gy = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;
            if gx.abs() + gy.abs() >= SOBEL_THRESHOLD {
                edges[row_0 + x] = 1;
            }
        }
    }

    // 3. 3x3 dilation bridges small gaps in icon glyphs and rounded pill borders.
    let mut dilated = vec![0u8; dw * dh];
    for y in 1..(dh - 1) {
        for x in 1..(dw - 1) {
            if edges[y * dw + x] == 0 {
                continue;
            }
            for dy in -1isize..=1 {
                let yy = (y as isize + dy) as usize;
                let base = yy * dw;
                dilated[base + x - 1] = 1;
                dilated[base + x] = 1;
                dilated[base + x + 1] = 1;
            }
        }
    }

    // 4. Connected components (iterative DFS to avoid recursion overhead/stack overflow).
    let mut visited = vec![0u8; dw * dh];
    let mut stack: Vec<(usize, usize)> = Vec::with_capacity(256);
    let mut scored: Vec<VisionBoxScored> = Vec::new();

    for sy in 1..(dh - 1) {
        for sx in 1..(dw - 1) {
            let start_idx = sy * dw + sx;
            if dilated[start_idx] == 0 || visited[start_idx] != 0 {
                continue;
            }
            visited[start_idx] = 1;
            stack.push((sx, sy));

            let mut min_x = sx;
            let mut max_x = sx;
            let mut min_y = sy;
            let mut max_y = sy;
            let mut raw_edge_count = 0usize;

            while let Some((cx, cy)) = stack.pop() {
                if cx < min_x {
                    min_x = cx;
                }
                if cx > max_x {
                    max_x = cx;
                }
                if cy < min_y {
                    min_y = cy;
                }
                if cy > max_y {
                    max_y = cy;
                }
                if edges[cy * dw + cx] != 0 {
                    raw_edge_count += 1;
                }

                let x_lo = cx.saturating_sub(1);
                let x_hi = (cx + 1).min(dw - 1);
                let y_lo = cy.saturating_sub(1);
                let y_hi = (cy + 1).min(dh - 1);

                for ny in y_lo..=y_hi {
                    let row = ny * dw;
                    for nx in x_lo..=x_hi {
                        let nidx = row + nx;
                        if dilated[nidx] != 0 && visited[nidx] == 0 {
                            visited[nidx] = 1;
                            stack.push((nx, ny));
                        }
                    }
                }
            }

            let comp_w = max_x - min_x + 1;
            let comp_h = max_y - min_y + 1;
            let phys_x = monitor.x + (min_x as f64 * inv_scale_x).floor() as i32;
            let phys_y = monitor.y + (min_y as f64 * inv_scale_y).floor() as i32;
            let phys_w = ((comp_w as f64) * inv_scale_x).ceil() as i32;
            let phys_h = ((comp_h as f64) * inv_scale_y).ceil() as i32;

            if !(MIN_BOX_W..=MAX_BOX_W).contains(&phys_w) || !(MIN_BOX_H..=MAX_BOX_H).contains(&phys_h)
            {
                continue;
            }

            let box_area = (comp_w * comp_h).max(1) as f32;
            let edge_density = raw_edge_count as f32 / box_area;
            if edge_density < 0.05 {
                continue;
            }

            let aspect = phys_w as f32 / phys_h as f32;
            if aspect > 9.0 || aspect < 0.35 {
                continue;
            }

            let score = edge_density.min(0.6) * 2.0 + (1.0 / (1.0 + (aspect - 1.6).abs()));
            scored.push(VisionBoxScored {
                rect: RectPx {
                    x: phys_x,
                    y: phys_y,
                    w: phys_w,
                    h: phys_h,
                },
                score,
            });
        }
    }

    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(MAX_VISION_CANDIDATES);

    scored
        .into_iter()
        .map(|b| GroundingCandidate {
            label: "Icon button".to_string(),
            control_type: "Button".to_string(),
            rect_px: b.rect,
            source: GroundedElementSource::Vision,
            is_taskbar: false,
            has_semantic_label: false,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn draw_filled_rect(img: &mut RgbaImage, x: u32, y: u32, w: u32, h: u32, color: Rgba<u8>) {
        for yy in y..(y + h).min(img.height()) {
            for xx in x..(x + w).min(img.width()) {
                img.put_pixel(xx, yy, color);
            }
        }
    }

    #[test]
    fn detects_icon_and_pill_buttons_within_size_bounds_and_skips_giant_boxes() {
        let mut img = RgbaImage::from_pixel(640, 360, Rgba([22, 24, 30, 255]));
        // Small icon button (28x28)
        draw_filled_rect(&mut img, 40, 40, 28, 28, Rgba([235, 238, 245, 255]));
        // Pill button (110x34)
        draw_filled_rect(&mut img, 140, 40, 110, 34, Rgba([64, 156, 255, 255]));
        // Giant panel (420x200) -> should be excluded (>260w and >72h)
        draw_filled_rect(&mut img, 80, 120, 420, 200, Rgba([45, 48, 56, 255]));

        let mon = MonitorInfo {
            x: 0,
            y: 0,
            w: 640,
            h: 360,
            scale: 1.0,
        };

        let boxes = detect_vision_boxes(&img, &mon);
        assert!(
            boxes
                .iter()
                .any(|b| (b.rect_px.x - 40).abs() <= 6 && (b.rect_px.w - 28).abs() <= 8),
            "expected icon button detection, got {:?}",
            boxes
        );
        assert!(
            boxes
                .iter()
                .any(|b| (b.rect_px.x - 140).abs() <= 6 && (b.rect_px.w - 110).abs() <= 10),
            "expected pill button detection, got {:?}",
            boxes
        );
        assert!(
            boxes
                .iter()
                .all(|b| b.rect_px.w <= MAX_BOX_W && b.rect_px.h <= MAX_BOX_H),
            "giant panel must not be emitted: {:?}",
            boxes
        );
    }
}
