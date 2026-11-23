use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

pub const MAX_INSTRUCTION_CHARS: usize = 140;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StepMode {
    #[default]
    Guide,
    Explain,
    Terminal,
}

impl StepMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            StepMode::Guide => "guide",
            StepMode::Explain => "explain",
            StepMode::Terminal => "terminal",
        }
    }
}

fn default_confidence() -> f64 {
    0.8
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub step_number: u32,
    pub instruction_line: String,
    #[serde(default)]
    pub target_name: Option<String>,
    #[serde(default)]
    pub control_type: Option<String>,
    #[serde(default)]
    pub bbox: Option<[f64; 4]>,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    #[serde(default)]
    pub shortcut: Option<String>,
    #[serde(default)]
    pub terminal_command: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default)]
    pub spoken_text: Option<String>,
}

impl Step {
    pub fn clamp_instruction(text: &str) -> String {
        let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let char_count = collapsed.chars().count();
        if char_count <= MAX_INSTRUCTION_CHARS {
            collapsed
        } else {
            let truncated: String = collapsed.chars().take(MAX_INSTRUCTION_CHARS - 1).collect();
            format!("{}…", truncated.trim_end())
        }
    }

    pub fn enforce_limits(&mut self) {
        self.instruction_line = Self::clamp_instruction(&self.instruction_line);
        if let Some(ref exp) = self.explanation {
            self.explanation = Some(Self::clamp_instruction(exp));
        }
        if let Some(ref spoken) = self.spoken_text {
            let clamped = Self::clamp_instruction(spoken);
            self.spoken_text = if clamped.is_empty() {
                None
            } else {
                Some(clamped)
            };
        }
        self.confidence = self.confidence.clamp(0.0, 1.0);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepPlan {
    #[serde(default)]
    pub mode: StepMode,
    pub total_steps: u32,
    pub steps: Vec<Step>,
}

impl StepPlan {
    pub fn enforce_limits(&mut self) {
        for (idx, step) in self.steps.iter_mut().enumerate() {
            if step.step_number == 0 {
                step.step_number = (idx + 1) as u32;
            }
            step.enforce_limits();
        }
        self.total_steps = self.steps.len().max(1) as u32;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RectPx {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl RectPx {
    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StepSource {
    Uia,
    Vlm,
    #[default]
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedStep {
    pub step_number: u32,
    pub instruction_line: String,
    #[serde(default)]
    pub target_name: Option<String>,
    #[serde(default)]
    pub control_type: Option<String>,
    #[serde(default)]
    pub bbox: Option<[f64; 4]>,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    #[serde(default)]
    pub shortcut: Option<String>,
    #[serde(default)]
    pub terminal_command: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default)]
    pub spoken_text: Option<String>,
    #[serde(default)]
    pub rect_px: Option<RectPx>,
    #[serde(default)]
    pub source: StepSource,
}

impl ResolvedStep {
    pub fn from_step(
        mut step: Step,
        rect_px: Option<RectPx>,
        source: StepSource,
    ) -> Self {
        step.enforce_limits();
        let (final_rect, final_source) = if step.confidence < 0.5 && source != StepSource::Uia {
            (None, StepSource::None)
        } else if rect_px.is_some() {
            (rect_px, source)
        } else {
            (None, StepSource::None)
        };

        Self {
            step_number: step.step_number,
            instruction_line: step.instruction_line,
            target_name: step.target_name,
            control_type: step.control_type,
            bbox: step.bbox,
            confidence: step.confidence,
            shortcut: step.shortcut,
            terminal_command: step.terminal_command,
            explanation: step.explanation,
            spoken_text: step.spoken_text,
            rect_px: final_rect,
            source: final_source,
        }
    }

    pub fn to_step(&self) -> Step {
        Step {
            step_number: self.step_number,
            instruction_line: self.instruction_line.clone(),
            target_name: self.target_name.clone(),
            control_type: self.control_type.clone(),
            bbox: self.bbox,
            confidence: self.confidence,
            shortcut: self.shortcut.clone(),
            terminal_command: self.terminal_command.clone(),
            explanation: self.explanation.clone(),
            spoken_text: self.spoken_text.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrainKind {
    AgentMcp,
    AgentCli,
    #[default]
    LocalVlm,
    ByoApi,
    GroqPro,
}

impl BrainKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            BrainKind::AgentMcp => "agent_mcp",
            BrainKind::AgentCli => "agent_cli",
            BrainKind::LocalVlm => "local_vlm",
            BrainKind::ByoApi => "byo_api",
            BrainKind::GroqPro => "groq_pro",
        }
    }

    pub const ALL: [BrainKind; 5] = [
        BrainKind::AgentMcp,
        BrainKind::AgentCli,
        BrainKind::LocalVlm,
        BrainKind::ByoApi,
        BrainKind::GroqPro,
    ];
}

impl fmt::Display for BrainKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for BrainKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "agent_mcp" => Ok(BrainKind::AgentMcp),
            "agent_cli" => Ok(BrainKind::AgentCli),
            "local_vlm" => Ok(BrainKind::LocalVlm),
            "byo_api" => Ok(BrainKind::ByoApi),
            "groq_pro" => Ok(BrainKind::GroqPro),
            other => Err(format!("Invalid BrainKind: {}", other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub scale: f64,
}

impl Default for MonitorInfo {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
            scale: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BarPosition {
    pub x: i32,
    pub y: i32,
}

fn default_brain_mode() -> String {
    "auto".to_string()
}

fn default_brain_priority() -> Vec<BrainKind> {
    vec![
        BrainKind::AgentCli,
        BrainKind::ByoApi,
        BrainKind::GroqPro,
        BrainKind::LocalVlm,
    ]
}

fn default_byo_provider() -> Option<String> {
    Some("groq".to_string())
}

fn default_agent_id() -> Option<String> {
    Some("claude".to_string())
}

fn default_ollama_model() -> String {
    "qwen2.5vl:3b".to_string()
}

fn default_stt_engine() -> String {
    "web_speech".to_string()
}

fn default_retention_days() -> u32 {
    7
}

pub fn default_cloud_url() -> String {
    std::env::var("GUIDELENS_CLOUD_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:8000".to_string())
}

fn default_tts_enabled() -> bool {
    true
}

fn default_tts_voice() -> String {
    "M2".to_string()
}

fn default_tts_speed() -> f64 {
    1.0
}

fn default_tts_pitch_shift() -> f64 {
    0.0
}

fn default_tts_auto_speak() -> bool {
    true
}

fn default_voice_conversation_mode() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_brain_mode")]
    pub brain_mode: String,
    #[serde(default = "default_brain_priority")]
    pub brain_priority: Vec<BrainKind>,
    #[serde(default = "default_byo_provider")]
    pub byo_provider: Option<String>,
    #[serde(default)]
    pub byo_model: Option<String>,
    #[serde(default = "default_agent_id")]
    pub agent_id: Option<String>,
    #[serde(default = "default_ollama_model")]
    pub ollama_model: String,
    #[serde(default = "default_stt_engine")]
    pub stt_engine: String,
    #[serde(default)]
    pub voice_enabled: bool,
    #[serde(default)]
    pub high_contrast: bool,
    #[serde(default)]
    pub always_magnify: bool,
    #[serde(default = "default_retention_days")]
    pub capture_retention_days: u32,
    #[serde(default)]
    pub onboarding_complete: bool,
    #[serde(default)]
    pub bar_position: Option<BarPosition>,
    #[serde(default = "default_cloud_url")]
    pub cloud_url: String,
    #[serde(default = "default_tts_enabled")]
    pub tts_enabled: bool,
    #[serde(default = "default_tts_voice")]
    pub tts_voice: String,
    #[serde(default = "default_tts_speed")]
    pub tts_speed: f64,
    #[serde(default = "default_tts_pitch_shift")]
    pub tts_pitch_shift: f64,
    #[serde(default = "default_tts_auto_speak")]
    pub tts_auto_speak: bool,
    #[serde(default = "default_voice_conversation_mode")]
    pub voice_conversation_mode: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            brain_mode: default_brain_mode(),
            brain_priority: default_brain_priority(),
            byo_provider: default_byo_provider(),
            byo_model: None,
            agent_id: default_agent_id(),
            ollama_model: default_ollama_model(),
            stt_engine: default_stt_engine(),
            voice_enabled: false,
            high_contrast: false,
            always_magnify: false,
            capture_retention_days: default_retention_days(),
            onboarding_complete: false,
            bar_position: None,
            cloud_url: default_cloud_url(),
            tts_enabled: default_tts_enabled(),
            tts_voice: default_tts_voice(),
            tts_speed: default_tts_speed(),
            tts_pitch_shift: default_tts_pitch_shift(),
            tts_auto_speak: default_tts_auto_speak(),
            voice_conversation_mode: default_voice_conversation_mode(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AskResponse {
    pub session_id: String,
    pub brain: BrainKind,
    pub plan: StepPlan,
    pub resolved_steps: Vec<ResolvedStep>,
    pub capture_path: Option<String>,
    pub monitor: Option<MonitorInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepChangedPayload {
    pub step: ResolvedStep,
    pub index: usize,
    pub total: usize,
    pub magnify: bool,
    pub high_contrast: bool,
    pub capture_path: Option<String>,
    pub monitor: Option<MonitorInfo>,
    pub mode: StepMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrainStatusPayload {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OllamaPullProgressPayload {
    pub model: String,
    pub pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OllamaStatusPayload {
    pub running: bool,
    pub models: Vec<String>,
    pub install_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistorySession {
    pub id: String,
    pub active_app: String,
    pub user_query: String,
    pub brain_used: BrainKind,
    pub created_at: i64,
    pub step_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryStep {
    pub id: String,
    pub session_id: String,
    pub step_number: u32,
    pub instruction_line: String,
    pub bbox: Option<[f64; 4]>,
    pub bbox_json: Option<String>,
    pub terminal_command: Option<String>,
    pub screenshot_path: Option<String>,
    pub completed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryDetail {
    pub session: HistorySession,
    pub steps: Vec<HistoryStep>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_settings_json_deserializes_with_tts_defaults() {
        let legacy_json = r#"{
            "brain_mode": "groq_pro",
            "voice_enabled": true,
            "high_contrast": true,
            "capture_retention_days": 14,
            "onboarding_complete": true
        }"#;

        let settings: Settings =
            serde_json::from_str(legacy_json).expect("legacy settings JSON must deserialize");
        assert_eq!(settings.brain_mode, "groq_pro");
        assert!(settings.voice_enabled);
        assert!(settings.high_contrast);
        assert_eq!(settings.capture_retention_days, 14);
        assert!(settings.onboarding_complete);

        assert!(settings.tts_enabled);
        assert_eq!(settings.tts_voice, "M2");
        assert!((settings.tts_speed - 1.0).abs() < 1e-9);
        assert!((settings.tts_pitch_shift - 0.0).abs() < 1e-9);
        assert!(settings.tts_auto_speak);
        assert!(settings.voice_conversation_mode);

        let defaults = Settings::default();
        assert!(defaults.tts_enabled);
        assert_eq!(defaults.tts_voice, "M2");
        assert!((defaults.tts_speed - 1.0).abs() < 1e-9);
        assert!((defaults.tts_pitch_shift - 0.0).abs() < 1e-9);
        assert!(defaults.tts_auto_speak);
        assert!(defaults.voice_conversation_mode);
    }

    #[test]
    fn step_and_resolved_step_clamp_and_preserve_spoken_text() {
        let long_spoken = "x".repeat(MAX_INSTRUCTION_CHARS + 20);
        let mut step = Step {
            step_number: 1,
            instruction_line: "Click File.".to_string(),
            target_name: Some("File".to_string()),
            control_type: Some("MenuItem".to_string()),
            bbox: Some([10.0, 20.0, 30.0, 20.0]),
            confidence: 0.9,
            shortcut: None,
            terminal_command: None,
            explanation: None,
            spoken_text: Some(long_spoken),
        };
        step.enforce_limits();
        let clamped = step.spoken_text.as_deref().expect("clamped spoken_text");
        assert_eq!(clamped.chars().count(), MAX_INSTRUCTION_CHARS);
        assert!(clamped.ends_with('…'));

        let resolved = ResolvedStep::from_step(step.clone(), None, StepSource::None);
        assert_eq!(resolved.spoken_text, step.spoken_text);
        let roundtrip = resolved.to_step();
        assert_eq!(roundtrip.spoken_text, step.spoken_text);

        let mut blank_step = Step {
            spoken_text: Some("   \n\t  ".to_string()),
            ..roundtrip
        };
        blank_step.enforce_limits();
        assert_eq!(blank_step.spoken_text, None);
    }
}
