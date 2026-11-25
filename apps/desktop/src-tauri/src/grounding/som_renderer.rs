//! Set-of-Mark (SoM) deduplication, `[1]..[N]` pill badge rendering, JPEG encoding, and prompt table formatting.

use crate::capture::{encode_rgba_as_jpeg, physical_to_normalized, resize_within_bounds};
use crate::grounding::{rect_iou, GroundingCandidate};
use crate::types::{GroundedElement, GroundedElementSource, MonitorInfo, RectPx};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{Rgba, RgbaImage};

pub const SOM_DEDUP_IOU_THRESHOLD: f64 = 0.45;
pub const MAX_SOM_ELEMENTS: usize = 60;
pub const SOM_MAX_IMAGE_DIM: u32 = 1344;
pub const SOM_JPEG_QUALITY: u8 = 78;

/// Built-in 5x7 bitmap glyphs (5 bits wide, 7 rows tall) so badge rendering never depends on external fonts.
fn glyph_5x7(ch: char) -> Option<[u8; 7]> {
    match ch {
        '0' => Some([0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110]),
        '1' => Some([0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110]),
        '2' => Some([0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111]),
        '3' => Some([0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110]),
        '4' => Some([0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010]),
        '5' => Some([0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110]),
        '6' => Some([0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110]),
        '7' => Some([0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000]),
        '8' => Some([0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110]),
        '9' => Some([0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110]),
        '[' => Some([0b01110, 0b01000, 0b01000, 0b01000, 0b01000, 0b01000, 0b01110]),
        ']' => Some([0b01110, 0b00010, 0b00010, 0b00010, 0b00010, 0b00010, 0b01110]),
        _ => None,
    }
}

fn source_priority(source: GroundedElementSource) -> u8 {
    match source {
        GroundedElementSource::Uia => 0,
        GroundedElementSource::Taskbar => 1,
        GroundedElementSource::Ocr => 2,
        GroundedElementSource::Vision => 3,
    }
}

pub(crate) fn source_tag(source: GroundedElementSource) -> &'static str {
    match source {
        GroundedElementSource::Uia => "uia",
        GroundedElementSource::Taskbar => "taskbar",
        GroundedElementSource::Ocr => "ocr",
        GroundedElementSource::Vision => "vision",
    }
}

fn intersection_area(a: RectPx, b: RectPx) -> i64 {
    let x1 = a.x.max(b.x);
    let y1 = a.y.max(b.y);
    let x2 = (a.x + a.w).min(b.x + b.w);
    let y2 = (a.y + a.h).min(b.y + b.h);
    if x2 <= x1 || y2 <= y1 {
        0
    } else {
        (x2 - x1) as i64 * (y2 - y1) as i64
    }
}

fn sanitize_prompt_label(label: &str) -> String {
    let collapsed: String = label.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = collapsed.replace('"', "'");
    if cleaned.chars().count() <= 64 {
        cleaned
    } else {
        let trunc: String = cleaned.chars().take(63).collect();
        format!("{}…", trunc.trim_end())
    }
}

/// Deduplicates raw candidates by `IoU > 0.45` prioritizing `Uia -> Taskbar -> Ocr -> Vision`,
/// enriches unlabeled UIA icon-button stubs with enclosed OCR labels, caps at `MAX_SOM_ELEMENTS`
/// (`60`), and numbers them `[1]..[N]` in natural reading order.
pub fn merge_and_number_candidates(
    mut candidates: Vec<GroundingCandidate>,
    monitor: &MonitorInfo,
) -> Vec<GroundedElement> {
    candidates.retain(|c| c.rect_px.w >= 4 && c.rect_px.h >= 4 && !c.label.trim().is_empty());

    candidates.sort_by(|a, b| {
        source_priority(a.source)
            .cmp(&source_priority(b.source))
            .then_with(|| b.has_semantic_label.cmp(&a.has_semantic_label))
            .then_with(|| {
                let area_a = (a.rect_px.w as i64) * (a.rect_px.h as i64);
                let area_b = (b.rect_px.w as i64) * (b.rect_px.h as i64);
                area_a.cmp(&area_b)
            })
    });

    let mut kept: Vec<GroundingCandidate> = Vec::with_capacity(MAX_SOM_ELEMENTS);

    for cand in candidates {
        if kept.len() >= MAX_SOM_ELEMENTS {
            break;
        }

        let mut duplicated = false;
        let cand_area = (cand.rect_px.w as i64 * cand.rect_px.h as i64).max(1);

        for existing in &mut kept {
            if rect_iou(cand.rect_px, existing.rect_px) > SOM_DEDUP_IOU_THRESHOLD {
                duplicated = true;
                break;
            }

            let inter = intersection_area(cand.rect_px, existing.rect_px);
            if inter <= 0 {
                continue;
            }

            // Vision boxes are strictly for icon/pill buttons not already covered by UIA/Taskbar/OCR.
            if cand.source == GroundedElementSource::Vision {
                let existing_area =
                    (existing.rect_px.w as i64 * existing.rect_px.h as i64).max(1);
                if inter * 100 >= cand_area * 55 || inter * 100 >= existing_area * 75 {
                    duplicated = true;
                    break;
                }
            }

            // If an OCR text span sits tightly inside an already-kept UIA/Taskbar button,
            // upgrade any generic UIA fallback label and suppress the redundant inner OCR badge.
            if cand.source == GroundedElementSource::Ocr
                && matches!(
                    existing.source,
                    GroundedElementSource::Uia | GroundedElementSource::Taskbar
                )
                && existing.rect_px.w <= 320
                && existing.rect_px.h <= 96
                && inter * 100 >= cand_area * 80
            {
                if !existing.has_semantic_label {
                    existing.label = cand.label.clone();
                    existing.has_semantic_label = true;
                }
                duplicated = true;
                break;
            }
        }

        if !duplicated {
            kept.push(cand);
        }
    }

    // Order [1]..[N] top-to-bottom (20px band), left-to-right for predictable visual scanning.
    kept.sort_by(|a, b| {
        let band_a = a.rect_px.y.div_euclid(20);
        let band_b = b.rect_px.y.div_euclid(20);
        band_a
            .cmp(&band_b)
            .then_with(|| a.rect_px.x.cmp(&b.rect_px.x))
            .then_with(|| a.rect_px.y.cmp(&b.rect_px.y))
    });

    kept.into_iter()
        .enumerate()
        .map(|(idx, c)| GroundedElement {
            id: (idx + 1) as u32,
            label: sanitize_prompt_label(&c.label),
            control_type: c.control_type,
            rect_px: c.rect_px,
            norm_bbox: physical_to_normalized(c.rect_px, monitor),
            source: c.source,
            is_taskbar: c.is_taskbar,
        })
        .collect()
}

/// Formats the indexed prompt table, e.g.:
/// `[12] Button "New chat" @(42,88,136x34) [uia]`
pub fn format_element_table_prompt(elements: &[GroundedElement]) -> String {
    elements
        .iter()
        .map(|el| {
            format!(
                "[{}] {} \"{}\" @({},{},{}x{}) [{}]",
                el.id,
                el.control_type,
                sanitize_prompt_label(&el.label),
                el.rect_px.x,
                el.rect_px.y,
                el.rect_px.w,
                el.rect_px.h,
                source_tag(el.source),
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn accent_color(source: GroundedElementSource) -> Rgba<u8> {
    match source {
        GroundedElementSource::Uia | GroundedElementSource::Taskbar => Rgba([250, 204, 21, 255]),
        GroundedElementSource::Ocr => Rgba([34, 211, 238, 255]),
        GroundedElementSource::Vision => Rgba([74, 222, 128, 255]),
    }
}

#[inline]
fn put_pixel_clamped(img: &mut RgbaImage, x: i32, y: i32, color: Rgba<u8>) {
    if x >= 0 && y >= 0 && (x as u32) < img.width() && (y as u32) < img.height() {
        img.put_pixel(x as u32, y as u32, color);
    }
}

fn fill_rect(img: &mut RgbaImage, rect: RectPx, color: Rgba<u8>) {
    let x1 = rect.x.max(0);
    let y1 = rect.y.max(0);
    let x2 = (rect.x + rect.w).min(img.width() as i32);
    let y2 = (rect.y + rect.h).min(img.height() as i32);
    for y in y1..y2 {
        for x in x1..x2 {
            img.put_pixel(x as u32, y as u32, color);
        }
    }
}

fn stroke_rect(img: &mut RgbaImage, rect: RectPx, thickness: i32, color: Rgba<u8>) {
    for t in 0..thickness {
        let left = rect.x + t;
        let top = rect.y + t;
        let right = rect.x + rect.w - 1 - t;
        let bottom = rect.y + rect.h - 1 - t;
        if left > right || top > bottom {
            break;
        }
        for x in left..=right {
            put_pixel_clamped(img, x, top, color);
            put_pixel_clamped(img, x, bottom, color);
        }
        for y in top..=bottom {
            put_pixel_clamped(img, left, y, color);
            put_pixel_clamped(img, right, y, color);
        }
    }
}

fn draw_badge_text(img: &mut RgbaImage, text: &str, start_x: i32, start_y: i32, scale: i32, fg: Rgba<u8>) {
    let mut cursor_x = start_x;
    for ch in text.chars() {
        let Some(rows) = glyph_5x7(ch) else {
            continue;
        };
        let char_cols = if ch == '[' || ch == ']' { 4 } else { 5 };
        for (ry, bits) in rows.iter().enumerate() {
            for col in 0..char_cols {
                let shift = 4 - col;
                if (bits >> shift) & 1 == 1 {
                    let px = cursor_x + col * scale;
                    let py = start_y + (ry as i32) * scale;
                    fill_rect(
                        img,
                        RectPx {
                            x: px,
                            y: py,
                            w: scale,
                            h: scale,
                        },
                        fg,
                    );
                }
            }
        }
        cursor_x += char_cols * scale + scale;
    }
}

fn badge_dimensions(text: &str, scale: i32) -> (i32, i32) {
    let mut text_w = 0i32;
    let char_count = text.chars().count();
    for (idx, ch) in text.chars().enumerate() {
        let cols = if ch == '[' || ch == ']' { 4 } else { 5 };
        text_w += cols * scale;
        if idx + 1 < char_count {
            text_w += scale;
        }
    }
    let pad_x = 3 * scale;
    let pad_y = 2 * scale;
    (text_w + pad_x * 2, 7 * scale + pad_y * 2)
}

fn choose_badge_rect(
    box_rect: RectPx,
    pill_w: i32,
    pill_h: i32,
    img_w: i32,
    img_h: i32,
    placed_badges: &[RectPx],
) -> RectPx {
    let candidates = [
        (box_rect.x, box_rect.y - pill_h - 1),
        (box_rect.x, box_rect.y + 1),
        (box_rect.x, box_rect.y + box_rect.h + 1),
        (box_rect.x + box_rect.w - pill_w, box_rect.y - pill_h - 1),
    ];

    let max_x = (img_w - pill_w).max(0);
    let max_y = (img_h - pill_h).max(0);

    for (cx, cy) in candidates {
        let clamped = RectPx {
            x: cx.clamp(0, max_x),
            y: cy.clamp(0, max_y),
            w: pill_w,
            h: pill_h,
        };
        if !placed_badges
            .iter()
            .any(|p| intersection_area(*p, clamped) > 0)
        {
            return clamped;
        }
    }

    RectPx {
        x: box_rect.x.clamp(0, max_x),
        y: (box_rect.y - pill_h - 1).clamp(0, max_y),
        w: pill_w,
        h: pill_h,
    }
}

/// Renders high-contrast bounding boxes and `[1]..[N]` pill badges onto a resized copy (`<=1344px`)
/// of `raw_img` and encodes the result as JPEG (`quality = 78`) + base64.
pub fn render_som_overlay_and_encode(
    raw_img: &RgbaImage,
    monitor: &MonitorInfo,
    elements: &[GroundedElement],
) -> Result<(Vec<u8>, String, RgbaImage), String> {
    let mut canvas = resize_within_bounds(raw_img, SOM_MAX_IMAGE_DIM, SOM_MAX_IMAGE_DIM).into_owned();
    let img_w = canvas.width() as i32;
    let img_h = canvas.height() as i32;
    if img_w <= 0 || img_h <= 0 {
        return Err("Cannot render SoM on empty image".to_string());
    }

    let mon_w = monitor.w.max(1) as f64;
    let mon_h = monitor.h.max(1) as f64;
    let sx = img_w as f64 / mon_w;
    let sy = img_h as f64 / mon_h;

    let glyph_scale = if img_w >= 900 { 2 } else { 1 };
    let pill_bg = Rgba([15, 23, 42, 240]);
    let pill_fg = Rgba([255, 255, 255, 255]);
    let mut placed_badges: Vec<RectPx> = Vec::with_capacity(elements.len());

    // First pass: draw element borders so pill badges always sit crisply on top.
    let mut scaled_boxes: Vec<(RectPx, &GroundedElement)> = Vec::with_capacity(elements.len());
    for el in elements {
        let bx = ((el.rect_px.x - monitor.x) as f64 * sx).round() as i32;
        let by = ((el.rect_px.y - monitor.y) as f64 * sy).round() as i32;
        let bw = (el.rect_px.w as f64 * sx).round().max(4.0) as i32;
        let bh = (el.rect_px.h as f64 * sy).round().max(4.0) as i32;
        let rect = RectPx {
            x: bx.clamp(0, img_w - 1),
            y: by.clamp(0, img_h - 1),
            w: bw.min((img_w - bx.clamp(0, img_w - 1)).max(1)),
            h: bh.min((img_h - by.clamp(0, img_h - 1)).max(1)),
        };
        stroke_rect(&mut canvas, rect, 2, accent_color(el.source));
        scaled_boxes.push((rect, el));
    }

    // Second pass: draw [id] pill badges with built-in 5x7 bitmap glyphs.
    for (box_rect, el) in scaled_boxes {
        let tag = format!("[{}]", el.id);
        let (pill_w, pill_h) = badge_dimensions(&tag, glyph_scale);
        let badge_rect = choose_badge_rect(box_rect, pill_w, pill_h, img_w, img_h, &placed_badges);
        let border_color = accent_color(el.source);

        fill_rect(&mut canvas, badge_rect, pill_bg);
        stroke_rect(&mut canvas, badge_rect, 1, border_color);
        draw_badge_text(
            &mut canvas,
            &tag,
            badge_rect.x + 3 * glyph_scale,
            badge_rect.y + 2 * glyph_scale,
            glyph_scale,
            pill_fg,
        );
        placed_badges.push(badge_rect);
    }

    let jpeg_bytes = encode_rgba_as_jpeg(&canvas, SOM_JPEG_QUALITY)?;
    let b64 = BASE64.encode(&jpeg_bytes);
    Ok((jpeg_bytes, b64, canvas))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageBuffer;

    #[test]
    fn iou_dedup_prioritizes_uia_then_taskbar_then_ocr_then_vision_and_caps_60() {
        let mon = MonitorInfo::default();
        let rect_same = RectPx {
            x: 100,
            y: 100,
            w: 120,
            h: 36,
        };
        let rect_shifted_high_iou = RectPx {
            x: 108,
            y: 102,
            w: 116,
            h: 34,
        };

        let mut cands = vec![
            GroundingCandidate {
                label: "Vision guess".to_string(),
                control_type: "Button".to_string(),
                rect_px: rect_same,
                source: GroundedElementSource::Vision,
                is_taskbar: false,
                has_semantic_label: false,
            },
            GroundingCandidate {
                label: "OCR New chat".to_string(),
                control_type: "Text".to_string(),
                rect_px: rect_shifted_high_iou,
                source: GroundedElementSource::Ocr,
                is_taskbar: false,
                has_semantic_label: true,
            },
            GroundingCandidate {
                label: "New chat".to_string(),
                control_type: "Button".to_string(),
                rect_px: rect_same,
                source: GroundedElementSource::Uia,
                is_taskbar: false,
                has_semantic_label: true,
            },
        ];

        // Add 70 distinct non-overlapping elements to verify cap at 60.
        for i in 0..70 {
            let col = i % 10;
            let row = i / 10;
            cands.push(GroundingCandidate {
                label: format!("Item {}", i),
                control_type: "Button".to_string(),
                rect_px: RectPx {
                    x: 40 + col * 160,
                    y: 220 + row * 80,
                    w: 110,
                    h: 32,
                },
                source: GroundedElementSource::Taskbar,
                is_taskbar: true,
                has_semantic_label: true,
            });
        }

        let merged = merge_and_number_candidates(cands, &mon);
        assert_eq!(merged.len(), MAX_SOM_ELEMENTS);
        // Element [1] must be the UIA "New chat" at y=100, not OCR or Vision duplicate.
        assert_eq!(merged[0].id, 1);
        assert_eq!(merged[0].label, "New chat");
        assert_eq!(merged[0].source, GroundedElementSource::Uia);
        assert!(merged.iter().all(|e| e.label != "Vision guess" && e.label != "OCR New chat"));
    }

    #[test]
    fn inner_ocr_upgrades_unlabeled_uia_stub() {
        let mon = MonitorInfo::default();
        let cands = vec![
            GroundingCandidate {
                label: "Button".to_string(),
                control_type: "Button".to_string(),
                rect_px: RectPx {
                    x: 40,
                    y: 80,
                    w: 140,
                    h: 36,
                },
                source: GroundedElementSource::Uia,
                is_taskbar: false,
                has_semantic_label: false,
            },
            GroundingCandidate {
                label: "New chat".to_string(),
                control_type: "Text".to_string(),
                rect_px: RectPx {
                    x: 68,
                    y: 88,
                    w: 84,
                    h: 18,
                },
                source: GroundedElementSource::Ocr,
                is_taskbar: false,
                has_semantic_label: true,
            },
        ];

        let merged = merge_and_number_candidates(cands, &mon);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].label, "New chat");
        assert_eq!(merged[0].source, GroundedElementSource::Uia);
    }

    #[test]
    fn som_renders_badges_encodes_1344px_jpeg_and_formats_table() {
        let mon = MonitorInfo {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
            scale: 1.0,
        };
        let raw: RgbaImage = ImageBuffer::from_pixel(1920, 1080, Rgba([22, 26, 34, 255]));
        let elements = vec![GroundedElement {
            id: 12,
            label: "New chat".to_string(),
            control_type: "Button".to_string(),
            rect_px: RectPx {
                x: 42,
                y: 88,
                w: 136,
                h: 34,
            },
            norm_bbox: physical_to_normalized(
                RectPx {
                    x: 42,
                    y: 88,
                    w: 136,
                    h: 34,
                },
                &mon,
            ),
            source: GroundedElementSource::Uia,
            is_taskbar: false,
        }];

        let table = format_element_table_prompt(&elements);
        assert_eq!(table, "[12] Button \"New chat\" @(42,88,136x34) [uia]");

        let (jpeg_bytes, b64, rendered) =
            render_som_overlay_and_encode(&raw, &mon, &elements).unwrap();
        assert!(jpeg_bytes.starts_with(&[0xFF, 0xD8, 0xFF]));
        assert!(!b64.is_empty());
        assert_eq!(rendered.width(), 1344);
        assert_eq!(rendered.height(), 756);

        // Verify badge/border pixels actually modified the canvas near (42, 88) scaled by 0.7 -> (29, 62)
        let mut modified_pixels = 0usize;
        for py in 35..95 {
            for px in 20..130 {
                let p = rendered.get_pixel(px, py);
                if p.0 != [22, 26, 34, 255] {
                    modified_pixels += 1;
                }
            }
        }
        assert!(
            modified_pixels > 150,
            "expected SoM border and bitmap pill badge to draw visible pixels (got {})",
            modified_pixels
        );
    }
}
