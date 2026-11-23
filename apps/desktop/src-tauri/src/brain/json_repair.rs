//! JSON extraction, syntax repair, and StepPlan schema validation (`decisions.md` §3).

use crate::types::{Step, StepMode, StepPlan, MAX_INSTRUCTION_CHARS};
use serde_json::Value;

/// Extracts and repairs a raw LLM text response into a validated `StepPlan`.
pub fn parse_and_repair_step_plan(raw: &str) -> Result<StepPlan, String> {
    let extracted = extract_json_candidate(raw)
        .ok_or_else(|| "No JSON object found in model output".to_string())?;

    let val: Value = serde_json::from_str(&extracted)
        .or_else(|_| {
            let cleaned = sanitize_json_syntax(&extracted);
            serde_json::from_str(&cleaned)
        })
        .map_err(|e| format!("Failed to parse StepPlan JSON: {}", e))?;

    repair_value_to_step_plan(&val)
}

/// Finds the primary JSON object `{ ... }` or array `[ ... ]` inside raw model output,
/// stripping markdown code fences and surrounding prose.
pub fn extract_json_candidate(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 1. Check for ```json ... ``` or ``` ... ``` fenced blocks
    if let Some(fence_start) = trimmed.find("```") {
        let after_ticks = &trimmed[fence_start + 3..];
        let content_start = after_ticks
            .find('\n')
            .map(|idx| {
                let first_line = after_ticks[..idx].trim();
                if first_line.is_empty()
                    || first_line.eq_ignore_ascii_case("json")
                    || first_line.eq_ignore_ascii_case("jsonc")
                {
                    idx + 1
                } else {
                    0
                }
            })
            .unwrap_or(0);
        let body = &after_ticks[content_start..];
        if let Some(fence_end) = body.find("```") {
            let inside = body[..fence_end].trim();
            if let Some(balanced) = find_balanced_json(inside) {
                return Some(balanced);
            }
        }
    }

    // 2. Fallback: find first balanced `{ ... }` or `[ ... ]` in the raw text
    find_balanced_json(trimmed)
}

fn find_balanced_json(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut start_idx = None;
    let mut open_char = b'{';
    let mut close_char = b'}';

    for (i, &b) in bytes.iter().enumerate() {
        if b == b'{' {
            start_idx = Some(i);
            open_char = b'{';
            close_char = b'}';
            break;
        } else if b == b'[' {
            start_idx = Some(i);
            open_char = b'[';
            close_char = b']';
            break;
        }
    }

    let start = start_idx?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;

    for (offset, &b) in bytes[start..].iter().enumerate() {
        if escape {
            escape = false;
            continue;
        }
        if in_string {
            if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        if b == b'"' {
            in_string = true;
        } else if b == open_char {
            depth += 1;
        } else if b == close_char {
            depth -= 1;
            if depth == 0 {
                return Some(s[start..=start + offset].to_string());
            }
        }
    }

    // If truncated before closing brace, grab from `start` to end and close braces in sanitizer
    let mut partial = s[start..].to_string();
    while depth > 0 {
        partial.push(close_char as char);
        depth -= 1;
    }
    Some(partial)
}

/// Repairs common JSON syntax mistakes from LLMs:
/// - Single-line `//` comments outside string literals
/// - Unescaped raw newlines/tabs inside string literals
/// - Trailing commas before `}` or `]`
pub fn sanitize_json_syntax(input: &str) -> String {
    let mut without_comments = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    let mut in_string = false;
    let mut escape = false;

    while i < chars.len() {
        let c = chars[i];
        if escape {
            without_comments.push(c);
            escape = false;
            i += 1;
            continue;
        }
        if in_string {
            if c == '\\' {
                without_comments.push(c);
                escape = true;
            } else if c == '"' {
                without_comments.push(c);
                in_string = false;
            } else if c == '\n' || c == '\r' || c == '\t' {
                without_comments.push(' ');
            } else {
                without_comments.push(c);
            }
            i += 1;
            continue;
        }

        // Outside string literal
        if c == '"' {
            in_string = true;
            without_comments.push(c);
            i += 1;
            continue;
        }

        // Strip `// ...` line comment
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }

        // Strip `/* ... */` block comment
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            continue;
        }

        without_comments.push(c);
        i += 1;
    }

    remove_trailing_commas(&without_comments)
}

fn remove_trailing_commas(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escape = false;
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if escape {
            out.push(c);
            escape = false;
            i += 1;
            continue;
        }
        if in_string {
            if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            out.push(c);
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == ',' {
            let mut lookahead = i + 1;
            while lookahead < chars.len() && chars[lookahead].is_whitespace() {
                lookahead += 1;
            }
            if lookahead < chars.len() && (chars[lookahead] == '}' || chars[lookahead] == ']') {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

fn parse_f64_loose(v: &Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        Some(n)
    } else if let Some(i) = v.as_i64() {
        Some(i as f64)
    } else if let Some(s) = v.as_str() {
        s.trim().parse::<f64>().ok()
    } else {
        None
    }
}

fn repair_bbox(v: Option<&Value>) -> Option<[f64; 4]> {
    let raw = v?;
    if raw.is_null() {
        return None;
    }
    if let Some(arr) = raw.as_array() {
        if arr.len() != 4 {
            return None;
        }
        let x = parse_f64_loose(&arr[0])?.clamp(0.0, 1000.0);
        let y = parse_f64_loose(&arr[1])?.clamp(0.0, 1000.0);
        let w = parse_f64_loose(&arr[2])?.clamp(0.0, 1000.0).min(1000.0 - x);
        let h = parse_f64_loose(&arr[3])?.clamp(0.0, 1000.0).min(1000.0 - y);
        if w <= 0.0 || h <= 0.0 {
            return None;
        }
        return Some([x, y, w, h]);
    }
    if let Some(obj) = raw.as_object() {
        let x = parse_f64_loose(obj.get("x")?)?.clamp(0.0, 1000.0);
        let y = parse_f64_loose(obj.get("y")?)?.clamp(0.0, 1000.0);
        let w = parse_f64_loose(obj.get("w").or_else(|| obj.get("width"))?)?
            .clamp(0.0, 1000.0)
            .min(1000.0 - x);
        let h = parse_f64_loose(obj.get("h").or_else(|| obj.get("height"))?)?
            .clamp(0.0, 1000.0)
            .min(1000.0 - y);
        if w <= 0.0 || h <= 0.0 {
            return None;
        }
        return Some([x, y, w, h]);
    }
    None
}

fn repair_confidence(v: Option<&Value>, has_bbox: bool) -> f64 {
    let default_conf = if has_bbox { 0.8 } else { 0.6 };
    let Some(val) = v else {
        return default_conf;
    };
    let Some(mut num) = parse_f64_loose(val) else {
        return default_conf;
    };
    if num > 1.0 && num <= 100.0 {
        num /= 100.0;
    }
    num.clamp(0.0, 1.0)
}

fn clean_opt_string(v: Option<&Value>, max_chars: usize) -> Option<String> {
    let s = v?.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    let count = collapsed.chars().count();
    if count <= max_chars {
        Some(collapsed)
    } else {
        let truncated: String = collapsed.chars().take(max_chars.saturating_sub(1)).collect();
        Some(format!("{}…", truncated.trim_end()))
    }
}

pub fn repair_value_to_step_plan(root: &Value) -> Result<StepPlan, String> {
    let (raw_mode, raw_steps_vec): (Option<&str>, Vec<&Value>) = match root {
        Value::Object(map) => {
            let mode_str = map.get("mode").and_then(|m| m.as_str());
            if let Some(arr) = map.get("steps").and_then(|s| s.as_array()) {
                (mode_str, arr.iter().collect())
            } else if map.contains_key("instruction_line")
                || map.contains_key("instruction")
                || map.contains_key("terminal_command")
            {
                (mode_str, vec![root])
            } else {
                return Err("StepPlan JSON object missing 'steps' array".to_string());
            }
        }
        Value::Array(arr) => (None, arr.iter().collect()),
        _ => return Err("StepPlan JSON root must be an object or array".to_string()),
    };

    if raw_steps_vec.is_empty() {
        return Err("StepPlan 'steps' array must not be empty".to_string());
    }

    let mut steps = Vec::with_capacity(raw_steps_vec.len());
    let mut has_terminal_command = false;

    for raw_step in raw_steps_vec {
        let Some(obj) = raw_step.as_object() else {
            continue;
        };

        let raw_instruction = obj
            .get("instruction_line")
            .or_else(|| obj.get("instruction"))
            .or_else(|| obj.get("text"))
            .or_else(|| obj.get("explanation"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();

        let terminal_command = obj
            .get("terminal_command")
            .or_else(|| obj.get("command"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        if terminal_command.is_some() {
            has_terminal_command = true;
        }

        let fallback_instruction = if raw_instruction.is_empty() {
            if let Some(ref cmd) = terminal_command {
                format!("Run command: {}", cmd)
            } else {
                continue;
            }
        } else {
            raw_instruction.to_string()
        };

        let instruction_line = Step::clamp_instruction(&fallback_instruction);
        if instruction_line.is_empty() {
            continue;
        }

        let initial_bbox = repair_bbox(obj.get("bbox"));
        let confidence = repair_confidence(obj.get("confidence"), initial_bbox.is_some());

        // Per decisions.md §1 & non_functional_requirements.md §3:
        // If confidence < 0.5 -> text only, no misleading VLM highlight box.
        let bbox = if confidence < 0.5 {
            None
        } else {
            initial_bbox
        };

        let target_name = clean_opt_string(
            obj.get("target_name").or_else(|| obj.get("target")),
            120,
        );
        let control_type = clean_opt_string(obj.get("control_type"), 60);
        let shortcut = clean_opt_string(obj.get("shortcut"), 40);
        let explanation = clean_opt_string(obj.get("explanation"), MAX_INSTRUCTION_CHARS);
        let spoken_text = clean_opt_string(obj.get("spoken_text"), MAX_INSTRUCTION_CHARS);

        let step_number = (steps.len() + 1) as u32;
        steps.push(Step {
            step_number,
            instruction_line,
            target_name,
            control_type,
            bbox,
            confidence,
            shortcut,
            terminal_command,
            explanation,
            spoken_text,
        });
    }

    if steps.is_empty() {
        return Err("No valid steps found in StepPlan JSON".to_string());
    }

    let mode = match raw_mode.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("terminal") | Some("cli") => StepMode::Terminal,
        Some("explain") | Some("explanation") => StepMode::Explain,
        Some("guide") => StepMode::Guide,
        _ if has_terminal_command => StepMode::Terminal,
        _ => StepMode::Guide,
    };

    let mut plan = StepPlan {
        mode,
        total_steps: steps.len() as u32,
        steps,
    };
    plan.enforce_limits();
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_step_plan_json() {
        let raw = r#"{
            "mode": "guide",
            "total_steps": 2,
            "steps": [
                {
                    "step_number": 1,
                    "instruction_line": "Click the Object Selection Tool in the left toolbar, or press W.",
                    "target_name": "Object Selection Tool",
                    "control_type": "Button",
                    "bbox": [12, 180, 32, 32],
                    "confidence": 0.92,
                    "shortcut": "W",
                    "terminal_command": null,
                    "explanation": null
                },
                {
                    "step_number": 2,
                    "instruction_line": "Click Select Subject in the top options bar.",
                    "target_name": "Select Subject",
                    "control_type": "Button",
                    "bbox": [420, 48, 95, 24],
                    "confidence": 0.88
                }
            ]
        }"#;

        let plan = parse_and_repair_step_plan(raw).expect("valid StepPlan");
        assert_eq!(plan.mode, StepMode::Guide);
        assert_eq!(plan.total_steps, 2);
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(
            plan.steps[0].target_name.as_deref(),
            Some("Object Selection Tool")
        );
        assert_eq!(plan.steps[0].bbox, Some([12.0, 180.0, 32.0, 32.0]));
    }

    #[test]
    fn repairs_markdown_fences_comments_and_trailing_commas() {
        let noisy = r#"Here is the step plan for your screen:
```json
{
  // Mode of guidance
  "mode": "guide",
  "total_steps": 99,
  "steps": [
    {
      "step_number": 1,
      "instruction_line": "Click File in the top-left menu bar.",
      "target_name": "File",
      "control_type": "MenuItem",
      "bbox": [10, 8, 35, 20],
      "confidence": 85, // percentage repaired to 0.85
    },
  ],
}
```
Hope this helps!"#;

        let plan = parse_and_repair_step_plan(noisy).expect("repaired StepPlan");
        assert_eq!(plan.total_steps, 1);
        assert_eq!(plan.steps.len(), 1);
        assert!((plan.steps[0].confidence - 0.85).abs() < 1e-6);
        assert_eq!(plan.steps[0].bbox, Some([10.0, 8.0, 35.0, 20.0]));
    }

    #[test]
    fn enforces_140_char_limit_and_strips_low_confidence_bbox() {
        let long_line = "Click the very deeply nested advanced configuration button inside the third sub-panel of the application preferences dialog box on the bottom right corner of your display right now.";
        assert!(long_line.chars().count() > 140);

        let raw = format!(
            r#"{{
                "instruction_line": "{}",
                "target_name": "Advanced",
                "bbox": [100, 200, 50, 30],
                "confidence": 0.35
            }}"#,
            long_line
        );

        let plan = parse_and_repair_step_plan(&raw).expect("repaired flat step");
        assert_eq!(plan.steps.len(), 1);
        let step = &plan.steps[0];
        assert!(
            step.instruction_line.chars().count() <= MAX_INSTRUCTION_CHARS,
            "instruction_line length {} exceeded {}",
            step.instruction_line.chars().count(),
            MAX_INSTRUCTION_CHARS
        );
        assert!(step.instruction_line.ends_with('…'));
        assert_eq!(
            step.bbox, None,
            "Confidence < 0.5 must strip VLM bbox to avoid misleading highlight"
        );
    }

    #[test]
    fn infers_terminal_mode_when_terminal_command_present() {
        let raw = r#"{
            "steps": [{
                "instruction_line": "Undo last commit while keeping changes staged.",
                "terminal_command": "git reset --soft HEAD~1",
                "explanation": "Moves HEAD back one commit and leaves files staged."
            }]
        }"#;

        let plan = parse_and_repair_step_plan(raw).expect("terminal plan");
        assert_eq!(plan.mode, StepMode::Terminal);
        assert_eq!(
            plan.steps[0].terminal_command.as_deref(),
            Some("git reset --soft HEAD~1")
        );
    }

    #[test]
    fn repairs_and_clamps_optional_spoken_text() {
        let long_spoken = "Click the super deeply nested settings button that I just highlighted over on the far right side of the configuration pane so we can open options right away.";
        assert!(long_spoken.chars().count() > MAX_INSTRUCTION_CHARS);

        let raw = format!(
            r#"```json
            {{
                "mode": "guide",
                "steps": [
                    {{
                        "instruction_line": "Click File.",
                        "spoken_text": "  Click File   at the top left\n  to open the menu.  ",
                        "confidence": 0.9
                    }},
                    {{
                        "instruction_line": "Click Settings.",
                        "spoken_text": "{}",
                        "confidence": 0.9
                    }},
                    {{
                        "instruction_line": "Click Save.",
                        "spoken_text": "   ",
                        "confidence": 0.9
                    }}
                ]
            }}
            ```"#,
            long_spoken
        );

        let plan = parse_and_repair_step_plan(&raw).expect("repaired spoken_text plan");
        assert_eq!(
            plan.steps[0].spoken_text.as_deref(),
            Some("Click File at the top left to open the menu.")
        );
        let clamped = plan.steps[1]
            .spoken_text
            .as_deref()
            .expect("clamped spoken_text");
        assert_eq!(clamped.chars().count(), MAX_INSTRUCTION_CHARS);
        assert!(clamped.ends_with('…'));
        assert_eq!(plan.steps[2].spoken_text, None);
    }
}
