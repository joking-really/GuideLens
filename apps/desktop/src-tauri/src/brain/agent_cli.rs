//! Headless local Agent CLI provider (`claude -p`, `codex exec`, `gemini -p`, `agy`, `hermes`).

use crate::brain::json_repair::parse_and_repair_step_plan;
use crate::brain::provider::{BrainError, BrainErrorCode, BrainProvider, BrainRequest};
use crate::types::{BrainKind, StepPlan};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentId {
    Claude,
    Codex,
    Gemini,
    Agy,
    Hermes,
}

impl AgentId {
    pub const ALL: [AgentId; 5] = [
        AgentId::Claude,
        AgentId::Codex,
        AgentId::Gemini,
        AgentId::Agy,
        AgentId::Hermes,
    ];

    pub fn from_str_id(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude_code" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "gemini" | "gemini_cli" => Some(Self::Gemini),
            "agy" | "antigravity" => Some(Self::Agy),
            "hermes" => Some(Self::Hermes),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::Agy => "agy",
            Self::Hermes => "hermes",
        }
    }

    pub fn binary_name(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::Agy => "agy",
            Self::Hermes => "hermes",
        }
    }

    pub fn build_args(&self, prompt: &str) -> Vec<String> {
        match self {
            Self::Claude => vec!["-p".to_string(), prompt.to_string()],
            Self::Codex => vec!["exec".to_string(), prompt.to_string()],
            Self::Gemini => vec!["-p".to_string(), prompt.to_string()],
            Self::Agy => vec!["-p".to_string(), prompt.to_string()],
            Self::Hermes => vec!["-p".to_string(), prompt.to_string()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectedAgent {
    pub id: String,
    pub installed: bool,
    pub path: Option<String>,
}

/// Scans `PATH` for the supported agent CLIs (`claude`, `codex`, `gemini`, `agy`, `hermes`).
pub fn detect_agents() -> Vec<DetectedAgent> {
    AgentId::ALL
        .iter()
        .map(|agent| {
            let resolved = resolve_agent_binary(*agent);
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
    which::which(agent.binary_name()).ok()
}

#[derive(Debug, Clone)]
pub struct AgentCliProvider {
    pub agent: AgentId,
    pub binary_override: Option<PathBuf>,
    pub custom_args: Option<Vec<String>>,
    pub timeout: Duration,
}

impl AgentCliProvider {
    pub fn new(agent: AgentId) -> Self {
        Self {
            agent,
            binary_override: None,
            custom_args: None,
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
            timeout,
        }
    }

    pub fn build_cli_prompt(req: &BrainRequest) -> String {
        // Keep CLI prompt compact (< 4000 chars) so Windows .cmd wrappers never hit cmd.exe's 8191-char limit.
        let compact_system: String = req.system_prompt.chars().take(2400).collect();
        format!(
            "{}\n\nScreenshot Image File Path: {}\n{}\nIMPORTANT: Inspect the screenshot file at the path above and reply ONLY with the StepPlan JSON object.",
            compact_system,
            req.image_path,
            req.user_prompt
        )
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

        // Some CLIs (e.g. `claude --output-format json` or `gemini`) wrap text in an envelope object
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
}

#[async_trait]
impl BrainProvider for AgentCliProvider {
    fn kind(&self) -> BrainKind {
        BrainKind::AgentCli
    }

    async fn generate_plan(&self, req: &BrainRequest) -> Result<StepPlan, BrainError> {
        let binary = self
            .binary_override
            .clone()
            .or_else(|| resolve_agent_binary(self.agent))
            .ok_or_else(|| {
                BrainError::new(
                    BrainErrorCode::Unavailable,
                    BrainKind::AgentCli,
                    format!(
                        "Agent CLI '{}' is not installed or not found on PATH.",
                        self.agent.binary_name()
                    ),
                )
            })?;

        let prompt = Self::build_cli_prompt(req);
        let args = self
            .custom_args
            .clone()
            .unwrap_or_else(|| self.agent.build_args(&prompt));

        let mut cmd = Command::new(&binary);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd.spawn().map_err(|e| {
            BrainError::new(
                BrainErrorCode::Unavailable,
                BrainKind::AgentCli,
                format!("Failed to launch agent CLI '{}': {}", self.agent.as_str(), e),
            )
        })?;

        let output = tokio::time::timeout(self.timeout, child.wait_with_output())
            .await
            .map_err(|_| {
                BrainError::new(
                    BrainErrorCode::Timeout,
                    BrainKind::AgentCli,
                    format!(
                        "Agent CLI '{}' timed out after {}s",
                        self.agent.as_str(),
                        self.timeout.as_secs()
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

        if !output.status.success() {
            // Try parsing stdout anyway in case CLI emitted JSON before non-zero exit
            if let Ok(plan) = Self::parse_cli_stdout(&stdout) {
                return Ok(plan);
            }
            let snippet: String = stderr.trim().chars().take(240).collect();
            return Err(BrainError::new(
                BrainErrorCode::Unavailable,
                BrainKind::AgentCli,
                format!(
                    "Agent CLI '{}' exited with {}: {}",
                    self.agent.as_str(),
                    output.status,
                    if snippet.is_empty() {
                        "no stderr".to_string()
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
        assert_eq!(AgentId::Hermes.build_args("hi"), vec!["-p", "hi"]);
    }

    #[test]
    fn parses_raw_and_wrapped_cli_stdout() {
        let wrapped = r#"{
            "type": "result",
            "result": "```json\n{\"mode\":\"guide\",\"total_steps\":1,\"steps\":[{\"step_number\":1,\"instruction_line\":\"Click Run button.\",\"target_name\":\"Run\",\"confidence\":0.9}]}\n```"
        }"#;
        let plan = AgentCliProvider::parse_cli_stdout(wrapped).expect("parse wrapped");
        assert_eq!(plan.steps[0].instruction_line, "Click Run button.");
    }

    #[tokio::test]
    async fn executes_local_script_and_handles_timeout() {
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
