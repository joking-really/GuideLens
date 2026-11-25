//! System prompt builder, companion persona styling, Set-of-Mark grounding injection,
//! and embedded TOML profiles for the 15 priority Windows apps.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShortcutEntry {
    pub action: String,
    pub keys: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppProfile {
    pub id: String,
    pub display_name: String,
    pub exe_patterns: Vec<String>,
    #[serde(default)]
    pub title_patterns: Vec<String>,
    #[serde(default)]
    pub terminal_mode: bool,
    #[serde(default)]
    pub ui_layout_hints: Vec<String>,
    #[serde(default)]
    pub shortcuts: Vec<ShortcutEntry>,
}

const RAW_PROFILES: &[(&str, &str)] = &[
    ("photoshop", include_str!("profiles/photoshop.toml")),
    ("excel", include_str!("profiles/excel.toml")),
    ("powerpoint", include_str!("profiles/powerpoint.toml")),
    ("google_docs", include_str!("profiles/google_docs.toml")),
    ("word", include_str!("profiles/word.toml")),
    ("canva", include_str!("profiles/canva.toml")),
    ("premiere_pro", include_str!("profiles/premiere_pro.toml")),
    ("after_effects", include_str!("profiles/after_effects.toml")),
    ("vscode", include_str!("profiles/vscode.toml")),
    ("github_desktop", include_str!("profiles/github_desktop.toml")),
    ("windows_terminal", include_str!("profiles/windows_terminal.toml")),
    ("opencode", include_str!("profiles/opencode.toml")),
    ("antigravity", include_str!("profiles/antigravity.toml")),
    ("windows_settings", include_str!("profiles/windows_settings.toml")),
    ("chrome", include_str!("profiles/chrome.toml")),
];

static PROFILES_CACHE: OnceLock<Vec<AppProfile>> = OnceLock::new();

/// Returns all 15 embedded priority app profiles.
pub fn all_profiles() -> &'static [AppProfile] {
    PROFILES_CACHE
        .get_or_init(|| {
            RAW_PROFILES
                .iter()
                .filter_map(|(name, raw)| match toml::from_str::<AppProfile>(raw) {
                    Ok(p) => Some(p),
                    Err(e) => {
                        log::error!("Failed to parse embedded profile {}: {}", name, e);
                        None
                    }
                })
                .collect()
        })
        .as_slice()
}

/// Finds the best matching app profile for the given executable name and window title.
pub fn match_app_profile(active_exe: &str, window_title: &str) -> Option<&'static AppProfile> {
    let exe_lower = active_exe.trim().to_ascii_lowercase();
    let exe_base = exe_lower
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&exe_lower);
    let title_lower = window_title.trim().to_ascii_lowercase();

    let profiles = all_profiles();
    let is_browser_exe = matches!(
        exe_base,
        "chrome.exe" | "msedge.exe" | "brave.exe" | "firefox.exe" | "chrome"
    );

    if is_browser_exe && !title_lower.is_empty() {
        for web_id in ["google_docs", "canva"] {
            if let Some(p) = profiles.iter().find(|p| p.id == web_id) {
                if p.title_patterns
                    .iter()
                    .any(|pat| !pat.is_empty() && title_lower.contains(&pat.to_ascii_lowercase()))
                {
                    return Some(p);
                }
            }
        }
    }

    if !exe_base.is_empty() {
        for profile in profiles {
            if profile.id == "chrome" {
                continue;
            }
            if profile
                .exe_patterns
                .iter()
                .any(|pat| exe_base == pat.to_ascii_lowercase())
            {
                return Some(profile);
            }
        }
        for profile in profiles {
            if profile.id == "chrome" {
                continue;
            }
            if profile.exe_patterns.iter().any(|pat| {
                let pat_l = pat.to_ascii_lowercase();
                exe_base.contains(&pat_l)
            }) {
                return Some(profile);
            }
        }
    }

    if !title_lower.is_empty() {
        for profile in profiles {
            if profile.id == "chrome" {
                continue;
            }
            if profile
                .title_patterns
                .iter()
                .any(|pat| !pat.is_empty() && title_lower.contains(&pat.to_ascii_lowercase()))
            {
                return Some(profile);
            }
        }
    }

    if let Some(chrome) = profiles.iter().find(|p| p.id == "chrome") {
        let exe_match = !exe_base.is_empty()
            && chrome.exe_patterns.iter().any(|pat| {
                let pat_l = pat.to_ascii_lowercase();
                exe_base == pat_l || exe_base.contains(&pat_l)
            });
        let title_match = !title_lower.is_empty()
            && chrome
                .title_patterns
                .iter()
                .any(|pat| !pat.is_empty() && title_lower.contains(&pat.to_ascii_lowercase()));
        if exe_match || title_match {
            return Some(chrome);
        }
    }

    None
}

/// Shared base system prompt demanding strict `StepPlan` JSON per `decisions.md` §3 + v2 SoM grounding fields.
pub const BASE_SYSTEM_PROMPT: &str = r#"You are GuideLens, an expert Windows on-screen AI visual copilot.
You analyze the user's live screenshot (with numbered Set-of-Mark `[ID]` tags when provided), GROUNDED UI ELEMENTS table, learned workflow memory, active application, and question, then respond ONLY with a valid JSON object matching the StepPlan schema below. Do not output markdown fences, commentary, or extra keys.

REQUIRED JSON SCHEMA (StepPlan):
{
  "mode": "guide" | "explain" | "terminal",
  "total_steps": 1,
  "steps": [
    {
      "step_number": 1,
      "instruction_line": "Click the Object Selection Tool in the left toolbar, or press W.",
      "target_id": 12,
      "target_name": "Object Selection Tool",
      "control_type": "Button",
      "bbox": [12, 180, 32, 32],
      "confidence": 0.92,
      "action_kind": "click",
      "companion_emotion": "pointing",
      "goal_complete": false,
      "shortcut": "W",
      "terminal_command": null,
      "explanation": null,
      "spoken_text": "Click the Object Selection Tool I highlighted on the left."
    }
  ]
}

STRICT RULES:
1. `instruction_line` MUST be a single concise plain-English sentence of AT MOST 140 characters (<= 140 chars), with no newlines.
2. When `GROUNDED UI ELEMENTS` is provided, ALWAYS pick the exact matching `[ID]` as `target_id` (integer, e.g. `12`) and copy its exact label into `target_name` instead of guessing coordinates! Set `target_id` to `null` only if no matching element appears in the table.
3. `bbox` coordinates `[x, y, w, h]` MUST be normalized to a `0` to `1000` scale relative to the captured monitor (`x` and `w` in 0..1000 horizontal, `y` and `h` in 0..1000 vertical).
4. Provide `target_name` and `control_type` ("Button", "MenuItem", "TabItem", "Edit", "ComboBox", "ListItem", "TreeItem", "CheckBox", "RadioButton", "Slider", "Hyperlink", "ToolBar", "Pane", "Document") whenever pointing at a UI control. Set `confidence` in `0.0..=1.0`; if the control is not visible and no `target_id` matches, set `"bbox": null`.
5. When the active app is a terminal/CLI or the user asks for a shell/git/CLI command, set `"mode": "terminal"`, populate `"terminal_command"`, and populate `"explanation"` (<= 140 chars).
6. When the user only asks a conceptual question with no UI click or command needed, set `"mode": "explain"` and `"bbox": null`.
7. Keep `total_steps` equal to `steps.length` (usually 1 to 4 focused steps). Set `action_kind` (`"click" | "double_click" | "type" | "shortcut" | "scroll" | "open_app" | "complete" | "explain"`), `companion_emotion` (`"happy" | "pointing" | "bonk" | "curious" | "thinking" | "celebrate" | "peeking"`), and `goal_complete` (`true` only when the goal is already done).
8. `spoken_text` MUST be a short, natural, friendly spoken coaching cue (<= 140 chars) written as if sitting next to the user pointing at the highlighted screen element (e.g., "Click the Object Selection Tool I highlighted on the left."). Never include raw terminal commands, markdown, URLs, or noisy symbols in `spoken_text` — in terminal mode, simply explain what the command in the bar does so the user can copy and run it."#;

/// Reactive 1-step prompt for Live Companion Sessions: never guesses unobserved future menus!
pub const LIVE_STEP_PROMPT: &str = r#"You are GuideLens in LIVE REACTIVE COPILOT MODE, guiding the user step-by-step in real time as their screen updates after every click.
Respond ONLY with a valid JSON object matching StepPlan with EXACTLY ONE immediate next step (`"total_steps": 1`, `"steps"` length `1`).
NEVER guess hidden menus, future dialogs, or later screens that are not visible right now!

REQUIRED JSON SCHEMA (Live Single-Step):
{
  "mode": "guide" | "explain" | "terminal",
  "total_steps": 1,
  "steps": [
    {
      "step_number": 1,
      "instruction_line": "Click Export in the top-right toolbar.",
      "target_id": 14,
      "target_name": "Export",
      "control_type": "Button",
      "bbox": [880, 42, 74, 30],
      "confidence": 0.96,
      "action_kind": "click",
      "companion_emotion": "pointing",
      "goal_complete": false,
      "shortcut": null,
      "terminal_command": null,
      "explanation": null,
      "spoken_text": "Tap Export right up there!"
    }
  ]
}

LIVE SESSION RULES:
1. Output EXACTLY ONE step for what the user should do RIGHT NOW on the current screen. As soon as the user clicks or types, you will receive a fresh screenshot to guide the next step.
2. ALWAYS prefer selecting an integer `target_id` from `GROUNDED UI ELEMENTS` (including `[taskbar]` icons when the user needs to open or switch to a different app!). Copy the element's label into `target_name`.
3. If the target app or dialog is not open yet, guide the user to open it (point to its taskbar `target_id` or suggest pressing `Win` / shortcut) and set `companion_emotion` to `"bonk"` or `"curious"`.
4. If the user's goal is already visibly accomplished on screen, set `"goal_complete": true`, `"action_kind": "complete"`, `"companion_emotion": "celebrate"`, `"target_id": null`, `"bbox": null`, and congratulate them warmly in `instruction_line` and `spoken_text`.
5. Keep `instruction_line` and `spoken_text` <= 140 chars each. Use `companion_emotion` from: `happy | pointing | bonk | curious | thinking | celebrate | peeking`.
6. Use `action_kind` from: `click | double_click | type | shortcut | scroll | open_app | complete | explain`.
7. In terminal apps or when a shell command is best, use `"mode": "terminal"`, set `terminal_command`, and keep `spoken_text` free of noisy shell punctuation.
8. `spoken_text` MUST be a short, natural, friendly spoken coaching cue (<= 140 chars)."#;

pub fn companion_persona_instruction(companion_id: &str) -> &'static str {
    match companion_id.trim().to_ascii_lowercase().as_str() {
        "pixel_cat" => {
            "COMPANION PERSONA (Mochi — Playful Pixel Cat): Keep `spoken_text` warm, upbeat, and encouraging like a playful cat buddy beside the user, while keeping `instruction_line` crisp and direct."
        }
        "tech_nerd" => {
            "COMPANION PERSONA (Byte — Tech Nerd): Keep `spoken_text` clever, concise, and shortcut-savvy like a sharp developer buddy; include keyboard shortcuts when helpful."
        }
        "anime_guide" => {
            "COMPANION PERSONA (Sora — Anime Spirit): Keep `spoken_text` lively, expressive, and supportive like an anime spirit guide cheering the user on."
        }
        "minimal_orb" => {
            "COMPANION PERSONA (Flow — Minimal Orb): Keep `spoken_text` ultra-calm, crisp, and zero-fluff."
        }
        _ => {
            "COMPANION PERSONA: Keep `spoken_text` clear, friendly, and concise."
        }
    }
}

fn append_app_profile(prompt: &mut String, active_exe: &str, window_title: &str) {
    if let Some(profile) = match_app_profile(active_exe, window_title) {
        prompt.push_str("\n\nACTIVE APPLICATION PROFILE: ");
        prompt.push_str(&profile.display_name);
        prompt.push_str(&format!(" (id: {})\n", profile.id));

        if profile.terminal_mode {
            prompt.push_str(
                "TERMINAL MODE: This application is a terminal/CLI environment. Prefer \"mode\": \"terminal\" with a copy-ready `terminal_command` and a 1-line `explanation` unless the user explicitly asks where a GUI button is.\n",
            );
        }

        if !profile.ui_layout_hints.is_empty() {
            prompt.push_str("UI LAYOUT HINTS (0-1000 normalized screen regions):\n");
            for hint in &profile.ui_layout_hints {
                prompt.push_str("- ");
                prompt.push_str(hint);
                prompt.push('\n');
            }
        }

        if !profile.shortcuts.is_empty() {
            prompt.push_str("VERIFIED KEYBOARD SHORTCUTS:\n");
            for sc in &profile.shortcuts {
                prompt.push_str(&format!("- {}: {}\n", sc.action, sc.keys));
            }
        }
    }
}

/// Builds the full system prompt tailored to the active application and window title.
pub fn build_system_prompt(active_exe: &str, window_title: &str) -> String {
    let mut prompt = String::with_capacity(BASE_SYSTEM_PROMPT.len() + 1536);
    prompt.push_str(BASE_SYSTEM_PROMPT);
    append_app_profile(&mut prompt, active_exe, window_title);
    prompt
}

/// Builds a v2 system prompt with live/multi-step mode, companion persona, and app profile.
pub fn build_grounded_system_prompt(
    active_exe: &str,
    window_title: &str,
    companion_id: &str,
    live_mode: bool,
) -> String {
    let base = if live_mode {
        LIVE_STEP_PROMPT
    } else {
        BASE_SYSTEM_PROMPT
    };
    let mut prompt = String::with_capacity(base.len() + 1800);
    prompt.push_str(base);
    prompt.push_str("\n\n");
    prompt.push_str(companion_persona_instruction(companion_id));
    append_app_profile(&mut prompt, active_exe, window_title);
    prompt
}

/// Builds the user prompt combining the active app context, screen resolution, and user query.
pub fn build_user_prompt(
    query: &str,
    active_exe: &str,
    window_title: &str,
    screen_size: (u32, u32),
) -> String {
    build_grounded_user_prompt(&GroundedPromptContext {
        query,
        active_exe,
        window_title,
        screen_size,
        element_table_prompt: "",
        memory_hints: "",
        session_history: &[],
    })
}

pub struct GroundedPromptContext<'a> {
    pub query: &'a str,
    pub active_exe: &'a str,
    pub window_title: &'a str,
    pub screen_size: (u32, u32),
    pub element_table_prompt: &'a str,
    pub memory_hints: &'a str,
    pub session_history: &'a [String],
}

/// Builds the user prompt with optional Set-of-Mark UI elements, Knowledge Graph hints, and turn history.
pub fn build_grounded_user_prompt(ctx: &GroundedPromptContext<'_>) -> String {
    let profile_hint = match_app_profile(ctx.active_exe, ctx.window_title)
        .map(|p| format!("{} (terminal_mode={})", p.display_name, p.terminal_mode))
        .unwrap_or_else(|| "Generic Windows Application".to_string());

    let mut out = format!(
        "Active Executable: {}\nWindow Title: {}\nDetected Profile: {}\nMonitor Resolution: {}x{}\n",
        if ctx.active_exe.trim().is_empty() {
            "unknown"
        } else {
            ctx.active_exe.trim()
        },
        if ctx.window_title.trim().is_empty() {
            "untitled"
        } else {
            ctx.window_title.trim()
        },
        profile_hint,
        ctx.screen_size.0,
        ctx.screen_size.1,
    );

    if !ctx.element_table_prompt.trim().is_empty() {
        out.push_str("\nGROUNDED UI ELEMENTS (cite `target_id` integer when pointing):\n");
        out.push_str(ctx.element_table_prompt.trim());
        out.push('\n');
    }

    if !ctx.memory_hints.trim().is_empty() {
        out.push_str("\nLEARNED WORKFLOW MEMORY (verified past actions in this app):\n");
        out.push_str(ctx.memory_hints.trim());
        out.push('\n');
    }

    if !ctx.session_history.is_empty() {
        out.push_str("\nRECENT SESSION HISTORY:\n");
        for line in ctx.session_history.iter().rev().take(5).rev() {
            out.push_str("- ");
            out.push_str(line.trim());
            out.push('\n');
        }
    }

    out.push_str(&format!(
        "\nUser Request: {}\n\nRespond with only the StepPlan JSON object.",
        ctx.query.trim()
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_15_priority_profiles_load_and_parse() {
        let profiles = all_profiles();
        assert_eq!(profiles.len(), 15, "All 15 priority app TOML profiles must parse");
        for p in profiles {
            assert!(!p.id.is_empty());
            assert!(!p.display_name.is_empty());
            assert!(!p.exe_patterns.is_empty());
            assert!(!p.ui_layout_hints.is_empty());
            assert!(!p.shortcuts.is_empty());
        }
    }

    #[test]
    fn matches_native_and_browser_apps_accurately() {
        assert_eq!(
            match_app_profile("Photoshop.exe", "Untitled-1 @ 100% (RGB/8)").map(|p| p.id.as_str()),
            Some("photoshop")
        );
        assert_eq!(
            match_app_profile("EXCEL.EXE", "Budget.xlsx - Excel").map(|p| p.id.as_str()),
            Some("excel")
        );
        assert_eq!(
            match_app_profile("POWERPNT.EXE", "Pitch.pptx - PowerPoint").map(|p| p.id.as_str()),
            Some("powerpoint")
        );
        assert_eq!(
            match_app_profile("chrome.exe", "Q4 Roadmap - Google Docs - Google Chrome")
                .map(|p| p.id.as_str()),
            Some("google_docs")
        );
        assert_eq!(
            match_app_profile("WINWORD.EXE", "Contract.docx - Word").map(|p| p.id.as_str()),
            Some("word")
        );
        assert_eq!(
            match_app_profile("chrome.exe", "Social Post - Canva - Google Chrome")
                .map(|p| p.id.as_str()),
            Some("canva")
        );
        assert_eq!(
            match_app_profile("Adobe Premiere Pro.exe", "Adobe Premiere Pro 2025")
                .map(|p| p.id.as_str()),
            Some("premiere_pro")
        );
        assert_eq!(
            match_app_profile("AfterFX.exe", "Adobe After Effects 2025").map(|p| p.id.as_str()),
            Some("after_effects")
        );
        assert_eq!(
            match_app_profile("Code.exe", "lib.rs - GuideLens - Visual Studio Code")
                .map(|p| p.id.as_str()),
            Some("vscode")
        );
        assert_eq!(
            match_app_profile("GitHubDesktop.exe", "GitHub Desktop").map(|p| p.id.as_str()),
            Some("github_desktop")
        );
        assert_eq!(
            match_app_profile("WindowsTerminal.exe", "Windows PowerShell").map(|p| p.id.as_str()),
            Some("windows_terminal")
        );
        assert_eq!(
            match_app_profile("opencode.exe", "opencode").map(|p| p.id.as_str()),
            Some("opencode")
        );
        assert_eq!(
            match_app_profile("Antigravity.exe", "GuideLens - Antigravity").map(|p| p.id.as_str()),
            Some("antigravity")
        );
        assert_eq!(
            match_app_profile("SystemSettings.exe", "Settings").map(|p| p.id.as_str()),
            Some("windows_settings")
        );
        assert_eq!(
            match_app_profile("chrome.exe", "Hacker News - Google Chrome").map(|p| p.id.as_str()),
            Some("chrome")
        );
    }

    #[test]
    fn system_prompt_includes_app_shortcuts_and_terminal_flag() {
        let ps_prompt = build_system_prompt("Photoshop.exe", "Adobe Photoshop");
        assert!(ps_prompt.contains("Adobe Photoshop"));
        assert!(ps_prompt.contains("Object Selection"));

        let term_prompt = build_system_prompt("WindowsTerminal.exe", "PowerShell");
        assert!(term_prompt.contains("TERMINAL MODE"));

        let user_prompt = build_user_prompt(
            "Undo commit",
            "WindowsTerminal.exe",
            "PowerShell",
            (2560, 1440),
        );
        assert!(user_prompt.contains("2560x1440"));
        assert!(user_prompt.contains("terminal_mode=true"));
        assert!(user_prompt.contains("Undo commit"));
        assert!(ps_prompt.contains("\"spoken_text\""));
        assert!(ps_prompt.contains("8. `spoken_text` MUST be a short"));
    }

    #[test]
    fn live_grounded_prompt_injects_som_table_memory_and_persona() {
        let sys = build_grounded_system_prompt("Code.exe", "GuideLens - VS Code", "tech_nerd", true);
        assert!(sys.contains("LIVE REACTIVE COPILOT MODE"));
        assert!(sys.contains("Byte"));
        assert!(sys.contains("target_id"));
        assert!(sys.contains("goal_complete"));

        let user = build_grounded_user_prompt(&GroundedPromptContext {
            query: "Open terminal",
            active_exe: "Code.exe",
            window_title: "GuideLens - VS Code",
            screen_size: (1920, 1080),
            element_table_prompt: "[12] Button \"Toggle Panel\" @(1800,40,32x32) [uia]",
            memory_hints: "- [Open terminal -> Terminal > New Terminal (Ctrl+Shift+`)]",
            session_history: &["Turn 1: Opened View menu".to_string()],
        });
        assert!(user.contains("GROUNDED UI ELEMENTS"));
        assert!(user.contains("[12] Button \"Toggle Panel\""));
        assert!(user.contains("LEARNED WORKFLOW MEMORY"));
        assert!(user.contains("Ctrl+Shift+`"));
        assert!(user.contains("RECENT SESSION HISTORY"));
    }
}
