//! Graphify-inspired Native Playbook Compiler & Live UIA Verifier for GuideLens v2.3.

use crate::capture::{detect_active_window, normalized_to_physical, ActiveWindowInfo};
use crate::db::{unix_now, DbState};
use crate::locator::{fuzzy_name_score, normalize_label, MIN_FUZZY_SCORE};
use crate::memory::graph_md::{app_slug, fnv1a_64_hex};
use crate::types::{
    CompiledPlaybookDto, DefaultOptionsResponse, GroundedElement, MonitorInfo, PlaybookStepDto,
    ResolvedStep, Step, StepSource,
};
use std::collections::{HashMap, HashSet};
use strsim::jaro_winkler;

pub const PLAYBOOK_CLUSTER_THRESHOLD: f64 = 0.72;
pub const TIER0_MIN_CONFIDENCE: f64 = 0.65;
pub const TIER0_MIN_MATCH_SCORE: f64 = 0.72;

const STOP_WORDS: &[&str] = &[
    "the", "how", "to", "in", "on", "a", "an", "my", "me", "do", "can", "i", "please", "show",
    "where", "is", "this", "want", "for", "with",
];

/// Normalizes `(app_exe, window_title)` into a stable view key so transient filenames/tabs
/// collapse into reusable app/view nodes (e.g. `code.exe:workspace`, `chrome.exe:docs.google.com`).
pub fn normalize_view_key(app_exe: &str, window_title: &str) -> String {
    let exe_trimmed = app_exe.trim();
    let exe_base = exe_trimmed
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(exe_trimmed)
        .to_ascii_lowercase();
    let app_key = if exe_base.is_empty() {
        "unknown".to_string()
    } else {
        exe_base
    };

    let title_lower = window_title.trim().to_ascii_lowercase();

    // Recognized web apps keep a stable domain/service view key regardless of tab title.
    const WEB_VIEW_PATTERNS: &[(&[&str], &str)] = &[
        (&["docs.google.com", "google docs"], "docs.google.com"),
        (&["sheets.google.com", "google sheets"], "sheets.google.com"),
        (&["slides.google.com", "google slides"], "slides.google.com"),
        (&["drive.google.com", "google drive"], "drive.google.com"),
        (&["mail.google.com", "gmail"], "mail.google.com"),
        (&["canva.com", "canva"], "canva"),
        (&["github.com", "github"], "github.com"),
        (&["figma.com", "figma"], "figma"),
        (&["notion.so", "notion"], "notion"),
        (&["youtube.com", "youtube"], "youtube.com"),
        (&["slack.com", "slack"], "slack"),
    ];

    let is_browser = matches!(
        app_key.as_str(),
        "chrome.exe" | "msedge.exe" | "brave.exe" | "firefox.exe" | "opera.exe" | "arc.exe"
    );

    if is_browser || !title_lower.is_empty() {
        for (patterns, domain_key) in WEB_VIEW_PATTERNS {
            if is_browser
                && patterns
                    .iter()
                    .any(|p| !p.is_empty() && title_lower.contains(p))
            {
                return format!("{}:{}", app_key, domain_key);
            }
            // Also recognize explicit domain strings in any window title
            if patterns[0].contains('.') && title_lower.contains(patterns[0]) {
                return format!("{}:{}", app_key, domain_key);
            }
        }
    }

    if matches!(
        app_key.as_str(),
        "code.exe" | "cursor.exe" | "windsurf.exe" | "antigravity.exe" | "devenv.exe"
    ) || title_lower.contains("visual studio code")
    {
        return format!("{}:workspace", app_key);
    }

    format!("{}:main", app_key)
}

/// Extracts lowercase alphanumeric tokens (2..=30 chars) excluding common stop-words.
pub fn extract_vocab_tokens(text: &str) -> Vec<String> {
    let stop: HashSet<&str> = STOP_WORDS.iter().copied().collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    let mut cur = String::new();

    let mut flush = |buf: &mut String| {
        if !buf.is_empty() {
            let len = buf.chars().count();
            if (2..=30).contains(&len) && !stop.contains(buf.as_str()) && seen.insert(buf.clone()) {
                out.push(std::mem::take(buf));
            } else {
                buf.clear();
            }
        }
    };

    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            cur.push(ch.to_ascii_lowercase());
        } else {
            flush(&mut cur);
        }
    }
    flush(&mut cur);
    out
}

/// Computes inverse document frequency weights across a set of playbooks and their aliases.
pub fn compute_vocab_idf(
    playbooks: &[(CompiledPlaybookDto, Vec<String>, i64)],
) -> HashMap<String, f64> {
    let n = playbooks.len() as f64;
    if playbooks.is_empty() {
        return HashMap::new();
    }
    let mut df: HashMap<String, usize> = HashMap::new();
    for (pb, aliases, _) in playbooks {
        let mut doc_tokens: HashSet<String> = HashSet::new();
        for tok in extract_vocab_tokens(&pb.canonical_goal) {
            doc_tokens.insert(tok);
        }
        for tok in extract_vocab_tokens(&pb.display_label) {
            doc_tokens.insert(tok);
        }
        for alias in aliases {
            for tok in extract_vocab_tokens(alias) {
                doc_tokens.insert(tok);
            }
        }
        for tok in doc_tokens {
            *df.entry(tok).or_insert(0) += 1;
        }
    }

    df.into_iter()
        .map(|(tok, count)| {
            let idf = ((n + 1.0) / (count as f64 + 1.0)).ln() + 1.0;
            (tok, idf)
        })
        .collect()
}

fn score_pair_against_query(
    query_norm: &str,
    query_tokens: &[String],
    candidate_text: &str,
    vocab_idf: &HashMap<String, f64>,
) -> f64 {
    let cand_norm = normalize_label(candidate_text);
    if query_norm.is_empty() || cand_norm.is_empty() {
        return 0.0;
    }
    if query_norm == cand_norm {
        return 1.0;
    }

    let cand_tokens = extract_vocab_tokens(candidate_text);
    if query_tokens.is_empty() || cand_tokens.is_empty() {
        return jaro_winkler(query_norm, &cand_norm) * 0.8;
    }

    let q_set: HashSet<&str> = query_tokens.iter().map(String::as_str).collect();
    let c_set: HashSet<&str> = cand_tokens.iter().map(String::as_str).collect();
    if q_set == c_set {
        return 0.98;
    }

    let token_weight = |tok: &str| -> f64 { vocab_idf.get(tok).copied().unwrap_or(1.0) };

    let q_total: f64 = query_tokens.iter().map(|t| token_weight(t)).sum();
    let c_total: f64 = cand_tokens.iter().map(|t| token_weight(t)).sum();

    let mut q_matched = 0.0;
    let mut c_matched = 0.0;

    for qt in query_tokens {
        let w = token_weight(qt);
        if c_set.contains(qt.as_str()) {
            q_matched += w;
        } else if let Some(best_sim) = cand_tokens
            .iter()
            .filter_map(|ct| {
                if (qt.len() >= 4 && ct.starts_with(qt.as_str()))
                    || (ct.len() >= 4 && qt.starts_with(ct.as_str()))
                {
                    Some(0.85)
                } else {
                    let sim = jaro_winkler(qt, ct);
                    (sim >= 0.88).then_some(sim * 0.85)
                }
            })
            .reduce(f64::max)
        {
            q_matched += w * best_sim;
        }
    }

    for ct in &cand_tokens {
        let w = token_weight(ct);
        if q_set.contains(ct.as_str()) {
            c_matched += w;
        } else if let Some(best_sim) = query_tokens
            .iter()
            .filter_map(|qt| {
                if (qt.len() >= 4 && ct.starts_with(qt.as_str()))
                    || (ct.len() >= 4 && qt.starts_with(ct.as_str()))
                {
                    Some(0.85)
                } else {
                    let sim = jaro_winkler(qt, ct);
                    (sim >= 0.88).then_some(sim * 0.85)
                }
            })
            .reduce(f64::max)
        {
            c_matched += w * best_sim;
        }
    }

    let recall = if q_total > 0.0 { q_matched / q_total } else { 0.0 };
    let precision = if c_total > 0.0 { c_matched / c_total } else { 0.0 };
    let weighted_f1 = if recall + precision > 0.0 {
        (2.0 * recall * precision) / (recall + precision)
    } else {
        0.0
    };

    let mut best = weighted_f1;

    // Substring boost for multi-word queries or full phrases
    if query_tokens.len() >= 2 && (cand_norm.contains(query_norm) || query_norm.contains(&cand_norm))
    {
        let min_len = query_norm.len().min(cand_norm.len()) as f64;
        let max_len = query_norm.len().max(cand_norm.len()).max(1) as f64;
        let sub_score = 0.78 + 0.18 * (min_len / max_len);
        best = best.max(sub_score);
    }

    // If every non-stop query token appears in candidate (e.g. "open terminal" -> "open integrated terminal")
    if query_tokens.len() >= 2 && recall >= 0.99 && precision >= 0.5 {
        best = best.max(0.76 + 0.18 * precision);
    }

    best.clamp(0.0, 1.0)
}

/// Scores how well `query` matches a `CompiledPlaybookDto` using IDF-weighted token overlap + substring boost.
pub fn score_goal_match(
    query: &str,
    playbook: &CompiledPlaybookDto,
    vocab_idf: &HashMap<String, f64>,
) -> f64 {
    score_goal_match_with_aliases(query, playbook, &[], vocab_idf)
}

/// Scores `query` against `playbook.canonical_goal`, `display_label`, and stored aliases.
pub fn score_goal_match_with_aliases(
    query: &str,
    playbook: &CompiledPlaybookDto,
    aliases: &[String],
    vocab_idf: &HashMap<String, f64>,
) -> f64 {
    let query_norm = normalize_label(query);
    if query_norm.is_empty() {
        return 0.0;
    }
    let query_tokens = extract_vocab_tokens(query);

    let mut best = score_pair_against_query(
        &query_norm,
        &query_tokens,
        &playbook.canonical_goal,
        vocab_idf,
    );
    if !playbook.display_label.trim().is_empty()
        && playbook.display_label != playbook.canonical_goal
    {
        best = best.max(score_pair_against_query(
            &query_norm,
            &query_tokens,
            &playbook.display_label,
            vocab_idf,
        ));
    }
    for alias in aliases {
        best = best.max(score_pair_against_query(
            &query_norm,
            &query_tokens,
            alias,
            vocab_idf,
        ));
    }
    best
}

fn make_display_label(goal: &str) -> String {
    let collapsed: String = goal.split_whitespace().collect::<Vec<_>>().join(" ");
    let char_count = collapsed.chars().count();
    if char_count <= 56 {
        collapsed
    } else {
        let clipped: String = collapsed.chars().take(55).collect();
        format!("{}…", clipped.trim_end())
    }
}

fn to_playbook_steps(steps: &[ResolvedStep]) -> Vec<PlaybookStepDto> {
    steps
        .iter()
        .enumerate()
        .map(|(idx, s)| PlaybookStepDto {
            step_number: if s.step_number > 0 {
                s.step_number
            } else {
                (idx + 1) as u32
            },
            instruction_line: Step::clamp_instruction(&s.instruction_line),
            target_name: s.target_name.clone(),
            control_type: s.control_type.clone(),
            shortcut: s.shortcut.clone(),
            terminal_command: s.terminal_command.clone(),
            action_kind: s.action_kind.clone(),
            spoken_text: s.spoken_text.clone(),
            norm_bbox: s.bbox,
        })
        .collect()
}

/// Compiles a session's goal and resolved steps into a `CompiledPlaybookDto` in SQLite.
/// Clusters semantically equivalent goals (`>= 0.72`) and enforces truthful confidence:
/// unverified sessions stay `"inferred"` (`<= 0.55`), and only `verified == true` promotes to `"verified"`.
pub fn compile_session_into_playbook(
    db: &DbState,
    app_exe: &str,
    window_title: &str,
    goal: &str,
    steps: &[ResolvedStep],
    verified: bool,
) -> Result<Option<CompiledPlaybookDto>, String> {
    let goal_clean = goal.trim();
    if goal_clean.is_empty() || steps.is_empty() {
        return Ok(None);
    }

    let app_clean = if app_exe.trim().is_empty() {
        "Unknown"
    } else {
        app_exe.trim()
    };
    let view_key = normalize_view_key(app_clean, window_title);
    let pb_steps = to_playbook_steps(steps);
    let now = unix_now();

    let existing = db.list_playbooks_with_meta_for_app(app_clean)?;
    let vocab_idf = compute_vocab_idf(&existing);

    let mut best_match: Option<(usize, f64)> = None;
    for (idx, (pb, aliases, _)) in existing.iter().enumerate() {
        let mut sim = score_goal_match_with_aliases(goal_clean, pb, aliases, &vocab_idf);
        if pb.view_key == view_key {
            sim = (sim + 0.02).min(1.0);
        }
        if sim >= PLAYBOOK_CLUSTER_THRESHOLD {
            match best_match {
                Some((_, best_sim)) if sim <= best_sim => {}
                _ => best_match = Some((idx, sim)),
            }
        }
    }

    let (compiled, aliases_to_save) = if let Some((idx, _)) = best_match {
        let (mut pb, mut aliases, _) = existing[idx].clone();
        if !aliases
            .iter()
            .any(|a| a.eq_ignore_ascii_case(goal_clean))
        {
            if aliases.len() >= 12 {
                aliases.remove(0);
            }
            aliases.push(goal_clean.to_string());
        }
        pb.view_key = view_key;
        pb.updated_at = now;

        if verified {
            pb.confidence_tier = "verified".to_string();
            pb.success_count += 1;
            pb.confidence_score = (pb.confidence_score + 0.15).clamp(0.80, 1.0);
            pb.steps = pb_steps;
        } else if pb.confidence_tier == "inferred" {
            pb.confidence_score = pb.confidence_score.min(0.55);
            pb.steps = pb_steps;
        }
        // If existing is already "verified" or "stale" and verified == false, do NOT alter tier/steps.
        (pb, aliases)
    } else {
        let slug = app_slug(app_clean);
        let id = format!(
            "pb:{}:{}",
            slug,
            fnv1a_64_hex(&format!("{}::{}", view_key, goal_clean.to_ascii_lowercase()))
        );
        let (confidence_tier, confidence_score, success_count) = if verified {
            ("verified".to_string(), 0.85, 1)
        } else {
            ("inferred".to_string(), 0.50, 0)
        };
        let pb = CompiledPlaybookDto {
            id,
            app_exe: app_clean.to_string(),
            view_key,
            canonical_goal: goal_clean.to_string(),
            display_label: make_display_label(goal_clean),
            confidence_tier,
            confidence_score,
            success_count,
            failure_count: 0,
            tokens_saved_est: 0,
            steps: pb_steps,
            updated_at: now,
        };
        (pb, vec![goal_clean.to_string()])
    };

    db.upsert_compiled_playbook(&compiled, &aliases_to_save)?;
    Ok(Some(compiled))
}

/// Finds the highest-scoring verified playbook eligible for Tier-0 zero-token execution.
pub fn find_best_tier0_playbook(
    db: &DbState,
    app_exe: &str,
    window_title: &str,
    query: &str,
) -> Option<(CompiledPlaybookDto, f64)> {
    let query_clean = query.trim();
    if query_clean.is_empty() {
        return None;
    }

    let items = db.list_playbooks_with_meta_for_app(app_exe).ok()?;
    if items.is_empty() {
        return None;
    }

    let vocab_idf = compute_vocab_idf(&items);
    let current_view = normalize_view_key(app_exe, window_title);

    let mut best: Option<(CompiledPlaybookDto, f64)> = None;
    for (pb, aliases, _) in items {
        if pb.confidence_tier != "verified"
            || pb.confidence_score < TIER0_MIN_CONFIDENCE
            || pb.steps.is_empty()
        {
            continue;
        }
        let score = score_goal_match_with_aliases(query_clean, &pb, &aliases, &vocab_idf);
        if score < TIER0_MIN_MATCH_SCORE {
            continue;
        }
        let rank_score = if pb.view_key == current_view {
            (score + 0.02).min(1.0)
        } else {
            score
        };
        match &best {
            Some((_, best_score)) if rank_score <= *best_score => {}
            _ => best = Some((pb, score)),
        }
    }

    best
}

/// Finds the ID of the best matching non-stale playbook for `(app_exe, query)` regardless of tier.
pub fn find_best_matching_playbook_id(
    db: &DbState,
    app_exe: &str,
    query: &str,
) -> Option<String> {
    let query_clean = query.trim();
    if query_clean.is_empty() {
        return None;
    }
    let items = db.list_playbooks_with_meta_for_app(app_exe).ok()?;
    if items.is_empty() {
        return None;
    }
    let vocab_idf = compute_vocab_idf(&items);
    items
        .into_iter()
        .filter(|(pb, _, _)| pb.confidence_tier != "stale")
        .filter_map(|(pb, aliases, _)| {
            let s = score_goal_match_with_aliases(query_clean, &pb, &aliases, &vocab_idf);
            (s >= PLAYBOOK_CLUSTER_THRESHOLD).then_some((pb.id, s))
        })
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(id, _)| id)
}

/// Returns ranked non-stale playbooks for `app_exe` to display as 1-click Default Options.
pub fn get_default_options_for_app(
    db: &DbState,
    app_exe: &str,
    window_title: &str,
    limit: usize,
) -> DefaultOptionsResponse {
    let safe_limit = limit.clamp(1, 20);
    let app_clean = app_exe.trim();
    let current_view = normalize_view_key(app_clean, window_title);

    let mut items = db
        .list_playbooks_with_meta_for_app(app_clean)
        .unwrap_or_default();

    items.retain(|(pb, _, _)| pb.confidence_tier != "stale" && !pb.steps.is_empty());

    items.sort_by(|(a, _, hits_a), (b, _, hits_b)| {
        let a_ver = i32::from(a.confidence_tier == "verified");
        let b_ver = i32::from(b.confidence_tier == "verified");
        let a_view = i32::from(a.view_key == current_view);
        let b_view = i32::from(b.view_key == current_view);
        let a_rank = (a.success_count * 2 + *hits_a) as f64 + a.confidence_score;
        let b_rank = (b.success_count * 2 + *hits_b) as f64 + b.confidence_score;

        b_ver
            .cmp(&a_ver)
            .then_with(|| b_view.cmp(&a_view))
            .then_with(|| b_rank.partial_cmp(&a_rank).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });

    let options = items
        .into_iter()
        .take(safe_limit)
        .map(|(pb, _, _)| pb)
        .collect();

    let total_tokens_saved = db
        .get_learning_stats()
        .map(|s| s.total_tokens_saved)
        .unwrap_or(0);

    DefaultOptionsResponse {
        active_app: app_clean.to_string(),
        window_title: window_title.to_string(),
        options,
        total_tokens_saved,
    }
}

fn match_playbook_step_to_elements<'a>(
    step: &PlaybookStepDto,
    elements: &'a [GroundedElement],
) -> Option<&'a GroundedElement> {
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

        if score >= MIN_FUZZY_SCORE {
            match best {
                Some((_, best_score)) if score <= best_score => {}
                _ => best = Some((el, score)),
            }
        }
    }

    best.map(|(el, _)| el)
}

fn playbook_step_to_base_step(
    ps: &PlaybookStepDto,
    confidence: f64,
    goal_complete: bool,
) -> Step {
    Step {
        step_number: ps.step_number,
        instruction_line: ps.instruction_line.clone(),
        target_name: ps.target_name.clone(),
        control_type: ps.control_type.clone(),
        bbox: ps.norm_bbox,
        confidence: confidence.clamp(0.65, 1.0),
        shortcut: ps.shortcut.clone(),
        terminal_command: ps.terminal_command.clone(),
        explanation: None,
        spoken_text: ps.spoken_text.clone(),
        target_id: None,
        action_kind: ps.action_kind.clone(),
        companion_emotion: Some("pointing".to_string()),
        goal_complete,
    }
}

/// Verifies a compiled playbook against live UIA elements without any screenshot or LLM call.
/// Step 1 must either be a terminal/shortcut-only step OR match a visible UIA control (`>= 0.72`).
pub fn verify_playbook_on_live_uia(
    playbook: &CompiledPlaybookDto,
    monitor: &MonitorInfo,
    elements: &[GroundedElement],
) -> Option<Vec<ResolvedStep>> {
    let first = playbook.steps.first()?;
    let has_terminal = first
        .terminal_command
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty());
    let shortcut_only = first
        .shortcut
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
        && first
            .target_name
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty();

    let total = playbook.steps.len();
    let mut resolved = Vec::with_capacity(total);

    if has_terminal || shortcut_only {
        let base = playbook_step_to_base_step(first, playbook.confidence_score, total == 1);
        resolved.push(ResolvedStep::from_step(base, None, StepSource::None));
    } else {
        let matched = match_playbook_step_to_elements(first, elements)?;
        let mut base = playbook_step_to_base_step(first, playbook.confidence_score, total == 1);
        base.target_id = Some(matched.id);
        resolved.push(ResolvedStep::from_step(
            base,
            Some(matched.rect_px),
            StepSource::Uia,
        ));
    }

    for (idx, ps) in playbook.steps.iter().enumerate().skip(1) {
        let is_last = idx + 1 == total;
        if let Some(matched) = match_playbook_step_to_elements(ps, elements) {
            let mut base = playbook_step_to_base_step(ps, playbook.confidence_score, is_last);
            base.target_id = Some(matched.id);
            resolved.push(ResolvedStep::from_step(
                base,
                Some(matched.rect_px),
                StepSource::Uia,
            ));
        } else if let Some(bbox) = ps.norm_bbox {
            let rect = normalized_to_physical(bbox, monitor);
            let base = playbook_step_to_base_step(ps, playbook.confidence_score, is_last);
            if rect.w > 0 && rect.h > 0 {
                resolved.push(ResolvedStep::from_step(base, Some(rect), StepSource::Vlm));
            } else {
                resolved.push(ResolvedStep::from_step(base, None, StepSource::None));
            }
        } else {
            let base = playbook_step_to_base_step(ps, playbook.confidence_score, is_last);
            resolved.push(ResolvedStep::from_step(base, None, StepSource::None));
        }
    }

    Some(resolved)
}

/// Fast foreground window + monitor lookup without taking any screenshot or running OCR/Vision.
pub fn detect_active_window_and_monitor() -> (ActiveWindowInfo, MonitorInfo) {
    let win = detect_active_window();
    let monitor = xcap::Monitor::all()
        .ok()
        .and_then(|monitors| {
            monitors
                .iter()
                .find(|m| {
                    let mx = m.x();
                    let my = m.y();
                    let mw = m.width() as i32;
                    let mh = m.height() as i32;
                    win.center_x >= mx
                        && win.center_x < mx + mw
                        && win.center_y >= my
                        && win.center_y < my + mh
                })
                .or_else(|| monitors.iter().find(|m| m.is_primary()))
                .or_else(|| monitors.first())
                .map(|m| {
                    let scale = m.scale_factor() as f64;
                    MonitorInfo {
                        x: m.x(),
                        y: m.y(),
                        w: m.width(),
                        h: m.height(),
                        scale: if scale > 0.0 { scale } else { 1.0 },
                    }
                })
        })
        .unwrap_or_default();
    (win, monitor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{GroundedElementSource, RectPx};
    use tempfile::tempdir;

    fn sample_resolved_step(
        num: u32,
        instruction: &str,
        target: Option<&str>,
        ctrl_type: Option<&str>,
        shortcut: Option<&str>,
        terminal_cmd: Option<&str>,
        bbox: Option<[f64; 4]>,
    ) -> ResolvedStep {
        ResolvedStep {
            step_number: num,
            instruction_line: instruction.to_string(),
            target_name: target.map(String::from),
            control_type: ctrl_type.map(String::from),
            bbox,
            confidence: 0.92,
            shortcut: shortcut.map(String::from),
            terminal_command: terminal_cmd.map(String::from),
            explanation: None,
            spoken_text: Some(instruction.to_string()),
            target_id: None,
            action_kind: Some("click".to_string()),
            companion_emotion: Some("pointing".to_string()),
            goal_complete: true,
            rect_px: Some(RectPx {
                x: 100,
                y: 40,
                w: 80,
                h: 24,
            }),
            source: StepSource::Uia,
        }
    }

    #[test]
    fn normalize_view_key_collapses_workspaces_and_preserves_web_domains() {
        assert_eq!(
            normalize_view_key("Code.exe", "foo.rs - GuideLens - Visual Studio Code"),
            "code.exe:workspace"
        );
        assert_eq!(
            normalize_view_key("chrome.exe", "Q4 Roadmap - Google Docs - Google Chrome"),
            "chrome.exe:docs.google.com"
        );
        assert_eq!(
            normalize_view_key("msedge.exe", "Poster Design - Canva - Microsoft Edge"),
            "msedge.exe:canva"
        );
        assert_eq!(
            normalize_view_key("chrome.exe", "joking-really/GuideLens - GitHub"),
            "chrome.exe:github.com"
        );
        assert_eq!(
            normalize_view_key("notepad.exe", "notes.txt - Notepad"),
            "notepad.exe:main"
        );
    }

    #[test]
    fn extract_vocab_tokens_and_idf_goal_matching() {
        let toks = extract_vocab_tokens("How do I please show where the integrated terminal is?");
        assert_eq!(toks, vec!["integrated", "terminal"]);

        let pb = CompiledPlaybookDto {
            id: "pb-1".to_string(),
            app_exe: "Code.exe".to_string(),
            view_key: "code.exe:workspace".to_string(),
            canonical_goal: "Open integrated terminal".to_string(),
            display_label: "Open integrated terminal".to_string(),
            confidence_tier: "verified".to_string(),
            confidence_score: 0.9,
            success_count: 2,
            failure_count: 0,
            tokens_saved_est: 0,
            steps: vec![],
            updated_at: 100,
        };
        let idf = compute_vocab_idf(&[(pb.clone(), vec!["Launch terminal".to_string()], 0)]);

        assert!(score_goal_match("open integrated terminal", &pb, &idf) >= 0.95);
        assert!(score_goal_match("how do I open terminal", &pb, &idf) >= 0.72);
        assert!(
            score_goal_match_with_aliases("launch terminal", &pb, &["Launch terminal".to_string()], &idf)
                >= 0.95
        );
        assert!(score_goal_match("change font size", &pb, &idf) < 0.25);
    }

    #[test]
    fn compile_clusters_aliases_enforces_truthful_confidence_and_tier0_lookup() {
        let tmp = tempdir().expect("tempdir");
        let db = DbState::open(&tmp.path().join("compiler.db")).expect("open db");

        let steps = vec![sample_resolved_step(
            1,
            "Click Terminal -> New Terminal",
            Some("New Terminal"),
            Some("MenuItem"),
            Some("Ctrl+Shift+`"),
            None,
            Some([110.0, 24.0, 90.0, 22.0]),
        )];

        // Unverified session stays inferred (<= 0.55) and NEVER triggers Tier-0
        let inferred = compile_session_into_playbook(
            &db,
            "Code.exe",
            "lib.rs - GuideLens - Visual Studio Code",
            "Open integrated terminal",
            &steps,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(inferred.confidence_tier, "inferred");
        assert!(inferred.confidence_score <= 0.55);
        assert_eq!(inferred.success_count, 0);
        assert!(find_best_tier0_playbook(&db, "Code.exe", "", "open integrated terminal").is_none());

        // Verified similar goal clusters into same playbook and promotes to verified
        let verified = compile_session_into_playbook(
            &db,
            "Code.exe",
            "types.rs - GuideLens - Visual Studio Code",
            "How to open terminal",
            &steps,
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(verified.id, inferred.id);
        assert_eq!(verified.confidence_tier, "verified");
        assert!(verified.confidence_score >= 0.80);
        assert_eq!(verified.success_count, 1);

        // Tier-0 now finds it via canonical goal OR clustered alias
        let (hit, score) =
            find_best_tier0_playbook(&db, "Code.exe", "other.rs - Visual Studio Code", "open integrated terminal")
                .expect("tier0 match");
        assert_eq!(hit.id, verified.id);
        assert!(score >= 0.72);

        let (alias_hit, _) =
            find_best_tier0_playbook(&db, "Code.exe", "other.rs - Visual Studio Code", "how to open terminal")
                .expect("tier0 alias match");
        assert_eq!(alias_hit.id, verified.id);

        // Default options includes verified first and excludes stale after 2 failures
        let defaults = get_default_options_for_app(&db, "Code.exe", "Visual Studio Code", 5);
        assert_eq!(defaults.options.len(), 1);

        db.record_playbook_feedback(&verified.id, false).unwrap();
        db.record_playbook_feedback(&verified.id, false).unwrap();
        assert!(find_best_tier0_playbook(&db, "Code.exe", "", "open integrated terminal").is_none());
        let defaults_after_stale =
            get_default_options_for_app(&db, "Code.exe", "Visual Studio Code", 5);
        assert!(defaults_after_stale.options.is_empty());
    }

    #[test]
    fn verify_playbook_on_live_uia_handles_visible_missing_and_terminal_steps() {
        let mon = MonitorInfo::default();
        let pb = CompiledPlaybookDto {
            id: "pb-uia".to_string(),
            app_exe: "Code.exe".to_string(),
            view_key: "code.exe:workspace".to_string(),
            canonical_goal: "Open settings and toggle autosave".to_string(),
            display_label: "Open settings".to_string(),
            confidence_tier: "verified".to_string(),
            confidence_score: 0.9,
            success_count: 2,
            failure_count: 0,
            tokens_saved_est: 0,
            steps: vec![
                PlaybookStepDto {
                    step_number: 1,
                    instruction_line: "Click Manage".to_string(),
                    target_name: Some("Manage".to_string()),
                    control_type: Some("Button".to_string()),
                    shortcut: Some("Ctrl+,".to_string()),
                    terminal_command: None,
                    action_kind: Some("click".to_string()),
                    spoken_text: Some("Click Manage".to_string()),
                    norm_bbox: Some([10.0, 920.0, 30.0, 30.0]),
                },
                PlaybookStepDto {
                    step_number: 2,
                    instruction_line: "Click Auto Save".to_string(),
                    target_name: Some("Auto Save".to_string()),
                    control_type: Some("CheckBox".to_string()),
                    shortcut: None,
                    terminal_command: None,
                    action_kind: Some("click".to_string()),
                    spoken_text: None,
                    norm_bbox: Some([250.0, 300.0, 100.0, 20.0]),
                },
            ],
            updated_at: 100,
        };

        // Missing step 1 control -> returns None
        assert!(verify_playbook_on_live_uia(&pb, &mon, &[]).is_none());

        // Step 1 visible in UIA -> returns Step 1 as StepSource::Uia and Step 2 via norm_bbox (StepSource::Vlm)
        let elements = vec![GroundedElement {
            id: 4,
            label: "Manage".to_string(),
            control_type: "Button".to_string(),
            rect_px: RectPx {
                x: 16,
                y: 980,
                w: 44,
                h: 44,
            },
            norm_bbox: [8.3, 907.4, 22.9, 40.7],
            source: GroundedElementSource::Uia,
            is_taskbar: false,
        }];

        let resolved = verify_playbook_on_live_uia(&pb, &mon, &elements).expect("should verify");
        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved[0].source, StepSource::Uia);
        assert_eq!(resolved[0].rect_px, Some(elements[0].rect_px));
        assert_eq!(resolved[1].source, StepSource::Vlm);
        assert_eq!(
            resolved[1].rect_px,
            Some(RectPx {
                x: 480,
                y: 324,
                w: 192,
                h: 22
            })
        );

        // Terminal step passes immediately with empty UIA
        let term_pb = CompiledPlaybookDto {
            id: "pb-term".to_string(),
            steps: vec![PlaybookStepDto {
                step_number: 1,
                instruction_line: "Run git status".to_string(),
                target_name: None,
                control_type: None,
                shortcut: None,
                terminal_command: Some("git status".to_string()),
                action_kind: Some("terminal".to_string()),
                spoken_text: None,
                norm_bbox: None,
            }],
            ..pb
        };
        let term_res = verify_playbook_on_live_uia(&term_pb, &mon, &[]).expect("terminal passes");
        assert_eq!(term_res.len(), 1);
        assert_eq!(term_res[0].terminal_command.as_deref(), Some("git status"));
    }
}
