//! Hybrid target locator: Windows UI Automation tree snapping + VLM normalized bbox fusion.

pub mod uia;

use crate::capture::normalized_to_physical;
use crate::types::{MonitorInfo, RectPx, ResolvedStep, Step, StepPlan, StepSource};
use std::time::Duration;
use strsim::jaro_winkler;

pub const DEFAULT_UIA_BUDGET: Duration = Duration::from_millis(150);
pub const MIN_FUZZY_SCORE: f64 = 0.72;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiaCandidate {
    pub name: String,
    pub control_type: String,
    pub rect: RectPx,
}

/// Resolves all steps in a `StepPlan` against the foreground window's UIA tree (150ms budget)
/// and the captured monitor's DPI/offset geometry.
pub async fn resolve_step_plan(
    plan: &StepPlan,
    monitor: &MonitorInfo,
    hwnd: isize,
) -> Vec<ResolvedStep> {
    let needs_uia = plan
        .steps
        .iter()
        .any(|s| s.target_name.as_deref().is_some_and(|n| !n.trim().is_empty()));

    let candidates = if needs_uia && hwnd != 0 {
        tokio::task::spawn_blocking(move || uia::collect_window_controls(hwnd, DEFAULT_UIA_BUDGET))
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    resolve_steps_with_candidates(&plan.steps, monitor, &candidates)
}

/// Pure, synchronous fusion function combining UIA candidates and VLM bounding boxes.
pub fn resolve_steps_with_candidates(
    steps: &[Step],
    monitor: &MonitorInfo,
    candidates: &[UiaCandidate],
) -> Vec<ResolvedStep> {
    steps
        .iter()
        .map(|step| resolve_single_step(step, monitor, candidates))
        .collect()
}

pub fn resolve_single_step(
    step: &Step,
    monitor: &MonitorInfo,
    candidates: &[UiaCandidate],
) -> ResolvedStep {
    let vlm_rect = if step.confidence >= 0.5 {
        step.bbox
            .map(|b| normalized_to_physical(b, monitor))
            .filter(|r| r.w > 0 && r.h > 0)
    } else {
        None
    };

    if let Some(target_name) = step
        .target_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some((best, score)) =
            find_best_uia_match(target_name, step.control_type.as_deref(), vlm_rect, candidates)
        {
            let should_prefer_uia = match vlm_rect {
                None => true,
                Some(vlm) => {
                    rects_overlap_with_margin(best.rect, vlm, 48) || score >= 0.88
                }
            };

            if should_prefer_uia {
                return ResolvedStep::from_step(step.clone(), Some(best.rect), StepSource::Uia);
            }
        }
    }

    if let Some(vlm) = vlm_rect {
        return ResolvedStep::from_step(step.clone(), Some(vlm), StepSource::Vlm);
    }

    ResolvedStep::from_step(step.clone(), None, StepSource::None)
}

/// Scores and selects the best matching UIA candidate for `target_name` and optional `control_type`.
pub fn find_best_uia_match<'a>(
    target_name: &str,
    control_type: Option<&str>,
    vlm_rect: Option<RectPx>,
    candidates: &'a [UiaCandidate],
) -> Option<(&'a UiaCandidate, f64)> {
    let target_norm = normalize_label(target_name);
    if target_norm.is_empty() {
        return None;
    }

    let expected_type = control_type
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase());

    let mut best: Option<(&UiaCandidate, f64)> = None;

    for cand in candidates {
        if cand.rect.w <= 0 || cand.rect.h <= 0 {
            continue;
        }
        let cand_norm = normalize_label(&cand.name);
        if cand_norm.is_empty() {
            continue;
        }

        let mut score = fuzzy_name_score(&target_norm, &cand_norm);
        if score < 0.55 {
            continue;
        }

        if let Some(ref want_type) = expected_type {
            let cand_type = cand.control_type.to_ascii_lowercase();
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
            if rects_overlap_with_margin(cand.rect, vlm, 48) {
                score = (score + 0.10).min(1.0);
            } else if center_distance_sq(cand.rect, vlm) < 160.0 * 160.0 {
                score = (score + 0.04).min(1.0);
            }
        }

        if score >= MIN_FUZZY_SCORE {
            match best {
                Some((_, best_score)) if score <= best_score => {}
                _ => best = Some((cand, score)),
            }
        }
    }

    best
}

pub fn fuzzy_name_score(target_norm: &str, candidate_norm: &str) -> f64 {
    if target_norm == candidate_norm {
        return 1.0;
    }

    // Handle labels with appended shortcut hints like "Object Selection Tool (W)"
    if candidate_norm.starts_with(target_norm) || target_norm.starts_with(candidate_norm) {
        let min_len = target_norm.len().min(candidate_norm.len()) as f64;
        let max_len = target_norm.len().max(candidate_norm.len()).max(1) as f64;
        return 0.86 + 0.12 * (min_len / max_len);
    }

    if candidate_norm.contains(target_norm) || target_norm.contains(candidate_norm) {
        let min_len = target_norm.len().min(candidate_norm.len()) as f64;
        let max_len = target_norm.len().max(candidate_norm.len()).max(1) as f64;
        return 0.78 + 0.16 * (min_len / max_len);
    }

    let jw = jaro_winkler(target_norm, candidate_norm);
    let token_score = token_overlap(target_norm, candidate_norm);
    jw.max(token_score * 0.92)
}

fn normalize_label(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c.is_whitespace() {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn token_overlap(a: &str, b: &str) -> f64 {
    let ta: Vec<&str> = a.split_whitespace().collect();
    let tb: Vec<&str> = b.split_whitespace().collect();
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let mut matches = 0usize;
    for tok in &ta {
        if tb.contains(tok) {
            matches += 1;
        }
    }
    let union = (ta.len() + tb.len() - matches).max(1);
    matches as f64 / union as f64
}

pub fn rects_overlap_with_margin(a: RectPx, b: RectPx, margin: i32) -> bool {
    let ax1 = a.x - margin;
    let ay1 = a.y - margin;
    let ax2 = a.x + a.w + margin;
    let ay2 = a.y + a.h + margin;

    let bx1 = b.x;
    let by1 = b.y;
    let bx2 = b.x + b.w;
    let by2 = b.y + b.h;

    ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1
}

fn center_distance_sq(a: RectPx, b: RectPx) -> f64 {
    let acx = a.x as f64 + a.w as f64 / 2.0;
    let acy = a.y as f64 + a.h as f64 / 2.0;
    let bcx = b.x as f64 + b.w as f64 / 2.0;
    let bcy = b.y as f64 + b.h as f64 / 2.0;
    let dx = acx - bcx;
    let dy = acy - bcy;
    dx * dx + dy * dy
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_monitor() -> MonitorInfo {
        MonitorInfo {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
            scale: 1.0,
        }
    }

    fn make_step(
        target_name: Option<&str>,
        control_type: Option<&str>,
        bbox: Option<[f64; 4]>,
        confidence: f64,
    ) -> Step {
        Step {
            step_number: 1,
            instruction_line: "Click target button.".to_string(),
            target_name: target_name.map(|s| s.to_string()),
            control_type: control_type.map(|s| s.to_string()),
            bbox,
            confidence,
            shortcut: None,
            terminal_command: None,
            explanation: None,
            spoken_text: None,
        }
    }

    #[test]
    fn fuzzy_matching_handles_shortcuts_typos_and_rejects_unrelated() {
        let score_exact = fuzzy_name_score("object selection tool", "object selection tool");
        assert!((score_exact - 1.0).abs() < 1e-6);

        let score_shortcut =
            fuzzy_name_score("object selection tool", "object selection tool w");
        assert!(score_shortcut >= 0.90);

        let score_typo = fuzzy_name_score("select subject", "select subjcet");
        assert!(score_typo >= 0.85);

        let score_unrelated = fuzzy_name_score("brush tool", "layers panel");
        assert!(score_unrelated < MIN_FUZZY_SCORE);
    }

    #[test]
    fn fusion_prefers_uia_when_overlapping_or_bbox_missing() {
        let mon = test_monitor();
        let candidates = vec![
            UiaCandidate {
                name: "Object Selection Tool (W)".to_string(),
                control_type: "Button".to_string(),
                rect: RectPx {
                    x: 16,
                    y: 200,
                    w: 36,
                    h: 36,
                },
            },
            UiaCandidate {
                name: "Brush Tool (B)".to_string(),
                control_type: "Button".to_string(),
                rect: RectPx {
                    x: 16,
                    y: 350,
                    w: 36,
                    h: 36,
                },
            },
        ];

        // 1. Overlapping UIA + VLM -> prefers exact UIA rect
        let step_overlap = make_step(
            Some("Object Selection Tool"),
            Some("Button"),
            Some([10.0, 180.0, 30.0, 30.0]), // maps to (19, 194, 58, 32)
            0.90,
        );
        let resolved = resolve_single_step(&step_overlap, &mon, &candidates);
        assert_eq!(resolved.source, StepSource::Uia);
        assert_eq!(
            resolved.rect_px,
            Some(RectPx {
                x: 16,
                y: 200,
                w: 36,
                h: 36
            })
        );

        // 2. Missing VLM bbox -> snaps via UIA
        let step_no_bbox = make_step(Some("Brush Tool"), Some("Button"), None, 0.8);
        let resolved_no_bbox = resolve_single_step(&step_no_bbox, &mon, &candidates);
        assert_eq!(resolved_no_bbox.source, StepSource::Uia);
        assert_eq!(resolved_no_bbox.rect_px.unwrap().y, 350);
    }

    #[test]
    fn falls_back_to_vlm_or_none_on_low_confidence() {
        let mon = test_monitor();
        let candidates = vec![];

        let step_vlm = make_step(
            Some("Custom Icon"),
            Some("Button"),
            Some([500.0, 500.0, 50.0, 50.0]),
            0.85,
        );
        let r_vlm = resolve_single_step(&step_vlm, &mon, &candidates);
        assert_eq!(r_vlm.source, StepSource::Vlm);
        assert_eq!(
            r_vlm.rect_px,
            Some(RectPx {
                x: 960,
                y: 540,
                w: 96,
                h: 54
            })
        );

        let step_low = make_step(
            Some("Missing Button"),
            Some("Button"),
            Some([500.0, 500.0, 50.0, 50.0]),
            0.35,
        );
        let r_none = resolve_single_step(&step_low, &mon, &candidates);
        assert_eq!(r_none.source, StepSource::None);
        assert_eq!(r_none.rect_px, None);
    }
}
