//! Fast (`<3ms`) SQLite Knowledge Graph hint retriever for prompt injection.

use crate::db::DbState;
use crate::types::{KgEdgeDto, KgNodeDto, KnowledgeGraphDto};
use std::collections::{BTreeSet, HashMap, HashSet};

const MAX_MEMORY_HINTS: usize = 5;

fn tokenize(text: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "the", "to", "in", "a", "an", "of", "on", "for", "and", "or", "is", "how", "do", "i",
        "can", "you", "my", "this", "that", "with", "from", "into", "please", "open", "click",
        "exe",
    ];
    let stop: HashSet<&str> = STOPWORDS.iter().copied().collect();
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch.to_ascii_lowercase());
        } else if !current.is_empty() {
            if current.len() >= 2 && !stop.contains(current.as_str()) {
                out.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if current.len() >= 2 && !stop.contains(current.as_str()) {
        out.push(current);
    }
    out
}

fn query_app_candidates(db: &DbState, active_app: &str) -> Option<KnowledgeGraphDto> {
    let trimmed = active_app.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(kg) = db.query_kg_for_app(trimmed, 80) {
        if !kg.edges.is_empty() {
            return Some(kg);
        }
    }

    let lower = trimmed.to_ascii_lowercase();
    let alt = if lower.ends_with(".exe") && trimmed.len() > 4 {
        trimmed[..trimmed.len() - 4].to_string()
    } else {
        format!("{}.exe", trimmed)
    };

    db.query_kg_for_app(&alt, 80)
        .ok()
        .filter(|kg| !kg.edges.is_empty())
}

struct ScoredEdge<'a> {
    edge: &'a KgEdgeDto,
    score: f64,
    query_hits: usize,
}

fn score_edge<'a>(
    edge: &'a KgEdgeDto,
    node_map: &HashMap<&str, &'a KgNodeDto>,
    query_lower: &str,
    query_tokens: &[String],
    title_tokens: &[String],
) -> ScoredEdge<'a> {
    let from_label = node_map
        .get(edge.from_node.as_str())
        .map(|n| n.label.as_str())
        .unwrap_or("");
    let to_label = node_map
        .get(edge.to_node.as_str())
        .map(|n| n.label.as_str())
        .unwrap_or("");

    let combined = format!(
        "{} {} {} {} {} {}",
        edge.intent,
        edge.control_name.as_deref().unwrap_or(""),
        edge.control_type.as_deref().unwrap_or(""),
        edge.shortcut.as_deref().unwrap_or(""),
        from_label,
        to_label
    );
    let combined_lower = combined.to_ascii_lowercase();
    let edge_token_set: HashSet<String> = tokenize(&combined).into_iter().collect();

    let mut score = (edge.success_count.max(1) as f64).ln_1p() * 1.5;
    let mut query_hits = 0usize;

    if !query_lower.is_empty() {
        let intent_lower = edge.intent.to_ascii_lowercase();
        if intent_lower.contains(query_lower) || query_lower.contains(&intent_lower) {
            score += 8.0;
            query_hits += 2;
        }
        for tok in query_tokens {
            if edge_token_set.contains(tok) || combined_lower.contains(tok.as_str()) {
                score += 3.2;
                query_hits += 1;
            }
        }
    }

    for tok in title_tokens {
        if edge_token_set.contains(tok) {
            score += 1.4;
        }
    }

    if edge.shortcut.as_deref().is_some_and(|s| !s.trim().is_empty()) {
        score += 1.0;
    }
    if edge.norm_bbox.is_some() {
        score += 0.75;
    }
    if edge
        .control_name
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
    {
        score += 0.5;
    }

    ScoredEdge {
        edge,
        score,
        query_hits,
    }
}

fn format_edge_hint(edge: &KgEdgeDto, node_map: &HashMap<&str, &KgNodeDto>) -> String {
    let control = edge
        .control_name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            node_map
                .get(edge.to_node.as_str())
                .map(|n| n.label.as_str())
        })
        .unwrap_or("UI control");

    let ctrl_type = edge
        .control_type
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|t| format!(" ({})", t))
        .unwrap_or_default();

    let mut parts = vec![format!("{} -> {}{}", edge.intent.trim(), control, ctrl_type)];
    if let Some(sc) = edge.shortcut.as_deref().filter(|s| !s.trim().is_empty()) {
        parts.push(format!("Shortcut: {}", sc.trim()));
    }
    if let Some([x, y, w, h]) = edge.norm_bbox {
        parts.push(format!(
            "Coords: [{:.0},{:.0},{:.0},{:.0}]",
            x, y, w, h
        ));
    }
    if edge.success_count > 1 {
        parts.push(format!("Verified {}x", edge.success_count));
    }
    format!("- [{}]", parts.join(" | "))
}

/// Fast (`<3ms`) SQLite Knowledge Graph lookup returning up to 5 verified
/// `[Intent -> Control / Shortcut / Coords]` hint lines for prompt injection.
pub fn retrieve_memory_hints(
    db: &DbState,
    active_app: &str,
    window_title: &str,
    query: &str,
) -> String {
    let Some(kg) = query_app_candidates(db, active_app) else {
        return String::new();
    };

    let node_map: HashMap<&str, &KgNodeDto> =
        kg.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let query_lower = query.trim().to_ascii_lowercase();
    let query_tokens = tokenize(query);
    let title_tokens = tokenize(window_title);

    let mut scored: Vec<ScoredEdge<'_>> = kg
        .edges
        .iter()
        .map(|edge| score_edge(edge, &node_map, &query_lower, &query_tokens, &title_tokens))
        .collect();

    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.edge.success_count.cmp(&a.edge.success_count))
            .then_with(|| b.edge.updated_at.cmp(&a.edge.updated_at))
    });

    let any_query_hit = scored.iter().any(|s| s.query_hits > 0);
    let mut seen_controls: BTreeSet<String> = BTreeSet::new();
    let mut lines = Vec::new();

    for item in scored {
        if any_query_hit && item.query_hits == 0 && item.edge.success_count < 2 {
            continue;
        }
        let dedup_key = format!(
            "{}::{}::{}",
            item.edge
                .control_name
                .as_deref()
                .unwrap_or("")
                .to_ascii_lowercase(),
            item.edge
                .shortcut
                .as_deref()
                .unwrap_or("")
                .to_ascii_lowercase(),
            item.edge.intent.to_ascii_lowercase()
        );
        if !seen_controls.insert(dedup_key) {
            continue;
        }
        lines.push(format_edge_hint(item.edge, &node_map));
        if lines.len() >= MAX_MEMORY_HINTS {
            break;
        }
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tempfile::tempdir;

    #[test]
    fn test_retrieve_memory_hints_ranks_relevant_and_fast() {
        let tmp = tempdir().expect("tempdir");
        let db = DbState::open(&tmp.path().join("retriever.db")).expect("open db");

        db.upsert_kg_node(&KgNodeDto {
            id: "app:code".to_string(),
            node_type: "app".to_string(),
            app_exe: "Code.exe".to_string(),
            label: "Visual Studio Code".to_string(),
            metadata_json: None,
            hit_count: 1,
            updated_at: 100,
        })
        .unwrap();

        let controls = [
            ("ctrl:palette", "Command Palette", "Ctrl+Shift+P", "Open command palette", 2),
            ("ctrl:terminal", "New Terminal", "Ctrl+Shift+`", "Open integrated terminal", 4),
            ("ctrl:settings", "Settings", "Ctrl+,", "Open editor settings", 1),
            ("ctrl:sidebar", "Toggle Primary Side Bar", "Ctrl+B", "Hide explorer sidebar", 3),
            ("ctrl:search", "Find in Files", "Ctrl+Shift+F", "Search across workspace", 2),
            ("ctrl:debug", "Run and Debug", "Ctrl+Shift+D", "Start debugger session", 1),
        ];

        for (i, (id, name, shortcut, intent, hits)) in controls.iter().enumerate() {
            db.upsert_kg_node(&KgNodeDto {
                id: (*id).to_string(),
                node_type: "control".to_string(),
                app_exe: "Code.exe".to_string(),
                label: (*name).to_string(),
                metadata_json: None,
                hit_count: *hits,
                updated_at: 110 + i as i64,
            })
            .unwrap();
            db.upsert_kg_edge(&KgEdgeDto {
                id: format!("edge:{}", id),
                from_node: "app:code".to_string(),
                to_node: (*id).to_string(),
                relation: "verified_step".to_string(),
                intent: (*intent).to_string(),
                control_name: Some((*name).to_string()),
                control_type: Some("MenuItem".to_string()),
                shortcut: Some((*shortcut).to_string()),
                norm_bbox: Some([100.0 + i as f64 * 10.0, 30.0, 60.0, 20.0]),
                success_count: *hits,
                updated_at: 120 + i as i64,
            })
            .unwrap();
        }

        let start = Instant::now();
        let hints = retrieve_memory_hints(
            &db,
            "Code.exe",
            "lib.rs - GuideLens - Visual Studio Code",
            "how do I open the integrated terminal",
        );
        let elapsed = start.elapsed();

        assert!(!hints.is_empty());
        let lines: Vec<&str> = hints.lines().collect();
        assert!(lines.len() <= MAX_MEMORY_HINTS);
        assert!(
            lines[0].contains("New Terminal") && lines[0].contains("Ctrl+Shift+`"),
            "Expected top hint to be New Terminal, got:\n{}",
            hints
        );
        assert!(
            elapsed.as_millis() < 25,
            "Expected fast SQLite KG lookup, took {:?}",
            elapsed
        );
    }

    #[test]
    fn test_retrieve_memory_hints_empty_app_returns_empty() {
        let tmp = tempdir().expect("tempdir");
        let db = DbState::open(&tmp.path().join("empty.db")).expect("open db");
        assert_eq!(retrieve_memory_hints(&db, "UnknownApp.exe", "", "save"), "");
    }
}
