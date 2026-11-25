//! Headless local Agent CLI provider supporting subscription/local CLIs:
//! `claude`, `codex`, `gemini`, `agy`, `copilot` (`copilot`/`github-copilot`/`gh`), `opencode`, `hermes`, and `custom`.
//! Prompts are piped over `stdin` (`Stdio::piped()`) with fast single-turn flags when SoM elements are present.

use crate::brain::json_repair::parse_and_repair_step_plan;
use crate::brain::provider::{BrainError, BrainErrorCode, BrainProvider, BrainRequest};
use crate::types::{BrainKind, StepPlan};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const AGENT_DETECT_TTL: Duration = Duration::from_secs(60);
type AgentDetectCacheSlot = Mutex<Option<(Instant, Vec<DetectedAgent>)>>;
static AGENT_DETECT_CACHE: OnceLock<AgentDetectCacheSlot> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentId {
    Claude,
    Codex,
    Gemini,
    Agy,
    Copilot,
    Opencode,
    Hermes,
    Custom,
}

impl AgentId {
    pub const ALL: [AgentId; 8] = [
        AgentId::Claude,
        AgentId::Codex,
        AgentId::Gemini,
        AgentId::Agy,
        AgentId::Copilot,
        AgentId::Opencode,
        AgentId::Hermes,
        AgentId::Custom,
    ];

    pub fn from_str_id(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude_code" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "gemini" | "gemini_cli" => Some(Self::Gemini),
            "agy" | "antigravity" => Some(Self::Agy),
            "copilot" | "github_copilot" | "github-copilot" | "gh" => Some(Self::Copilot),
            "opencode" => Some(Self::Opencode),
            "hermes" => Some(Self::Hermes),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::Agy => "agy",
            Self::Copilot => "copilot",
            Self::Opencode => "opencode",
            Self::Hermes => "hermes",
            Self::Custom => "custom",
        }
    }

    pub fn binary_name(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::Agy => "agy",
            Self::Copilot => "copilot",
            Self::Opencode => "opencode",
            Self::Hermes => "hermes",
            Self::Custom => "custom",
        }
    }

    pub fn build_args(&self, prompt: &str) -> Vec<String> {
        match self {
            Self::Claude => vec!["-p".to_string(), prompt.to_string()],
            Self::Codex => vec!["exec".to_string(), prompt.to_string()],
            Self::Gemini => vec!["-p".to_string(), prompt.to_string()],
            Self::Agy => vec!["-p".to_string(), prompt.to_string()],
            Self::Copilot => vec!["-p".to_string(), prompt.to_string()],
            Self::Opencode => vec!["run".to_string(), prompt.to_string()],
            Self::Hermes => vec!["-p".to_string(), prompt.to_string()],
            Self::Custom => vec![prompt.to_string()],
        }
    }

    /// Builds non-interactive args when the full prompt is piped via `stdin`.
    /// When `has_som` is true, requests fast single-turn non-tool output where supported.
    pub fn build_stdin_args(&self, binary_path: &Path, has_som: bool) -> Vec<String> {
        let bin_stem = binary_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        match self {
            Self::Claude => {
                if has_som {
                    vec![
                        "-p".to_string(),
                        "--max-turns".to_string(),
                        "1".to_string(),
                        "--output-format".to_string(),
                        "json".to_string(),
                    ]
                } else {
                    vec!["-p".to_string(), "--output-format".to_string(), "json".to_string()]
                }
            }
            Self::Codex => vec!["exec".to_string(), "-".to_string()],
            Self::Gemini => {
                let mut args = vec![
                    "-p".to_string(),
                    "Follow the instructions provided on stdin.".to_string(),
                ];
                if has_som {
                    args.push("--output-format".to_string());
                    args.push("json".to_string());
                }
                args
            }
            Self::Agy => vec![
                "-p".to_string(),
                "Follow the instructions provided on stdin.".to_string(),
            ],
            Self::Copilot => {
                if bin_stem == "gh" {
                    vec![
                        "copilot".to_string(),
                        "-p".to_string(),
                        "Follow the instructions provided on stdin.".to_string(),
                    ]
                } else {
                    vec![
                        "-p".to_string(),
                        "Follow the instructions provided on stdin.".to_string(),
                    ]
                }
            }
            Self::Opencode => vec![
                "run".to_string(),
                "Follow the instructions provided on stdin.".to_string(),
            ],
            Self::Hermes => vec![
                "-p".to_string(),
                "Follow the instructions provided on stdin.".to_string(),
            ],
            Self::Custom => Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectedAgent {
    pub id: String,
    pub installed: bool,
    pub path: Option<String>,
}

/// Splits a custom CLI command string into `(program, args)` honoring single and double quotes.
pub fn split_command_line(raw: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in raw.trim().chars() {
        match quote {
            Some(q) if ch == q => {
                quote = None;
            }
            Some(_) => {
                current.push(ch);
            }
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
            }
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            None => {
                current.push(ch);
            }
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

pub fn resolve_custom_command(custom_cmd: Option<&str>) -> Option<(PathBuf, Vec<String>)> {
    let raw = custom_cmd?.trim();
    if raw.is_empty() {
        return None;
    }
    let parts = split_command_line(raw);
    let prog = parts.first()?;
    let args = parts[1..].to_vec();
    let direct = PathBuf::from(prog);
    if direct.exists() {
        return Some((direct, args));
    }
    which::which(prog).ok().map(|resolved| (resolved, args))
}

pub fn invalidate_agent_cache() {
    if let Some(cell) = AGENT_DETECT_CACHE.get() {
        if let Ok(mut guard) = cell.lock() {
            *guard = None;
        }
    }
}

/// Scans `PATH` for supported agent CLIs with a 60s TTL cache to avoid repeated subprocess/PATH scans.
pub fn detect_agents() -> Vec<DetectedAgent> {
    let cell = AGENT_DETECT_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cell.lock() {
        if let Some((captured_at, ref cached)) = *guard {
            if captured_at.elapsed() < AGENT_DETECT_TTL {
                return cached.clone();
            }
        }
    }
    let fresh = detect_agents_uncached(None);
    if let Ok(mut guard) = cell.lock() {
        *guard = Some((Instant::now(), fresh.clone()));
    }
    fresh
}

/// Detects agents with optional `settings.custom_agent_cmd` check (uncached when custom command is given).
pub fn detect_agents_with_custom(custom_cmd: Option<&str>) -> Vec<DetectedAgent> {
    if custom_cmd.map(str::trim).is_some_and(|s| !s.is_empty()) {
        return detect_agents_uncached(custom_cmd);
    }
    detect_agents()
}

/// Performs an uncached `PATH` scan for all supported agent CLIs.
pub fn detect_agents_uncached(custom_cmd: Option<&str>) -> Vec<DetectedAgent> {
    AgentId::ALL
        .iter()
        .map(|agent| {
            let resolved = if *agent == AgentId::Custom {
                resolve_custom_command(custom_cmd)
                    .map(|(p, _)| p)
                    .or_else(|| resolve_agent_binary(*agent))
            } else {
                resolve_agent_binary(*agent)
            };
            DetectedAgent {
                id: agent.as_str().to_string(),
                installed: resolved.is_some(),
                path: resolved.map(|p| p.to_string_lossy().to_string()),
            }
        })
        .collect()
}

pub fn resolve_agent_binary(agent: AgentId) -> Option<PathBuf> {
    let env_key = format!("GUIDELENS_AGENT_BIN_{}", agent.as_str().to_ascii_uppercase());
    if let Ok(override_path) = std::env::var(&env_key) {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            let pb = PathBuf::from(trimmed);
            if pb.exists() {
                return Some(pb);
            }
        }
    }

    match agent {
        AgentId::Copilot => which::which("copilot")
            .ok()
            .or_else(|| which::which("github-copilot").ok())
            .or_else(|| which::which("gh").ok()),
        AgentId::Custom => None,
        _ => which::which(agent.binary_name()).ok(),
    }
}

#[derive(Debug, Clone)]
pub struct AgentCliProvider {
    pub agent: AgentId,
    pub binary_override: Option<PathBuf>,
    pub custom_args: Option<Vec<String>>,
    pub custom_agent_cmd: Option<String>,
    pub timeout: Duration,
}

impl AgentCliProvider {
    pub fn new(agent: AgentId) -> Self {
        Self {
            agent,
            binary_override: None,
            custom_args: None,
            custom_agent_cmd: None,
            timeout: Duration::from_secs(45),
        }
    }

    pub fn with_custom_cmd(agent: AgentId, custom_cmd: Option<String>) -> Self {
        Self {
            agent,
            binary_override: None,
            custom_args: None,
            custom_agent_cmd: custom_cmd,
            timeout: Duration::from_secs(45),
        }
    }

    pub fn with_executable(
        agent: AgentId,
        binary_path: PathBuf,
        custom_args: Option<Vec<String>>,
        timeout: Duration,
    ) -> Self {
        Self {
            agent,
            binary_override: Some(binary_path),
            custom_args,
            custom_agent_cmd: None,
            timeout,
        }
    }

    pub fn build_cli_prompt(req: &BrainRequest) -> String {
        let mut out = String::with_capacity(req.system_prompt.len() + req.user_prompt.len() + 256);
        out.push_str(&req.system_prompt);
        if !req.image_path.trim().is_empty() {
            out.push_str("\n\nScreenshot Image File Path: ");
            out.push_str(req.image_path.trim());
        }
        out.push_str("\n\n");
        out.push_str(&req.user_prompt);
        if req.has_som {
            out.push_str("\nIMPORTANT: Use the numbered GROUNDED UI ELEMENTS table above and reply ONLY with the StepPlan JSON object.");
        } else {
            out.push_str("\nIMPORTANT: Inspect the screenshot/context above and reply ONLY with the StepPlan JSON object.");
        }
        out
    }

    pub fn extract_text_from_cli_stdout(stdout: &str) -> String {
        let trimmed = stdout.trim();
        if trimmed.is_empty() {
            return String::new();
        }
        if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
            for key in ["result", "response", "text", "content", "output", "message"] {
                if let Some(inner_str) = val.get(key).and_then(|v| v.as_str()) {
                    if !inner_str.trim().is_empty() {
                        return inner_str.trim().to_string();
                    }
                }
            }
        }
        trimmed.to_string()
    }

    pub fn parse_cli_stdout(stdout: &str) -> Result<StepPlan, String> {
        let trimmed = stdout.trim();
        if trimmed.is_empty() {
            return Err("Agent CLI returned empty stdout".to_string());
        }

        // Direct StepPlan parse first
        if let Ok(plan) = parse_and_repair_step_plan(trimmed) {
            return Ok(plan);
        }

        // Some CLIs (e.g. `claude --output-format json` or `gemini --output-format json`) wrap text in an envelope object
        if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
            for key in ["result", "response", "text", "content", "output", "message"] {
                if let Some(inner_str) = val.get(key).and_then(|v| v.as_str()) {
                    if let Ok(plan) = parse_and_repair_step_plan(inner_str) {
                        return Ok(plan);
                    }
                }
            }
        }

        Err("Agent CLI stdout did not contain a valid StepPlan JSON".to_string())
    }

    fn resolve_invocation(&self, has_som: bool, prompt: &str) -> Result<(PathBuf, Vec<String>), BrainError> {
        if let Some(ref bin) = self.binary_override {
            let args = self
                .custom_args
                .clone()
                .unwrap_or_else(|| self.agent.build_stdin_args(bin, has_som));
            return Ok((bin.clone(), args));
        }

        if self.agent == AgentId::Custom {
            if let Some((bin, mut parsed_args)) =
                resolve_custom_command(self.custom_agent_cmd.as_deref())
            {
                let args = if let Some(ref custom) = self.custom_args {
                    custom.clone()
                } else {
                    for arg in &mut parsed_args {
                        if arg.contains("{prompt}") {
                            *arg = arg.replace("{prompt}", prompt);
                        }
                    }
                    parsed_args
                };
                return Ok((bin, args));
            }
        }

        let binary = resolve_agent_binary(self.agent).ok_or_else(|| {
            BrainError::new(
                BrainErrorCode::Unavailable,
                BrainKind::AgentCli,
                format!(
                    "Agent CLI '{}' is not installed or not found on PATH.",
                    self.agent.as_str()
                ),
            )
        })?;
        let args = self
            .custom_args
            .clone()
            .unwrap_or_else(|| self.agent.build_stdin_args(&binary, has_som));
        Ok((binary, args))
    }

    async fn run_command_with_stdin(
        &self,
        binary: &Path,
        args: &[String],
        stdin_payload: Option<&str>,
        timeout: Duration,
    ) -> Result<(bool, String, String), BrainError> {
        let mut cmd = Command::new(binary);
        cmd.args(args)
            .stdin(if stdin_payload.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| {
            BrainError::new(
                BrainErrorCode::Unavailable,
                BrainKind::AgentCli,
                format!("Failed to launch agent CLI '{}': {}", self.agent.as_str(), e),
            )
        })?;

        if let Some(payload) = stdin_payload {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(payload.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
        }

        let output = tokio::time::timeout(timeout, child.wait_with_output())
            .await
            .map_err(|_| {
                BrainError::new(
                    BrainErrorCode::Timeout,
                    BrainKind::AgentCli,
                    format!(
                        "Agent CLI '{}' timed out after {}s",
                        self.agent.as_str(),
                        timeout.as_secs()
                    ),
                )
            })?
            .map_err(|e| {
                BrainError::new(
                    BrainErrorCode::Unknown,
                    BrainKind::AgentCli,
                    format!("Agent CLI '{}' failed: {}", self.agent.as_str(), e),
                )
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Ok((output.status.success(), stdout, stderr))
    }

    /// Executes a plain text prompt (used for Nightly Screen Day summaries).
    pub async fn generate_text(&self, prompt: &str) -> Result<String, String> {
        let (binary, args) = self
            .resolve_invocation(true, prompt)
            .map_err(|e| e.message)?;
        let (ok, stdout, stderr) = self
            .run_command_with_stdin(&binary, &args, Some(prompt), self.timeout)
            .await
            .map_err(|e| e.message)?;
        let text = Self::extract_text_from_cli_stdout(&stdout);
        if ok && !text.is_empty() {
            return Ok(text);
        }
        if !text.is_empty() {
            return Ok(text);
        }
        Err(format!(
            "Agent CLI '{}' returned empty output: {}",
            self.agent.as_str(),
            stderr.trim().chars().take(200).collect::<String>()
        ))
    }

    /// Probes the CLI binary (`--version`) for fast connection verification.
    pub async fn probe_version(&self) -> Result<String, String> {
        let (binary, mut args) = self
            .resolve_invocation(true, "")
            .map_err(|e| e.message)?;
        args.clear();
        if self.agent == AgentId::Copilot
            && binary
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("gh"))
        {
            args.push("copilot".to_string());
        }
        args.push("--version".to_string());

        let (ok, stdout, stderr) = self
            .run_command_with_stdin(&binary, &args, None, Duration::from_secs(6))
            .await
            .map_err(|e| e.message)?;
        let ver = stdout
            .lines()
            .next()
            .or_else(|| stderr.lines().next())
            .unwrap_or("")
            .trim()
            .to_string();
        if ok || !ver.is_empty() {
            Ok(if ver.is_empty() {
                format!("{} ready", binary.display())
            } else {
                ver
            })
        } else {
            Err(format!("Agent CLI '{}' did not respond to --version", self.agent.as_str()))
        }
    }
}

#[async_trait]
impl BrainProvider for AgentCliProvider {
    fn kind(&self) -> BrainKind {
        BrainKind::AgentCli
    }

    async fn generate_plan(&self, req: &BrainRequest) -> Result<StepPlan, BrainError> {
        let prompt = Self::build_cli_prompt(req);
        let (binary, args) = self.resolve_invocation(req.has_som, &prompt)?;

        let (success, stdout, stderr) = self
            .run_command_with_stdin(&binary, &args, Some(&prompt), self.timeout)
            .await?;

        if !success {
            if let Ok(plan) = Self::parse_cli_stdout(&stdout) {
                return Ok(plan);
            }
            let snippet: String = stderr.trim().chars().take(240).collect();
            return Err(BrainError::new(
                BrainErrorCode::Unavailable,
                BrainKind::AgentCli,
                format!(
                    "Agent CLI '{}' exited with error: {}",
                    self.agent.as_str(),
                    if snippet.is_empty() {
                        "non-zero exit".to_string()
                    } else {
                        snippet
                    }
                ),
            ));
        }

        Self::parse_cli_stdout(&stdout).map_err(|e| {
            BrainError::new(
                BrainErrorCode::InvalidResponse,
                BrainKind::AgentCli,
                format!("Agent CLI '{}' output error: {}", self.agent.as_str(), e),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_cli_arg_builders_match_spec() {
        assert_eq!(AgentId::Claude.build_args("hi"), vec!["-p", "hi"]);
        assert_eq!(AgentId::Codex.build_args("hi"), vec!["exec", "hi"]);
        assert_eq!(AgentId::Gemini.build_args("hi"), vec!["-p", "hi"]);
        assert_eq!(AgentId::Agy.build_args("hi"), vec!["-p", "hi"]);
        assert_eq!(AgentId::Copilot.build_args("hi"), vec!["-p", "hi"]);
        assert_eq!(AgentId::Opencode.build_args("hi"), vec!["run", "hi"]);
        assert_eq!(AgentId::Hermes.build_args("hi"), vec!["-p", "hi"]);

        assert_eq!(
            AgentId::Claude.build_stdin_args(Path::new("claude"), true),
            vec!["-p", "--max-turns", "1", "--output-format", "json"]
        );
        assert_eq!(
            AgentId::Codex.build_stdin_args(Path::new("codex"), true),
            vec!["exec", "-"]
        );
        assert_eq!(
            AgentId::Copilot.build_stdin_args(Path::new("gh.exe"), true),
            vec!["copilot", "-p", "Follow the instructions provided on stdin."]
        );
    }

    #[test]
    fn parses_custom_command_with_quotes_and_wrapped_cli_stdout() {
        let parts = split_command_line(r#""C:\Program Files\My Agent\cli.exe" --headless --json"#);
        assert_eq!(
            parts,
            vec![r"C:\Program Files\My Agent\cli.exe", "--headless", "--json"]
        );

        let wrapped = r#"{
            "type": "result",
            "result": "```json\n{\"mode\":\"guide\",\"total_steps\":1,\"steps\":[{\"step_number\":1,\"instruction_line\":\"Click Run button.\",\"target_name\":\"Run\",\"target_id\":4,\"action_kind\":\"click\",\"companion_emotion\":\"pointing\",\"confidence\":0.9}]}\n```"
        }"#;
        let plan = AgentCliProvider::parse_cli_stdout(wrapped).expect("parse wrapped");
        assert_eq!(plan.steps[0].instruction_line, "Click Run button.");
        assert_eq!(plan.steps[0].target_id, Some(4));
        assert_eq!(plan.steps[0].action_kind.as_deref(), Some("click"));
    }

    #[tokio::test]
    async fn executes_local_script_with_piped_stdin_and_handles_timeout() {
        let req = BrainRequest {
            query: "Stage changes".to_string(),
            image_base64: "abc".to_string(),
            image_path: "C:\\tmp\\shot.jpg".to_string(),
            active_app: "WindowsTerminal.exe".to_string(),
            window_title: "PowerShell".to_string(),
            screen_resolution: (1920, 1080),
            system_prompt: "Return JSON".to_string(),
            user_prompt: "Stage changes".to_string(),
            conversation_history: vec![],
            has_som: true,
            max_tokens: Some(280),
        };

        #[cfg(windows)]
        let (bin, ok_args, slow_args) = (
            PathBuf::from("powershell.exe"),
            vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                r#"Write-Output '{"mode":"terminal","total_steps":1,"steps":[{"step_number":1,"instruction_line":"Stage all edited files.","terminal_command":"git add -A","confidence":0.95}]}'"#.to_string(),
            ],
            vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Start-Sleep -Seconds 3".to_string(),
            ],
        );

        #[cfg(not(windows))]
        let (bin, ok_args, slow_args) = (
            PathBuf::from("sh"),
            vec![
                "-c".to_string(),
                r#"echo '{"mode":"terminal","total_steps":1,"steps":[{"step_number":1,"instruction_line":"Stage all edited files.","terminal_command":"git add -A","confidence":0.95}]}'"#.to_string(),
            ],
            vec!["-c".to_string(), "sleep 3".to_string()],
        );

        let provider = AgentCliProvider::with_executable(
            AgentId::Claude,
            bin.clone(),
            Some(ok_args),
            Duration::from_secs(5),
        );
        let plan = provider.generate_plan(&req).await.expect("cli success");
        assert_eq!(
            plan.steps[0].terminal_command.as_deref(),
            Some("git add -A")
        );

        let slow_provider = AgentCliProvider::with_executable(
            AgentId::Claude,
            bin,
            Some(slow_args),
            Duration::from_millis(150),
        );
        let err = slow_provider.generate_plan(&req).await.unwrap_err();
        assert_eq!(err.code, BrainErrorCode::Timeout);
    }
}
