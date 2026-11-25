//! Hybrid local Set-of-Mark (SoM) grounding engine combining UIA, Taskbar, WinRT OCR, and Vision.

pub mod som_renderer;
pub mod uia_fast;
pub mod vision_boxes;
pub mod winrt_ocr;

use crate::capture::{capture_for_live_grounding, dhash_to_hex};
use crate::locator::{fuzzy_name_score, normalize_label, resolve_step_plan, MIN_FUZZY_SCORE};
use crate::types::{
    GroundedElement, GroundedElementSource, GroundingSnapshot, RectPx, ResolvedStep, Step,
    StepPlan, StepSource,
};
use image::RgbaImage;
use std::sync::Arc;
use std::time::Instant;

pub use winrt_ocr::extract_ocr_text_only;

#[derive(Debug, Clone, PartialEq)]
pub struct GroundingCandidate {
    pub label: String,
    pub control_type: String,
    pub rect_px: RectPx,
    pub source: GroundedElementSource,
    pub is_taskbar: bool,
    pub has_semantic_label: bool,
}

/// Computes intersection-over-union (`0.0..=1.0`) for two physical rectangles.
pub fn rect_iou(a: RectPx, b: RectPx) -> f64 {
    if a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0 {
        return 0.0;
    }
    let ix1 = a.x.max(b.x);
    let iy1 = a.y.max(b.y);
    let ix2 = (a.x + a.w).min(b.x + b.w);
    let iy2 = (a.y + a.h).min(b.y + b.h);
    if ix2 <= ix1 || iy2 <= iy1 {
        return 0.0;
    }
    let inter = (ix2 - ix1) as f64 * (iy2 - iy1) as f64;
    let area_a = (a.w as f64) * (a.h as f64);
    let area_b = (b.w as f64) * (b.h as f64);
    let union = area_a + area_b - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

#[derive(Debug, Clone)]
pub struct PreparedGrounding {
    pub snapshot: GroundingSnapshot,
    pub som_image_base64: String,
    pub som_jpeg_bytes: Vec<u8>,
    pub raw_image_for_save: RgbaImage,
}

/// Captures the active monitor in memory (zero disk I/O) and runs parallel UIA + Taskbar +
/// WinRT OCR + Vision box detection, returning an annotated Set-of-Mark image and element table.
pub async fn capture_and_ground(
    app: Option<&tauri::AppHandle>,
) -> Result<PreparedGrounding, String> {
    let app_owned = app.cloned();
    let frame =
        tokio::task::spawn_blocking(move || capture_for_live_grounding(app_owned.as_ref()))
            .await
            .map_err(|e| format!("Capture task failed: {}", e))??;

    let grounding_started = Instant::now();
    let shared_img = Arc::new(frame.image);
    let mon_uia = frame.monitor.clone();
    let mon_ocr = frame.monitor.clone();
    let mon_vis = frame.monitor.clone();
    let hwnd = frame.hwnd;

    let img_ocr = Arc::clone(&shared_img);
    let img_vis = Arc::clone(&shared_img);

    let (uia_res, ocr_res, vis_res) = tokio::join!(
        tokio::task::spawn_blocking(move || uia_fast::collect_fast_uia_and_taskbar(hwnd, &mon_uia)),
        tokio::task::spawn_blocking(move || winrt_ocr::recognize_ocr_candidates(&img_ocr, &mon_ocr)),
        tokio::task::spawn_blocking(move || vision_boxes::detect_vision_boxes(&img_vis, &mon_vis)),
    );

    let mut all_candidates = Vec::new();
    if let Ok(mut uia_cands) = uia_res {
        all_candidates.append(&mut uia_cands);
    }
    if let Ok(mut ocr_cands) = ocr_res {
        all_candidates.append(&mut ocr_cands);
    }
    if let Ok(mut vis_cands) = vis_res {
        all_candidates.append(&mut vis_cands);
    }

    let mon_render = frame.monitor.clone();
    let img_render = Arc::clone(&shared_img);
    let (elements, element_table_prompt, som_jpeg_bytes, som_image_base64) =
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let elements = som_renderer::merge_and_number_candidates(all_candidates, &mon_render);
            let table = som_renderer::format_element_table_prompt(&elements);
            let (jpeg, b64, _) =
                som_renderer::render_som_overlay_and_encode(&img_render, &mon_render, &elements)?;
            Ok((elements, table, jpeg, b64))
        })
        .await
        .map_err(|e| format!("SoM render task failed: {}", e))??;

    let grounding_ms = grounding_started.elapsed().as_millis() as u64;
    let raw_image_for_save = Arc::try_unwrap(shared_img).unwrap_or_else(|arc| (*arc).clone());

    let snapshot = GroundingSnapshot {
        monitor: frame.monitor,
        active_app: frame.active_app,
        window_title: frame.window_title,
        hwnd: frame.hwnd,
        dhash64: dhash_to_hex(frame.dhash64),
        elements,
        element_table_prompt,
        capture_ms: frame.capture_ms,
        grounding_ms,
    };

    Ok(PreparedGrounding {
        snapshot,
        som_image_base64,
        som_jpeg_bytes,
        raw_image_for_save,
    })
}

fn match_step_against_snapshot_elements<'a>(
    step: &Step,
    elements: &'a [GroundedElement],
    vlm_rect: Option<RectPx>,
) -> Option<(&'a GroundedElement, StepSource)> {
    // 1. Exact `target_id` snap from Set-of-Mark `[N]` badge.
    if let Some(tid) = step.target_id {
        if let Some(el) = elements.iter().find(|e| e.id == tid) {
            return Some((el, StepSource::Som));
        }
    }

    // 2. Fuzzy label match against already-grounded snapshot elements.
    let target_name = step
        .target_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let target_norm = normalize_label(target_name);
    if target_norm.is_empty() {
        return None;
    }

    let expected_type = step
        .control_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase());

    let mut best: Option<(&GroundedElement, f64)> = None;
    for el in elements {
        if el.rect_px.w <= 0 || el.rect_px.h <= 0 {
            continue;
        }
        let el_norm = normalize_label(&el.label);
        if el_norm.is_empty() {
            continue;
        }
        let mut score = fuzzy_name_score(&target_norm, &el_norm);
        if score < 0.55 {
            continue;
        }

        if let Some(ref want_type) = expected_type {
            let cand_type = el.control_type.to_ascii_lowercase();
            if &cand_type == want_type
                || (want_type == "button" && cand_type == "splitbutton")
                || (want_type == "menuitem" && cand_type == "button")
            {
                score = (score + 0.08).min(1.0);
            } else if !cand_type.is_empty() && cand_type != "control" && cand_type != "custom" {
                score -= 0.06;
            }
        }

        if let Some(vlm) = vlm_rect {
            if crate::locator::rects_overlap_with_margin(el.rect_px, vlm, 48) {
                score = (score + 0.10).min(1.0);
            }
        }

        if score >= MIN_FUZZY_SCORE {
            match best {
                Some((_, best_score)) if score <= best_score => {}
                _ => best = Some((el, score)),
            }
        }
    }

    let (matched, score) = best?;
    let should_accept = match vlm_rect {
        None => true,
        Some(vlm) => {
            crate::locator::rects_overlap_with_margin(matched.rect_px, vlm, 48) || score >= 0.88
        }
    };
    if !should_accept {
        return None;
    }

    let src = match matched.source {
        GroundedElementSource::Uia | GroundedElementSource::Taskbar => StepSource::Uia,
        GroundedElementSource::Ocr | GroundedElementSource::Vision => StepSource::Som,
    };
    Some((matched, src))
}

/// Resolves a `StepPlan` using the captured `GroundingSnapshot`:
/// 1. Snaps `step.target_id` -> `GroundedElement` -> `StepSource::Som` pixel-exact `RectPx`.
/// 2. Falls back to matching `step.target_name` against `snapshot.elements`.
/// 3. Falls back to `crate::locator::resolve_step_plan` for any remaining unresolved steps.
pub async fn resolve_plan_with_grounding(
    plan: &StepPlan,
    snapshot: &GroundingSnapshot,
) -> Vec<ResolvedStep> {
    let mut results: Vec<Option<ResolvedStep>> = vec![None; plan.steps.len()];
    let mut fallback_indices = Vec::new();
    let mut fallback_steps = Vec::new();

    for (idx, step) in plan.steps.iter().enumerate() {
        let vlm_rect = if step.confidence >= 0.5 {
            step.bbox
                .map(|b| crate::capture::normalized_to_physical(b, &snapshot.monitor))
                .filter(|r| r.w > 0 && r.h > 0)
        } else {
            None
        };

        if let Some((el, source)) =
            match_step_against_snapshot_elements(step, &snapshot.elements, vlm_rect)
        {
            let mut enriched = step.clone();
            if enriched
                .target_name
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
                && !el.label.is_empty()
            {
                enriched.target_name = Some(el.label.clone());
            }
            if enriched
                .control_type
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
                && !el.control_type.is_empty()
            {
                enriched.control_type = Some(el.control_type.clone());
            }
            results[idx] = Some(ResolvedStep::from_step(
                enriched,
                Some(el.rect_px),
                source,
            ));
        } else {
            fallback_indices.push(idx);
            fallback_steps.push(step.clone());
        }
    }

    if !fallback_steps.is_empty() {
        let fallback_plan = StepPlan {
            mode: plan.mode,
            total_steps: fallback_steps.len().max(1) as u32,
            steps: fallback_steps,
        };
        let resolved_fallback =
            resolve_step_plan(&fallback_plan, &snapshot.monitor, snapshot.hwnd).await;
        for (orig_idx, resolved) in fallback_indices.into_iter().zip(resolved_fallback)
        {
            results[orig_idx] = Some(resolved);
        }
    }

    results
        .into_iter()
        .enumerate()
        .map(|(i, item)| {
            item.unwrap_or_else(|| ResolvedStep::from_step(plan.steps[i].clone(), None, StepSource::None))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{MonitorInfo, StepMode};

    fn sample_snapshot() -> GroundingSnapshot {
        GroundingSnapshot {
            monitor: MonitorInfo {
                x: 0,
                y: 0,
                w: 1920,
                h: 1080,
                scale: 1.0,
            },
            active_app: "Code.exe".to_string(),
            window_title: "GuideLens - Visual Studio Code".to_string(),
            hwnd: 0,
            dhash64: "0000000000000000".to_string(),
            elements: vec![
                GroundedElement {
                    id: 7,
                    label: "New Chat".to_string(),
                    control_type: "Button".to_string(),
                    rect_px: RectPx {
                        x: 42,
                        y: 88,
                        w: 136,
                        h: 34,
                    },
                    norm_bbox: [21.8, 81.5, 70.8, 31.5],
                    source: GroundedElementSource::Uia,
                    is_taskbar: false,
                },
                GroundedElement {
                    id: 14,
                    label: "Export".to_string(),
                    control_type: "Text".to_string(),
                    rect_px: RectPx {
                        x: 1620,
                        y: 44,
                        w: 88,
                        h: 30,
                    },
                    norm_bbox: [843.8, 40.7, 45.8, 27.8],
                    source: GroundedElementSource::Ocr,
                    is_taskbar: false,
                },
            ],
            element_table_prompt: String::new(),
            capture_ms: 12,
            grounding_ms: 48,
        }
    }

    fn base_step(step_number: u32) -> Step {
        Step {
            step_number,
            instruction_line: "Do action".to_string(),
            target_name: None,
            control_type: None,
            bbox: None,
            confidence: 0.9,
            shortcut: None,
            terminal_command: None,
            explanation: None,
            spoken_text: None,
            target_id: None,
            action_kind: Some("click".to_string()),
            companion_emotion: Some("pointing".to_string()),
            goal_complete: false,
        }
    }

    #[tokio::test]
    async fn resolve_plan_snaps_target_id_even_with_low_confidence_and_fills_missing_label() {
        let snapshot = sample_snapshot();
        let mut s1 = base_step(1);
        s1.target_id = Some(7);
        s1.confidence = 0.2;

        let mut s2 = base_step(2);
        s2.target_name = Some("Export".to_string());

        let mut s3 = base_step(3);
        s3.target_id = Some(999);
        s3.target_name = Some("Unknown Widget".to_string());
        s3.bbox = Some([500.0, 500.0, 50.0, 40.0]);
        s3.confidence = 0.85;

        let plan = StepPlan {
            mode: StepMode::Guide,
            total_steps: 3,
            steps: vec![s1, s2, s3],
        };

        let resolved = resolve_plan_with_grounding(&plan, &snapshot).await;
        assert_eq!(resolved.len(), 3);

        // Step 1: exact target_id=7 snap -> StepSource::Som + exact RectPx
        assert_eq!(resolved[0].source, StepSource::Som);
        assert_eq!(resolved[0].rect_px, Some(snapshot.elements[0].rect_px));
        assert_eq!(resolved[0].target_name.as_deref(), Some("New Chat"));

        // Step 2: OCR label match in snapshot.elements
        assert_eq!(resolved[1].source, StepSource::Som);
        assert_eq!(resolved[1].rect_px, Some(snapshot.elements[1].rect_px));

        // Step 3: unknown target_id/name falls back to locator -> StepSource::Vlm
        assert_eq!(resolved[2].source, StepSource::Vlm);
        assert_eq!(
            resolved[2].rect_px,
            Some(RectPx {
                x: 960,
                y: 540,
                w: 96,
                h: 43
            })
        );
    }
}
