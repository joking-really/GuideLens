//! Local Windows.Media.Ocr engine wrapper for physical-pixel phrase grounding and Screen Day excerpts.

use crate::grounding::GroundingCandidate;
use crate::types::{GroundedElementSource, MonitorInfo, RectPx};
use image::RgbaImage;

const MAX_OCR_EXCERPT_CHARS: usize = 280;
const MAX_OCR_PHRASE_CHARS: usize = 84;
const OCR_PROCESS_MAX_DIM: u32 = 2400;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawOcrWord {
    pub text: String,
    pub rect: RectPx,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawOcrPhrase {
    pub text: String,
    pub rect: RectPx,
}

/// Splits a horizontal OCR line's words into tight UI phrases whenever horizontal gaps
/// indicate separate buttons/tabs/controls rather than continuous prose.
pub(crate) fn split_words_into_phrases(words: &[RawOcrWord]) -> Vec<RawOcrPhrase> {
    if words.is_empty() {
        return Vec::new();
    }

    let mut phrases: Vec<RawOcrPhrase> = Vec::new();
    let mut cur_text = String::new();
    let mut cur_rect: Option<RectPx> = None;
    let mut prev_rect: Option<RectPx> = None;

    for word in words {
        let token = word.text.trim();
        if token.is_empty() || word.rect.w <= 0 || word.rect.h <= 0 {
            continue;
        }

        let should_split = if let Some(prev) = prev_rect {
            let gap_x = word.rect.x - (prev.x + prev.w);
            let ref_h = prev.h.max(word.rect.h).max(10) as f64;
            let max_gap = (ref_h * 1.15).max(16.0);
            let prev_cy = prev.y as f64 + prev.h as f64 * 0.5;
            let cur_cy = word.rect.y as f64 + word.rect.h as f64 * 0.5;
            (gap_x as f64) > max_gap
                || (gap_x as f64) < -(ref_h * 0.6)
                || (cur_cy - prev_cy).abs() > ref_h
        } else {
            false
        };

        if should_split {
            if let Some(rect) = cur_rect.take() {
                if !cur_text.is_empty() {
                    phrases.push(RawOcrPhrase {
                        text: std::mem::take(&mut cur_text),
                        rect,
                    });
                }
            }
        }

        if cur_text.is_empty() {
            cur_text.push_str(token);
            cur_rect = Some(word.rect);
        } else {
            cur_text.push(' ');
            cur_text.push_str(token);
            if let Some(ref mut r) = cur_rect {
                let x1 = r.x.min(word.rect.x);
                let y1 = r.y.min(word.rect.y);
                let x2 = (r.x + r.w).max(word.rect.x + word.rect.w);
                let y2 = (r.y + r.h).max(word.rect.y + word.rect.h);
                *r = RectPx {
                    x: x1,
                    y: y1,
                    w: x2 - x1,
                    h: y2 - y1,
                };
            }
        }
        prev_rect = Some(word.rect);
    }

    if let Some(rect) = cur_rect {
        if !cur_text.is_empty() {
            phrases.push(RawOcrPhrase {
                text: cur_text,
                rect,
            });
        }
    }

    phrases
}

pub(crate) fn truncate_ocr_excerpt(raw: &str, max_chars: usize) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() || max_chars == 0 {
        return String::new();
    }
    let count = collapsed.chars().count();
    if count <= max_chars {
        return collapsed;
    }
    if max_chars <= 3 {
        return collapsed.chars().take(max_chars).collect();
    }
    let prefix: String = collapsed.chars().take(max_chars - 1).collect();
    let trimmed = match prefix.rfind(char::is_whitespace) {
        Some(idx) if idx > max_chars / 2 => prefix[..idx].trim_end(),
        _ => prefix.trim_end(),
    };
    format!("{}…", trimmed)
}

#[cfg(windows)]
fn rgba_to_bgra_bytes(img: &RgbaImage) -> Vec<u8> {
    let raw = img.as_raw();
    let mut bgra = Vec::with_capacity(raw.len());
    for px in raw.as_chunks::<4>().0 {
        bgra.push(px[2]); // B
        bgra.push(px[1]); // G
        bgra.push(px[0]); // R
        bgra.push(px[3]); // A
    }
    bgra
}

#[cfg(windows)]
struct WinRtOcrOutput {
    full_text: String,
    candidates: Vec<GroundingCandidate>,
}

#[cfg(windows)]
fn run_winrt_ocr(img: &RgbaImage, monitor: &MonitorInfo) -> Option<WinRtOcrOutput> {
    use image::imageops::FilterType;
    use std::borrow::Cow;
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;

    let orig_w = img.width();
    let orig_h = img.height();
    if orig_w < 8 || orig_h < 8 {
        return None;
    }

    let _com_guard = crate::locator::uia::ComMtaGuard::enter();

    // Inner scope guarantees every WinRT object drops before ComMtaGuard::drop calls CoUninitialize.
    {
        let engine = OcrEngine::TryCreateFromUserProfileLanguages().ok()?;
        let engine_max = OcrEngine::MaxImageDimension().unwrap_or(2600).clamp(256, 4096);
        let max_dim = engine_max.min(OCR_PROCESS_MAX_DIM);

        let scaled: Cow<'_, RgbaImage> = if orig_w > max_dim || orig_h > max_dim {
            let ratio = max_dim as f64 / orig_w.max(orig_h) as f64;
            let nw = ((orig_w as f64 * ratio).round() as u32).max(8);
            let nh = ((orig_h as f64 * ratio).round() as u32).max(8);
            Cow::Owned(image::imageops::resize(img, nw, nh, FilterType::Triangle))
        } else {
            Cow::Borrowed(img)
        };

        let ocr_w = scaled.width();
        let ocr_h = scaled.height();
        let scale_x = orig_w as f64 / ocr_w.max(1) as f64;
        let scale_y = orig_h as f64 / ocr_h.max(1) as f64;

        let bgra = rgba_to_bgra_bytes(scaled.as_ref());
        let buffer = CryptographicBuffer::CreateFromByteArray(&bgra).ok()?;
        let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            ocr_w as i32,
            ocr_h as i32,
            BitmapAlphaMode::Premultiplied,
        )
        .ok()?;

        let ocr_result = engine.RecognizeAsync(&bitmap).ok()?.get().ok()?;
        let _ = bitmap.Close();
        let lines = ocr_result.Lines().ok()?;
        let line_count = lines.Size().ok()?;

        let mut full_text_parts = Vec::with_capacity(line_count as usize);
        let mut candidates = Vec::new();
        let max_phrase_w = ((monitor.w.max(320) as f64) * 0.80).round() as i32;

        for li in 0..line_count {
            let Ok(line) = lines.GetAt(li) else {
                continue;
            };
            if let Ok(line_text) = line.Text() {
                let s = line_text.to_string();
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    full_text_parts.push(trimmed.to_string());
                }
            }

            let Ok(words) = line.Words() else {
                continue;
            };
            let Ok(word_count) = words.Size() else {
                continue;
            };

            let mut raw_words = Vec::with_capacity(word_count as usize);
            for wi in 0..word_count {
                let Ok(word) = words.GetAt(wi) else {
                    continue;
                };
                let (Ok(wtext), Ok(wrect)) = (word.Text(), word.BoundingRect()) else {
                    continue;
                };
                let px = monitor.x + (wrect.X as f64 * scale_x).round() as i32;
                let py = monitor.y + (wrect.Y as f64 * scale_y).round() as i32;
                let pw = (wrect.Width as f64 * scale_x).round() as i32;
                let ph = (wrect.Height as f64 * scale_y).round() as i32;
                raw_words.push(RawOcrWord {
                    text: wtext.to_string(),
                    rect: RectPx {
                        x: px,
                        y: py,
                        w: pw,
                        h: ph,
                    },
                });
            }

            for phrase in split_words_into_phrases(&raw_words) {
                if phrase.rect.w < 8
                    || phrase.rect.h < 8
                    || phrase.rect.w > max_phrase_w
                    || phrase.text.chars().count() > MAX_OCR_PHRASE_CHARS
                {
                    continue;
                }
                candidates.push(GroundingCandidate {
                    label: phrase.text,
                    control_type: "Text".to_string(),
                    rect_px: phrase.rect,
                    source: GroundedElementSource::Ocr,
                    is_taskbar: false,
                    has_semantic_label: true,
                });
            }
        }

        Some(WinRtOcrOutput {
            full_text: full_text_parts.join(" "),
            candidates,
        })
    }
}

/// Runs Windows local OCR to extract phrase bounding boxes in physical monitor coordinates.
/// Gracefully returns `Vec::new()` when the OCR engine is unavailable or image is blank/tiny.
pub fn recognize_ocr_candidates(
    img: &RgbaImage,
    monitor: &MonitorInfo,
) -> Vec<GroundingCandidate> {
    #[cfg(windows)]
    {
        run_winrt_ocr(img, monitor)
            .map(|o| o.candidates)
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = (img, monitor);
        Vec::new()
    }
}

/// Runs local WinRT OCR and returns a compact single-line excerpt (~280 chars) for Screen Day indexing.
pub fn extract_ocr_text_only(img: &RgbaImage) -> String {
    #[cfg(windows)]
    {
        let mon = MonitorInfo {
            x: 0,
            y: 0,
            w: img.width(),
            h: img.height(),
            scale: 1.0,
        };
        run_winrt_ocr(img, &mon)
            .map(|o| truncate_ocr_excerpt(&o.full_text, MAX_OCR_EXCERPT_CHARS))
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = img;
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn blank_and_tiny_images_return_empty_gracefully() {
        let tiny = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let mon = MonitorInfo::default();
        assert!(recognize_ocr_candidates(&tiny, &mon).is_empty());
        assert_eq!(extract_ocr_text_only(&tiny), "");

        let blank = RgbaImage::from_pixel(320, 180, Rgba([245, 245, 245, 255]));
        assert!(recognize_ocr_candidates(&blank, &mon).is_empty());
        assert_eq!(extract_ocr_text_only(&blank), "");
    }

    #[test]
    fn split_words_groups_close_words_and_separates_distant_toolbar_items() {
        let words = vec![
            RawOcrWord {
                text: "New".to_string(),
                rect: RectPx {
                    x: 20,
                    y: 40,
                    w: 28,
                    h: 16,
                },
            },
            RawOcrWord {
                text: "chat".to_string(),
                rect: RectPx {
                    x: 52,
                    y: 40,
                    w: 30,
                    h: 16,
                },
            },
            RawOcrWord {
                text: "Export".to_string(),
                rect: RectPx {
                    x: 160,
                    y: 40,
                    w: 44,
                    h: 16,
                },
            },
        ];

        let phrases = split_words_into_phrases(&words);
        assert_eq!(phrases.len(), 2);
        assert_eq!(phrases[0].text, "New chat");
        assert_eq!(
            phrases[0].rect,
            RectPx {
                x: 20,
                y: 40,
                w: 62,
                h: 16
            }
        );
        assert_eq!(phrases[1].text, "Export");
        assert_eq!(
            phrases[1].rect,
            RectPx {
                x: 160,
                y: 40,
                w: 44,
                h: 16
            }
        );
    }

    #[test]
    fn truncate_ocr_excerpt_caps_to_280_chars_on_word_boundary() {
        let long = "GuideLens visual workspace captures context cleanly. ".repeat(12);
        let excerpt = truncate_ocr_excerpt(&long, 280);
        assert!(excerpt.chars().count() <= 280);
        assert!(excerpt.ends_with('…'));
    }

    #[test]
    fn concurrent_ocr_and_uia_threads_never_crash() {
        let mon = MonitorInfo {
            x: 0,
            y: 0,
            w: 320,
            h: 180,
            scale: 1.0,
        };
        let mut handles = Vec::new();
        for i in 0..4 {
            let m = mon.clone();
            handles.push(std::thread::spawn(move || {
                let blank = RgbaImage::from_pixel(320, 180, Rgba([240, 240, 240, 255]));
                for _ in 0..3 {
                    let _ = recognize_ocr_candidates(&blank, &m);
                    let _ = extract_ocr_text_only(&blank);
                    if i % 2 == 0 {
                        let _ = crate::grounding::uia_fast::collect_fast_uia_and_taskbar(0, &m);
                    }
                }
            }));
        }
        for h in handles {
            h.join().expect("worker thread must not panic or AV");
        }
    }
}
