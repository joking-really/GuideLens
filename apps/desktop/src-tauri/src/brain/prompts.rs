//! System prompt builder and embedded TOML profiles for the 15 priority Windows apps.

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
///
/// Note: Web apps such as Google Docs and Canva often run inside Chrome/Edge, so when the
/// executable is a browser we check specific web-app title patterns before falling back to Chrome.
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

    // 1. Exact match first, then substring match against executable patterns (excluding generic browser fallback first)
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

    // 2. Match against window title patterns (excluding generic Chrome first)
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

    // 3. Fallback to Chrome profile if browser exe or title matches
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

/// Shared base system prompt demanding strict `StepPlan` JSON per `decisions.md` §3.
pub const BASE_SYSTEM_PROMPT: &str = r#"You are GuideLens, an expert Windows on-screen AI visual copilot.
You analyze the user's live screenshot, active application, window title, and question, then respond ONLY with a valid JSON object matching the StepPlan schema below. Do not output markdown fences, commentary, or extra keys.

REQUIRED JSON SCHEMA (StepPlan):
{
  "mode": "guide" | "explain" | "terminal",
  "total_steps": 1,
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
      "explanation": null,
      "spoken_text": "Click the Object Selection Tool I highlighted on the left."
    }
  ]
}

STRICT RULES:
1. `instruction_line` MUST be a single concise plain-English sentence of AT MOST 140 characters (<= 140 chars), with no newlines.
2. `bbox` coordinates `[x, y, w, h]` MUST be normalized to a `0` to `1000` scale relative to the captured monitor (`x` and `w` in 0..1000 horizontal, `y` and `h` in 0..1000 vertical).
3. Provide `target_name` (exact visible label or accessible name of the UI control) and `control_type` (one of: "Button", "MenuItem", "TabItem", "Edit", "ComboBox", "ListItem", "TreeItem", "CheckBox", "RadioButton", "Slider", "Hyperlink", "ToolBar", "Pane", "Document") whenever pointing at a Windows UI control so Windows UI Automation can snap accurately to it.
4. Set `confidence` between 0.0 and 1.0 reflecting how certain you are of the control's location on screen. If the target control is not visible or confidence is below 0.5, set `"bbox": null` and explain what to do in `instruction_line`.
5. When the active app is a terminal/CLI or the user asks for a shell/git/CLI command, set `"mode": "terminal"`, populate `"terminal_command"` with the exact copy-ready command string, and populate `"explanation"` with a 1-line plain-English explanation (<= 140 chars).
6. When the user only asks a conceptual question with no UI click or command needed, set `"mode": "explain"` and `"bbox": null`.
7. Keep `total_steps` equal to `steps.length` (usually 1 to 4 focused steps).
8. `spoken_text` MUST be a short, natural, friendly spoken coaching cue (<= 140 chars) written as if sitting next to the user pointing at the highlighted screen element (e.g., "Click the Object Selection Tool I highlighted on the left."). Never include raw terminal commands, markdown, URLs, or noisy symbols in `spoken_text` — in terminal mode, simply explain what the command in the bar does so the user can copy and run it."#;

/// Builds the full system prompt tailored to the active application and window title.
pub fn build_system_prompt(active_exe: &str, window_title: &str) -> String {
    let mut prompt = String::with_capacity(BASE_SYSTEM_PROMPT.len() + 1536);
    prompt.push_str(BASE_SYSTEM_PROMPT);

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

    prompt
}

/// Builds the user prompt combining the active app context, screen resolution, and user query.
pub fn build_user_prompt(
    query: &str,
    active_exe: &str,
    window_title: &str,
    screen_size: (u32, u32),
) -> String {
    let profile_hint = match_app_profile(active_exe, window_title)
        .map(|p| format!("{} (terminal_mode={})", p.display_name, p.terminal_mode))
        .unwrap_or_else(|| "Generic Windows Application".to_string());

    format!(
        "Active Executable: {}\nWindow Title: {}\nDetected Profile: {}\nMonitor Resolution: {}x{}\nUser Request: {}\n\nRespond with only the StepPlan JSON object.",
        if active_exe.is_empty() { "unknown" } else { active_exe },
        if window_title.is_empty() { "untitled" } else { window_title },
        profile_hint,
        screen_size.0,
        screen_size.1,
        query.trim()
    )
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
}
