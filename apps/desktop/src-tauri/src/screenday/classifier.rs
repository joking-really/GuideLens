//! Privacy Shield and active Project / Meeting classification for Screen Day frames.

fn normalize_app_stem(active_app: &str) -> (String, String) {
    let lower = active_app.trim().to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower).to_string();
    (lower, stem)
}

/// Returns `true` when Screen Day MUST skip capturing the active window due to user
/// exclusions or automatic Privacy Shield rules (password managers, private browsing,
/// Windows lock/logon/UAC/credential prompts).
pub fn is_private_window(
    active_app: &str,
    window_title: &str,
    excluded_apps: &[String],
    skip_private: bool,
) -> bool {
    let (app_lower, app_stem) = normalize_app_stem(active_app);
    let title_lower = window_title.trim().to_ascii_lowercase();

    // 1. User-configured excluded apps always block capture regardless of `skip_private`.
    for raw_ex in excluded_apps {
        let ex_lower = raw_ex.trim().to_ascii_lowercase();
        if ex_lower.is_empty() {
            continue;
        }
        let ex_stem = ex_lower.strip_suffix(".exe").unwrap_or(&ex_lower);
        if app_lower == ex_lower
            || (!app_stem.is_empty() && app_stem == ex_stem)
            || (ex_stem.len() >= 3 && !app_stem.is_empty() && app_stem.contains(ex_stem))
        {
            return true;
        }
        // UWP apps may host under ApplicationFrameHost.exe where the app name lives in the title.
        if app_stem == "applicationframehost" && title_lower.contains(ex_stem) {
            return true;
        }
    }

    if !skip_private {
        return false;
    }

    // 2. Password managers & secret vaults.
    const PASSWORD_MANAGERS: &[&str] = &[
        "1password",
        "bitwarden",
        "keepass",
        "keepassxc",
        "lastpass",
        "dashlane",
        "roboform",
        "enpass",
        "nordpass",
        "protonpass",
        "proton pass",
        "keeper",
        "vaultwarden",
        "credential manager",
        "windows credentials",
        "keychain",
        "winauth",
        "authy",
    ];

    if app_stem == "op" || app_stem == "bw" {
        return true;
    }
    if PASSWORD_MANAGERS
        .iter()
        .any(|kw| app_lower.contains(kw) || title_lower.contains(kw))
    {
        return true;
    }

    // 3. Private / Incognito browser windows.
    const PRIVATE_BROWSING_MARKERS: &[&str] = &[
        "inprivate",
        "incognito",
        "private browsing",
        "private window",
        "tor browser",
        "mullvad browser",
    ];
    if app_stem == "tor"
        || PRIVATE_BROWSING_MARKERS
            .iter()
            .any(|kw| title_lower.contains(kw))
    {
        return true;
    }

    // 4. Windows Lock Screen, Logon, UAC, and Credential UI prompts.
    const SYSTEM_AUTH_APPS: &[&str] = &[
        "lockapp",
        "logonui",
        "consent",
        "credentialuibroker",
        "winlogon",
    ];
    if SYSTEM_AUTH_APPS.iter().any(|sys| app_stem == *sys) {
        return true;
    }

    const SYSTEM_AUTH_TITLES: &[&str] = &[
        "windows default lock screen",
        "user account control",
        "windows security",
        "enter your pin",
        "windows hello",
        "sign in to windows",
    ];
    SYSTEM_AUTH_TITLES
        .iter()
        .any(|kw| title_lower.contains(kw))
}

fn strip_browser_suffix(title: &str) -> String {
    const BROWSER_SUFFIXES: &[&str] = &[
        " - Google Chrome",
        " - Microsoft Edge",
        " - Mozilla Firefox",
        " — Mozilla Firefox",
        " - Brave",
        " - Arc",
        " - Opera",
        " - Vivaldi",
        " - Chromium",
        " - Microsoft\u{200b} Edge",
    ];
    let mut cur = title.trim();
    for suffix in BROWSER_SUFFIXES {
        if let Some(stripped) = cur.strip_suffix(suffix) {
            cur = stripped.trim();
            break;
        }
    }
    // Strip trailing Chrome profile markers like " - Personal" or " - Work" if preceded by browser? No, keep clean.
    cur.to_string()
}

fn clean_option(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(80).collect())
    }
}

fn is_generic_title(s: &str) -> bool {
    let lower = s.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "" | "welcome"
            | "get started"
            | "untitled"
            | "new tab"
            | "settings"
            | "preferences"
            | "home"
            | "desktop"
    )
}

fn strip_remote_suffix(segment: &str) -> String {
    let s = segment.trim();
    for marker in [" [SSH:", " [WSL:", " [Dev Container", " (Workspace)"] {
        if let Some(idx) = s.find(marker) {
            return s[..idx].trim().to_string();
        }
    }
    s.to_string()
}

fn extract_project_from_path(raw: &str) -> Option<String> {
    let trimmed = raw
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`');
    let parts: Vec<&str> = trimmed
        .split(['\\', '/'])
        .map(str::trim)
        .filter(|p| !p.is_empty() && !p.ends_with(':'))
        .collect();
    if parts.is_empty() {
        return None;
    }

    const GENERIC_SUBDIRS: &[&str] = &[
        "apps",
        "packages",
        "src",
        "src-tauri",
        "desktop",
        "web",
        "frontend",
        "backend",
        "dist",
        "build",
        "target",
        "node_modules",
    ];
    const SYSTEM_ROOTS: &[&str] = &["windows", "system32", "syswow64", "program files", "users"];

    if let Some(first) = parts.first() {
        if SYSTEM_ROOTS
            .iter()
            .any(|sr| first.eq_ignore_ascii_case(sr))
            && parts.len() <= 2
        {
            return None;
        }
    }

    // If path enters `apps/...` or `src/...`, prefer the parent workspace directory (e.g. `E:\GuideLens\apps\desktop` -> `GuideLens`).
    for (idx, part) in parts.iter().enumerate() {
        if idx > 0
            && GENERIC_SUBDIRS
                .iter()
                .any(|g| part.eq_ignore_ascii_case(g))
        {
            let candidate = parts[idx - 1];
            if !SYSTEM_ROOTS
                .iter()
                .any(|sr| candidate.eq_ignore_ascii_case(sr))
                && !is_generic_title(candidate)
            {
                return clean_option(candidate);
            }
        }
    }

    let last = *parts.last()?;
    if SYSTEM_ROOTS
        .iter()
        .any(|sr| last.eq_ignore_ascii_case(sr))
        || is_generic_title(last)
    {
        return None;
    }
    clean_option(last)
}

fn extract_path_token_from_text(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let cleaned = token.trim_matches(|c| c == '>' || c == '$' || c == '"' || c == '\'');
        let bytes = cleaned.as_bytes();
        if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
            if let Some(proj) = extract_project_from_path(cleaned) {
                return Some(proj);
            }
        }
    }
    None
}

fn detect_meeting(
    app_stem: &str,
    clean_title: &str,
    title_lower: &str,
    ocr_lower: &str,
) -> Option<String> {
    // Zoom desktop app or browser Zoom Meeting
    if app_stem == "zoom" || app_stem == "cpthost" || app_stem == "zmeetings" {
        let trimmed = clean_title
            .strip_suffix(" - Zoom")
            .or_else(|| clean_title.strip_suffix(" | Zoom"))
            .unwrap_or(clean_title)
            .trim();
        if trimmed.eq_ignore_ascii_case("zoom")
            || trimmed.eq_ignore_ascii_case("zoom workplace")
            || trimmed.is_empty()
        {
            let in_call = ["mute", "stop video", "participants", "share screen", "leave", "meeting id"]
                .iter()
                .any(|kw| ocr_lower.contains(kw));
            return if in_call {
                Some("Zoom Meeting".to_string())
            } else {
                None
            };
        }
        return clean_option(trimmed);
    }

    if title_lower.contains("zoom meeting") || title_lower.contains("launch meeting - zoom") {
        let topic = clean_title
            .replace(" - Zoom Meeting", "")
            .replace("Zoom Meeting - ", "")
            .trim()
            .to_string();
        return clean_option(&topic).or_else(|| Some("Zoom Meeting".to_string()));
    }

    // Microsoft Teams desktop or browser tab
    if app_stem == "ms-teams" || app_stem == "teams" || title_lower.contains("microsoft teams") {
        let topic = clean_title
            .split(" | Microsoft Teams")
            .next()
            .unwrap_or(clean_title)
            .split(" - Microsoft Teams")
            .next()
            .unwrap_or(clean_title)
            .trim();
        if topic.is_empty() || topic.eq_ignore_ascii_case("microsoft teams") {
            return Some("Microsoft Teams".to_string());
        }
        return clean_option(topic);
    }

    // Google Meet (browser tab or PWA)
    if title_lower.contains("google meet")
        || title_lower.contains("meet.google.com")
        || title_lower.starts_with("meet - ")
        || title_lower.starts_with("meet – ")
        || ocr_lower.contains("meet.google.com")
    {
        let cleaned = clean_title
            .strip_suffix(" - Google Meet")
            .or_else(|| clean_title.strip_suffix(" | Google Meet"))
            .unwrap_or(clean_title)
            .trim();
        if let Some(rest) = cleaned
            .strip_prefix("Meet - ")
            .or_else(|| cleaned.strip_prefix("Meet – "))
        {
            let code = rest.trim();
            if !code.is_empty() {
                return clean_option(&format!("Google Meet ({})", code));
            }
        }
        if cleaned.is_empty() || cleaned.eq_ignore_ascii_case("google meet") {
            return Some("Google Meet".to_string());
        }
        return clean_option(&format!("Google Meet: {}", cleaned));
    }

    // Slack Huddle
    if (app_stem == "slack" || title_lower.contains(" - slack") || title_lower.contains("| slack"))
        && (title_lower.contains("huddle") || ocr_lower.contains("huddle"))
    {
        let stripped = clean_title
            .strip_suffix(" - Slack")
            .or_else(|| clean_title.strip_suffix(" | Slack"))
            .unwrap_or(clean_title)
            .trim();
        if stripped.is_empty()
            || stripped.eq_ignore_ascii_case("slack")
            || stripped.eq_ignore_ascii_case("huddle")
        {
            return Some("Slack Huddle".to_string());
        }
        return clean_option(&format!("Slack Huddle ({})", stripped));
    }

    // Discord Voice
    if (app_stem == "discord" || title_lower.contains("discord"))
        && (title_lower.contains("voice")
            || ocr_lower.contains("voice connected")
            || (ocr_lower.contains("mute") && ocr_lower.contains("deafen")))
    {
        let stripped = clean_title
            .strip_suffix(" - Discord")
            .unwrap_or(clean_title)
            .trim();
        if stripped.is_empty() || stripped.eq_ignore_ascii_case("discord") {
            return Some("Discord Voice".to_string());
        }
        return clean_option(&format!("Discord Voice ({})", stripped));
    }

    None
}

fn detect_project(
    app_stem: &str,
    clean_title: &str,
    title_lower: &str,
    ocr_excerpt: &str,
) -> Option<String> {
    // VS Code, Cursor, Antigravity, Windsurf, Visual Studio
    const CODE_SUFFIXES: &[&str] = &[
        " - Visual Studio Code",
        " - Visual Studio Code - Insiders",
        " - Cursor",
        " - Antigravity",
        " - Windsurf",
        " - Microsoft Visual Studio",
    ];
    for suffix in CODE_SUFFIXES {
        if let Some(prefix) = clean_title.strip_suffix(suffix) {
            let parts: Vec<&str> = prefix.split(" - ").map(str::trim).collect();
            let candidate = if parts.len() >= 2 {
                parts.last().copied().unwrap_or("")
            } else {
                parts.first().copied().unwrap_or("")
            };
            let stripped = strip_remote_suffix(candidate);
            if !is_generic_title(&stripped) {
                return clean_option(&stripped);
            }
            return None;
        }
    }

    if matches!(
        app_stem,
        "code" | "code - insiders" | "cursor" | "antigravity" | "windsurf" | "devenv" | "zed"
    ) {
        let parts: Vec<&str> = clean_title.split(" - ").map(str::trim).collect();
        if parts.len() >= 2 {
            let cand = strip_remote_suffix(parts[parts.len() - 1]);
            if !is_generic_title(&cand) {
                return clean_option(&cand);
            }
        }
    }

    // JetBrains IDEs (e.g. "GuideLens – lib.rs" or "GuideLens - main.rs [GuideLens]")
    if matches!(
        app_stem,
        "idea64" | "rustrover64" | "pycharm64" | "webstorm64" | "clion64" | "goland64" | "rider64"
    ) {
        if let Some(proj) = clean_title
            .split(" – ")
            .next()
            .or_else(|| clean_title.split(" - ").next())
        {
            if !is_generic_title(proj) {
                return clean_option(proj);
            }
        }
    }

    // Terminals (Windows Terminal, PowerShell, cmd, Alacritty, WezTerm)
    if matches!(
        app_stem,
        "windowsterminal" | "wt" | "powershell" | "pwsh" | "cmd" | "alacritty" | "wezterm-gui" | "mintty"
    ) {
        if let Some(proj) = extract_path_token_from_text(clean_title)
            .or_else(|| extract_path_token_from_text(ocr_excerpt))
        {
            return Some(proj);
        }
    }

    // Figma
    if app_stem == "figma"
        || title_lower.ends_with("– figma")
        || title_lower.ends_with("- figma")
    {
        let stripped = clean_title
            .strip_suffix("– Figma")
            .or_else(|| clean_title.strip_suffix("- Figma"))
            .or_else(|| clean_title.strip_suffix("— Figma"))
            .unwrap_or(clean_title)
            .trim();
        if !is_generic_title(stripped) && !stripped.eq_ignore_ascii_case("figma") {
            return clean_option(stripped);
        }
    }

    // Notion
    if app_stem == "notion"
        || title_lower.ends_with("| notion")
        || title_lower.ends_with("- notion")
        || title_lower.ends_with("– notion")
    {
        let stripped = clean_title
            .strip_suffix("| Notion")
            .or_else(|| clean_title.strip_suffix("- Notion"))
            .or_else(|| clean_title.strip_suffix("– Notion"))
            .unwrap_or(clean_title)
            .trim();
        if !is_generic_title(stripped) && !stripped.eq_ignore_ascii_case("notion") {
            return clean_option(stripped);
        }
    }

    // GitHub in browser or GitHub Desktop
    if app_stem == "githubdesktop" {
        if let Some(repo) = clean_title.strip_prefix("GitHub Desktop - ") {
            if !is_generic_title(repo) {
                return clean_option(repo);
            }
        }
    }
    if title_lower.contains("github") || clean_title.contains(" · ") {
        for tok in clean_title.split_whitespace() {
            let cleaned = tok.trim_matches(|c| c == '·' || c == ':' || c == ',' || c == '(' || c == ')');
            if cleaned.contains("://") || cleaned.starts_with('/') {
                continue;
            }
            if let Some((owner, repo)) = cleaned.split_once('/') {
                if !owner.is_empty()
                    && !owner.contains('.')
                    && !repo.is_empty()
                    && !repo.contains('/')
                    && !is_generic_title(repo)
                {
                    return clean_option(repo);
                }
            }
        }
    }

    // Google Docs / Sheets / Slides
    for doc_suffix in [" - Google Docs", " - Google Sheets", " - Google Slides"] {
        if let Some(doc_name) = clean_title.strip_suffix(doc_suffix) {
            if !is_generic_title(doc_name) {
                return clean_option(doc_name);
            }
        }
    }

    None
}

/// Classifies the active project and/or active meeting from executable name, window title,
/// and optional OCR excerpt.
pub fn classify_project_and_meeting(
    active_app: &str,
    window_title: &str,
    ocr_excerpt: &str,
) -> (Option<String>, Option<String>) {
    let (_, app_stem) = normalize_app_stem(active_app);
    let clean_title = strip_browser_suffix(window_title);
    let title_lower = clean_title.to_ascii_lowercase();
    let ocr_lower = ocr_excerpt.to_ascii_lowercase();

    let meeting = detect_meeting(&app_stem, &clean_title, &title_lower, &ocr_lower);
    let project = detect_project(&app_stem, &clean_title, &title_lower, ocr_excerpt);

    (project, meeting)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_privacy_shield_blocks_password_managers_incognito_lock_and_exclusions() {
        let none: Vec<String> = Vec::new();
        assert!(is_private_window("1Password.exe", "Vault - 1Password", &none, true));
        assert!(is_private_window("Bitwarden.exe", "Bitwarden", &none, true));
        assert!(is_private_window("KeePassXC.exe", "passwords.kdbx - KeePassXC", &none, true));
        assert!(is_private_window("explorer.exe", "Windows Credentials", &none, true));

        assert!(is_private_window(
            "msedge.exe",
            "Bank Login - [InPrivate] - Microsoft Edge",
            &none,
            true
        ));
        assert!(is_private_window(
            "chrome.exe",
            "Secret Search (Incognito) - Google Chrome",
            &none,
            true
        ));
        assert!(is_private_window(
            "firefox.exe",
            "Mozilla Firefox (Private Browsing)",
            &none,
            true
        ));
        assert!(is_private_window("LockApp.exe", "Windows Default Lock Screen", &none, true));
        assert!(is_private_window("consent.exe", "User Account Control", &none, true));

        // Normal windows must NOT be blocked
        assert!(!is_private_window(
            "Code.exe",
            "lib.rs - GuideLens - Visual Studio Code",
            &none,
            true
        ));

        // Respects skip_private = false for auto-shield, while still honoring explicit excluded_apps
        assert!(!is_private_window("Bitwarden.exe", "Bitwarden", &none, false));
        let excluded = vec!["Slack.exe".to_string(), "spotify".to_string()];
        assert!(is_private_window("Slack.exe", "#general - Slack", &excluded, false));
        assert!(is_private_window("Spotify.exe", "Focus Playlist", &excluded, true));
    }

    #[test]
    fn test_classify_project_and_meeting_extracts_ides_docs_and_calls() {
        assert_eq!(
            classify_project_and_meeting(
                "Code.exe",
                "lib.rs - GuideLens - Visual Studio Code",
                ""
            ),
            (Some("GuideLens".to_string()), None)
        );
        assert_eq!(
            classify_project_and_meeting(
                "Cursor.exe",
                "OverlayCanvas.tsx - GuideLens [SSH: dev] - Cursor",
                ""
            ),
            (Some("GuideLens".to_string()), None)
        );
        assert_eq!(
            classify_project_and_meeting(
                "Antigravity.exe",
                "packager.rs - GuideLens - Antigravity",
                ""
            ),
            (Some("GuideLens".to_string()), None)
        );
        assert_eq!(
            classify_project_and_meeting(
                "WindowsTerminal.exe",
                "pwsh - E:\\GuideLens\\apps\\desktop",
                ""
            ),
            (Some("GuideLens".to_string()), None)
        );
        assert_eq!(
            classify_project_and_meeting(
                "chrome.exe",
                "GuideLens v2 Flow – Figma - Google Chrome",
                ""
            ),
            (Some("GuideLens v2 Flow".to_string()), None)
        );
        assert_eq!(
            classify_project_and_meeting(
                "chrome.exe",
                "Engineering Roadmap | Notion - Google Chrome",
                ""
            ),
            (Some("Engineering Roadmap".to_string()), None)
        );
        assert_eq!(
            classify_project_and_meeting(
                "chrome.exe",
                "Pull requests · mit/GuideLens - Google Chrome",
                ""
            ),
            (Some("GuideLens".to_string()), None)
        );
        assert_eq!(
            classify_project_and_meeting(
                "msedge.exe",
                "Q4 Launch Plan - Google Docs - Microsoft Edge",
                ""
            ),
            (Some("Q4 Launch Plan".to_string()), None)
        );

        // Meetings
        assert_eq!(
            classify_project_and_meeting("Zoom.exe", "Design Sync - Zoom", ""),
            (None, Some("Design Sync".to_string()))
        );
        assert_eq!(
            classify_project_and_meeting("ms-teams.exe", "Weekly Standup | Microsoft Teams", ""),
            (None, Some("Weekly Standup".to_string()))
        );
        assert_eq!(
            classify_project_and_meeting(
                "chrome.exe",
                "Meet - abc-defg-hij - Google Chrome",
                "meet.google.com"
            ),
            (None, Some("Google Meet (abc-defg-hij)".to_string()))
        );
        assert_eq!(
            classify_project_and_meeting(
                "Slack.exe",
                "Huddle: #engineering - Slack",
                "Huddle controls"
            ),
            (None, Some("Slack Huddle (Huddle: #engineering)".to_string()))
        );
        assert_eq!(
            classify_project_and_meeting(
                "Discord.exe",
                "#pair-programming - Discord",
                "Voice Connected / General"
            ),
            (None, Some("Discord Voice (#pair-programming)".to_string()))
        );
    }
}
