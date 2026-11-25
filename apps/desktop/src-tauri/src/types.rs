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
    #[serde(default)]
    pub target_id: Option<u32>,
    #[serde(default)]
    pub action_kind: Option<String>,
    #[serde(default)]
    pub companion_emotion: Option<String>,
    #[serde(default)]
    pub goal_complete: bool,
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
    Som,
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
    pub target_id: Option<u32>,
    #[serde(default)]
    pub action_kind: Option<String>,
    #[serde(default)]
    pub companion_emotion: Option<String>,
    #[serde(default)]
    pub goal_complete: bool,
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
        let (final_rect, final_source) =
            if step.confidence < 0.5 && !matches!(source, StepSource::Uia | StepSource::Som) {
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
            target_id: step.target_id,
            action_kind: step.action_kind,
            companion_emotion: step.companion_emotion,
            goal_complete: step.goal_complete,
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
            target_id: self.target_id,
            action_kind: self.action_kind.clone(),
            companion_emotion: self.companion_emotion.clone(),
            goal_complete: self.goal_complete,
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

fn default_companion_id() -> String {
    "pixel_cat".to_string()
}

fn default_companion_wander() -> bool {
    true
}

fn default_screenday_interval_sec() -> u32 {
    15
}

fn default_screenday_skip_private() -> bool {
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
    #[serde(default = "default_companion_id")]
    pub companion_id: String,
    #[serde(default = "default_companion_wander")]
    pub companion_wander: bool,
    #[serde(default)]
    pub screenday_enabled: bool,
    #[serde(default = "default_screenday_interval_sec")]
    pub screenday_interval_sec: u32,
    #[serde(default)]
    pub screenday_excluded_apps: Vec<String>,
    #[serde(default = "default_screenday_skip_private")]
    pub screenday_skip_private: bool,
    #[serde(default)]
    pub custom_api_base_url: Option<String>,
    #[serde(default)]
    pub custom_agent_cmd: Option<String>,
    #[serde(default)]
    pub summary_brain_mode: Option<String>,
    #[serde(default)]
    pub summary_byo_provider: Option<String>,
    #[serde(default)]
    pub summary_byo_model: Option<String>,
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
            companion_id: default_companion_id(),
            companion_wander: default_companion_wander(),
            screenday_enabled: false,
            screenday_interval_sec: default_screenday_interval_sec(),
            screenday_excluded_apps: Vec::new(),
            screenday_skip_private: default_screenday_skip_private(),
            custom_api_base_url: None,
            custom_agent_cmd: None,
            summary_brain_mode: None,
            summary_byo_provider: None,
            summary_byo_model: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct LatencyBreakdown {
    pub capture_ms: u64,
    pub grounding_ms: u64,
    pub memory_ms: u64,
    pub llm_ms: u64,
    pub total_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AskResponse {
    pub session_id: String,
    pub brain: BrainKind,
    pub plan: StepPlan,
    pub resolved_steps: Vec<ResolvedStep>,
    pub capture_path: Option<String>,
    pub monitor: Option<MonitorInfo>,
    #[serde(default)]
    pub latency: Option<LatencyBreakdown>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroundedElementSource {
    Uia,
    Taskbar,
    Ocr,
    Vision,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroundedElement {
    pub id: u32,
    pub label: String,
    pub control_type: String,
    pub rect_px: RectPx,
    pub norm_bbox: [f64; 4],
    pub source: GroundedElementSource,
    pub is_taskbar: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroundingSnapshot {
    pub monitor: MonitorInfo,
    pub active_app: String,
    pub window_title: String,
    pub hwnd: isize,
    pub dhash64: String,
    pub elements: Vec<GroundedElement>,
    pub element_table_prompt: String,
    pub capture_ms: u64,
    pub grounding_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LiveSessionStatus {
    #[default]
    Idle,
    Listening,
    Observing,
    Guiding,
    WaitingSettle,
    Paused,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveSessionTurn {
    pub turn_number: u32,
    pub user_text: Option<String>,
    pub instruction_line: String,
    pub spoken_text: Option<String>,
    pub action_kind: Option<String>,
    pub companion_emotion: Option<String>,
    pub target_name: Option<String>,
    pub rect_px: Option<RectPx>,
    pub active_app: String,
    pub window_title: String,
    pub latency: Option<LatencyBreakdown>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveSessionState {
    pub session_id: Option<String>,
    pub status: LiveSessionStatus,
    pub goal: String,
    pub companion_id: String,
    pub current_step: Option<ResolvedStep>,
    pub current_monitor: Option<MonitorInfo>,
    pub turn_count: u32,
    pub turns: Vec<LiveSessionTurn>,
    pub graph_md_path: Option<String>,
    pub started_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OverlayCompanionPayload {
    pub mode: String,
    pub companion_id: String,
    pub emotion: String,
    pub wander: bool,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub bubble_text: Option<String>,
    pub screenday_recording: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KgNodeDto {
    pub id: String,
    pub node_type: String,
    pub app_exe: String,
    pub label: String,
    pub metadata_json: Option<String>,
    pub hit_count: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KgEdgeDto {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub relation: String,
    pub intent: String,
    pub control_name: Option<String>,
    pub control_type: Option<String>,
    pub shortcut: Option<String>,
    pub norm_bbox: Option<[f64; 4]>,
    pub success_count: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionGraphSummaryDto {
    pub session_id: String,
    pub day_key: String,
    pub active_app: String,
    pub goal: String,
    pub graph_md_path: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub completed: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnowledgeGraphDto {
    pub nodes: Vec<KgNodeDto>,
    pub edges: Vec<KgEdgeDto>,
    pub sessions: Vec<SessionGraphSummaryDto>,
    pub master_md_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScreenDayFrameDto {
    pub id: String,
    pub day_key: String,
    pub captured_at: i64,
    pub image_path: String,
    pub active_app: String,
    pub window_title: String,
    pub project_name: Option<String>,
    pub meeting_name: Option<String>,
    pub ocr_excerpt: Option<String>,
    pub dhash: String,
    pub file_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScreenDayProjectGroup {
    pub name: String,
    pub frame_count: usize,
    pub apps: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScreenDayMeetingGroup {
    pub name: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub frame_count: usize,
    pub screen_topics: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScreenDaySummaryDto {
    pub day_key: String,
    pub folder_path: String,
    pub frame_count: usize,
    pub total_bytes: u64,
    pub session_count: usize,
    pub projects: Vec<String>,
    pub meetings: Vec<String>,
    pub summary_md: Option<String>,
    pub graph_md_path: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScreenDayDetailDto {
    pub summary: ScreenDaySummaryDto,
    pub frames: Vec<ScreenDayFrameDto>,
    pub project_groups: Vec<ScreenDayProjectGroup>,
    pub meeting_groups: Vec<ScreenDayMeetingGroup>,
    pub sessions: Vec<SessionGraphSummaryDto>,
    pub day_graph_md: Option<String>,
    pub day_diary_md: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScreenDayStatusDto {
    pub enabled: bool,
    pub interval_sec: u32,
    pub today_key: String,
    pub today_frames: usize,
    pub today_bytes: u64,
    pub last_captured_at: Option<i64>,
    pub current_project: Option<String>,
    pub current_meeting: Option<String>,
    pub skipped_private: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub brain: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub latency_ms: u64,
    pub message: String,
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
            target_id: Some(7),
            action_kind: Some("click".to_string()),
            companion_emotion: Some("pointing".to_string()),
            goal_complete: false,
        };
        step.enforce_limits();
        let clamped = step.spoken_text.as_deref().expect("clamped spoken_text");
        assert_eq!(clamped.chars().count(), MAX_INSTRUCTION_CHARS);
        assert!(clamped.ends_with('…'));

        let resolved = ResolvedStep::from_step(step.clone(), None, StepSource::None);
        assert_eq!(resolved.spoken_text, step.spoken_text);
        assert_eq!(resolved.target_id, Some(7));
        assert_eq!(resolved.action_kind.as_deref(), Some("click"));
        assert_eq!(resolved.companion_emotion.as_deref(), Some("pointing"));
        assert!(!resolved.goal_complete);
        let roundtrip = resolved.to_step();
        assert_eq!(roundtrip.spoken_text, step.spoken_text);
        assert_eq!(roundtrip.target_id, Some(7));
        assert_eq!(roundtrip.action_kind.as_deref(), Some("click"));
        assert_eq!(roundtrip.companion_emotion.as_deref(), Some("pointing"));
        assert!(!roundtrip.goal_complete);

        let mut blank_step = Step {
            spoken_text: Some("   \n\t  ".to_string()),
            ..roundtrip
        };
        blank_step.enforce_limits();
        assert_eq!(blank_step.spoken_text, None);
    }

    #[test]
    fn som_step_preserves_rect_with_low_confidence_and_roundtrips_v2_fields() {
        let step = Step {
            step_number: 2,
            instruction_line: "Click the Export button.".to_string(),
            target_name: Some("Export".to_string()),
            control_type: Some("Button".to_string()),
            bbox: None,
            confidence: 0.25,
            shortcut: None,
            terminal_command: None,
            explanation: None,
            spoken_text: Some("Tap Export at the top right.".to_string()),
            target_id: Some(14),
            action_kind: Some("click".to_string()),
            companion_emotion: Some("happy".to_string()),
            goal_complete: true,
        };
        let rect = RectPx {
            x: 1200,
            y: 44,
            w: 84,
            h: 32,
        };
        let resolved = ResolvedStep::from_step(step, Some(rect), StepSource::Som);
        assert_eq!(resolved.source, StepSource::Som);
        assert_eq!(resolved.rect_px, Some(rect));
        assert_eq!(resolved.target_id, Some(14));
        assert_eq!(resolved.action_kind.as_deref(), Some("click"));
        assert_eq!(resolved.companion_emotion.as_deref(), Some("happy"));
        assert!(resolved.goal_complete);
        assert_eq!(serde_json::to_string(&StepSource::Som).unwrap(), "\"som\"");
    }

    #[test]
    fn legacy_settings_json_deserializes_with_v2_defaults() {
        let legacy_json = r#"{
            "brain_mode": "auto",
            "onboarding_complete": true
        }"#;
        let settings: Settings =
            serde_json::from_str(legacy_json).expect("legacy settings JSON must deserialize");
        assert_eq!(settings.companion_id, "pixel_cat");
        assert!(settings.companion_wander);
        assert!(!settings.screenday_enabled);
        assert_eq!(settings.screenday_interval_sec, 15);
        assert!(settings.screenday_excluded_apps.is_empty());
        assert!(settings.screenday_skip_private);
        assert_eq!(settings.custom_api_base_url, None);
        assert_eq!(settings.custom_agent_cmd, None);
        assert_eq!(settings.summary_brain_mode, None);
        assert_eq!(settings.summary_byo_provider, None);
        assert_eq!(settings.summary_byo_model, None);

        let defaults = Settings::default();
        assert_eq!(defaults.companion_id, "pixel_cat");
        assert!(defaults.companion_wander);
        assert!(!defaults.screenday_enabled);
        assert_eq!(defaults.screenday_interval_sec, 15);
        assert!(defaults.screenday_excluded_apps.is_empty());
        assert!(defaults.screenday_skip_private);
        assert_eq!(defaults.custom_api_base_url, None);
        assert_eq!(defaults.custom_agent_cmd, None);
        assert_eq!(defaults.summary_brain_mode, None);
        assert_eq!(defaults.summary_byo_provider, None);
        assert_eq!(defaults.summary_byo_model, None);
    }

    #[test]
    fn v2_dtos_serialize_snake_case_enums_and_roundtrip() {
        assert_eq!(
            serde_json::to_string(&GroundedElementSource::Taskbar).unwrap(),
            "\"taskbar\""
        );
        assert_eq!(
            serde_json::to_string(&LiveSessionStatus::WaitingSettle).unwrap(),
            "\"waiting_settle\""
        );

        let conn = ConnectionTestResult {
            ok: true,
            brain: "byo_api".to_string(),
            provider: Some("deepseek".to_string()),
            model: Some("deepseek-chat".to_string()),
            latency_ms: 142,
            message: "Connected".to_string(),
        };
        let encoded = serde_json::to_string(&conn).unwrap();
        let decoded: ConnectionTestResult = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, conn);
    }
}
