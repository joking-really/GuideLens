// Core TypeScript types mirroring decisions.md §3 and §4

export type StepMode = "guide" | "explain" | "terminal";

/** Normalized [x, y, w, h] coordinates in 0–1000 scale relative to the captured monitor */
export type BBox = [number, number, number, number];

export interface Step {
  step_number: number;
  /** Concise plain-English instruction (<= 140 chars) */
  instruction_line: string;
  /** Optional target element name for Windows UI Automation snapping */
  target_name?: string | null;
  /** Optional UIA control type hint (e.g. "Button", "MenuItem") */
  control_type?: string | null;
  /** Optional normalized 0–1000 bounding box [x, y, w, h] */
  bbox?: BBox | null;
  /** Confidence score between 0.0 and 1.0 */
  confidence: number;
  /** Optional keyboard shortcut hint (e.g. "W", "Ctrl+Shift+P") */
  shortcut?: string | null;
  /** Command string when mode === "terminal" */
  terminal_command?: string | null;
  /** Single-line plain-English explanation */
  explanation?: string | null;
  /** Optional conversational speech cue for offline TTS (<= 140 chars) */
  spoken_text?: string | null;
  /** Set-of-Mark grounded element ID */
  target_id?: number | null;
  /** Action hint (e.g. "click", "type", "shortcut", "scroll") */
  action_kind?: string | null;
  /** Companion emotion cue (e.g. "pointing", "happy", "thinking") */
  companion_emotion?: string | null;
  /** True when the current live goal is complete */
  goal_complete?: boolean;
}

export interface StepPlan {
  mode: StepMode;
  total_steps: number;
  steps: Step[];
}

export interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type StepSource = "uia" | "som" | "vlm" | "none";

export interface ResolvedStep extends Step {
  rect_px: RectPx | null;
  source: StepSource;
}

export type BrainKind =
  | "agent_mcp"
  | "agent_cli"
  | "local_vlm"
  | "byo_api"
  | "groq_pro";

export type BrainMode = "auto" | BrainKind;

export type ApiProvider =
  | "gemini"
  | "openai"
  | "anthropic"
  | "groq"
  | "openrouter"
  | "deepseek"
  | "custom_openai";

export type AgentId =
  | "claude"
  | "codex"
  | "gemini"
  | "agy"
  | "hermes"
  | "copilot"
  | "opencode"
  | "custom";

export type KnownCompanionId =
  | "pixel_cat"
  | "tech_nerd"
  | "anime_guide"
  | "minimal_orb"
  | "none";

export type CompanionId = KnownCompanionId | (string & {});

export type SttEngine = "web_speech" | "whisper_cpp" | "cloud";

export type TinyVocaVoice = "M2" | "F2";

export type SettingsTab =
  | "overview"
  | "brains"
  | "voice"
  | "diary"
  | "graph"
  | "companions"
  | "account"
  | "privacy"
  | "history";

export interface MonitorInfo {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export interface LatencyBreakdown {
  capture_ms: number;
  grounding_ms: number;
  memory_ms: number;
  llm_ms: number;
  total_ms: number;
}

export interface LatencyStats {
  recent: LatencyBreakdown[];
  average: LatencyBreakdown | null;
  count: number;
}

export interface AskResponse {
  session_id: string;
  brain: BrainKind;
  plan: StepPlan;
  resolved_steps: ResolvedStep[];
  capture_path: string | null;
  monitor: MonitorInfo | null;
  latency?: LatencyBreakdown | null;
}

export type GroundedElementSource = "uia" | "taskbar" | "ocr" | "vision";

export interface GroundedElement {
  id: number;
  label: string;
  control_type: string;
  rect_px: RectPx;
  norm_bbox: BBox;
  source: GroundedElementSource;
  is_taskbar: boolean;
}

export interface GroundingSnapshot {
  monitor: MonitorInfo;
  active_app: string;
  window_title: string;
  hwnd: number;
  dhash64: string;
  elements: GroundedElement[];
  element_table_prompt: string;
  capture_ms: number;
  grounding_ms: number;
}

export type LiveSessionStatus =
  | "idle"
  | "listening"
  | "observing"
  | "guiding"
  | "waiting_settle"
  | "paused"
  | "completed";

export interface LiveSessionTurn {
  turn_number: number;
  user_text: string | null;
  instruction_line: string;
  spoken_text: string | null;
  action_kind: string | null;
  companion_emotion: string | null;
  target_name: string | null;
  rect_px: RectPx | null;
  active_app: string;
  window_title: string;
  latency: LatencyBreakdown | null;
  timestamp: number;
}

export interface LiveSessionState {
  session_id: string | null;
  status: LiveSessionStatus;
  goal: string;
  companion_id: CompanionId;
  current_step: ResolvedStep | null;
  current_monitor: MonitorInfo | null;
  turn_count: number;
  turns: LiveSessionTurn[];
  graph_md_path: string | null;
  started_at: number | null;
}

export interface OverlayCompanionPayload {
  mode: string;
  companion_id: CompanionId;
  emotion: string;
  wander: boolean;
  x: number | null;
  y: number | null;
  bubble_text: string | null;
  screenday_recording: boolean;
}

export interface KgNodeDto {
  id: string;
  node_type: string;
  app_exe: string;
  label: string;
  metadata_json: string | null;
  hit_count: number;
  updated_at: number;
}

export interface KgEdgeDto {
  id: string;
  from_node: string;
  to_node: string;
  relation: string;
  intent: string;
  control_name: string | null;
  control_type: string | null;
  shortcut: string | null;
  norm_bbox: BBox | null;
  success_count: number;
  updated_at: number;
}

export interface SessionGraphSummaryDto {
  session_id: string;
  day_key: string;
  active_app: string;
  goal: string;
  graph_md_path: string;
  node_count: number;
  edge_count: number;
  completed: boolean;
  created_at: number;
}

export interface KnowledgeGraphDto {
  nodes: KgNodeDto[];
  edges: KgEdgeDto[];
  sessions: SessionGraphSummaryDto[];
  master_md_path: string | null;
}

export interface ScreenDayFrameDto {
  id: string;
  day_key: string;
  captured_at: number;
  image_path: string;
  active_app: string;
  window_title: string;
  project_name: string | null;
  meeting_name: string | null;
  ocr_excerpt: string | null;
  dhash: string;
  file_bytes: number;
}

export interface ScreenDayProjectGroup {
  name: string;
  frame_count: number;
  apps: string[];
}

export interface ScreenDayMeetingGroup {
  name: string;
  started_at: number;
  ended_at: number;
  frame_count: number;
  screen_topics: string[];
}

export interface ScreenDaySummaryDto {
  day_key: string;
  folder_path: string;
  frame_count: number;
  total_bytes: number;
  session_count: number;
  projects: string[];
  meetings: string[];
  summary_md: string | null;
  graph_md_path: string | null;
  updated_at: number;
}

export interface ScreenDayDetailDto {
  summary: ScreenDaySummaryDto;
  frames: ScreenDayFrameDto[];
  project_groups: ScreenDayProjectGroup[];
  meeting_groups: ScreenDayMeetingGroup[];
  sessions: SessionGraphSummaryDto[];
  day_graph_md: string | null;
  day_diary_md: string | null;
}

export interface ScreenDayStatusDto {
  enabled: boolean;
  interval_sec: number;
  today_key: string;
  today_frames: number;
  today_bytes: number;
  last_captured_at: number | null;
  current_project: string | null;
  current_meeting: string | null;
  skipped_private: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  brain: string;
  provider: string | null;
  model: string | null;
  latency_ms: number;
  message: string;
}

export type AskErrorCode =
  | "timeout"
  | "rate_limited"
  | "quota"
  | "not_pro"
  | "unauthenticated"
  | "unavailable"
  | "invalid_response"
  | "unknown";

export interface AskError {
  code: AskErrorCode;
  brain?: BrainKind;
  message: string;
  fallbacks: BrainKind[];
}

export interface StepChangedPayload {
  step: ResolvedStep;
  /** 0-based step index */
  index: number;
  total: number;
  magnify?: boolean;
  high_contrast?: boolean;
  capture_path?: string | null;
  image_base64?: string | null;
  monitor?: MonitorInfo | null;
  mode?: StepMode;
}

export type BrainStatusState =
  | "idle"
  | "capturing"
  | "thinking"
  | "locating"
  | "done"
  | "error";

export interface BrainStatusPayload {
  state: BrainStatusState;
  brain?: BrainKind | string;
  message?: string;
}

export interface OllamaPullProgressPayload {
  model: string;
  pct: number;
  status?: string;
}

export interface Settings {
  brain_mode: BrainMode;
  brain_priority: BrainKind[];
  byo_provider: ApiProvider | null;
  byo_model: string | null;
  agent_id: AgentId | null;
  ollama_model: string;
  stt_engine: SttEngine;
  voice_enabled: boolean;
  tts_enabled: boolean;
  tts_voice: TinyVocaVoice;
  tts_speed: number;
  tts_pitch_shift: number;
  tts_auto_speak: boolean;
  voice_conversation_mode: boolean;
  high_contrast: boolean;
  always_magnify: boolean;
  capture_retention_days: number;
  onboarding_complete: boolean;
  bar_position: { x: number; y: number } | null;
  cloud_url?: string;
  companion_id: CompanionId;
  companion_wander: boolean;
  screenday_enabled: boolean;
  screenday_interval_sec: number;
  screenday_excluded_apps: string[];
  screenday_skip_private: boolean;
  custom_api_base_url: string | null;
  custom_agent_cmd: string | null;
  summary_brain_mode: BrainMode | null;
  summary_byo_provider: ApiProvider | null;
  summary_byo_model: string | null;
}

export interface OllamaStatus {
  running: boolean;
  models: string[];
  install_url: string;
}

export interface DetectedAgent {
  id: AgentId;
  installed: boolean;
  path: string | null;
}

export type SubscriptionTier = "free" | "pro_monthly" | "pro_annual";

export interface AuthStatus {
  logged_in: boolean;
  email: string | null;
  tier: SubscriptionTier;
  status: string;
  usage: number;
  limit: number;
}

export interface HistorySession {
  id: string;
  active_app: string;
  user_query: string;
  brain_used: BrainKind;
  created_at: number;
  step_count?: number;
}

export interface HistoryStep {
  id?: string;
  session_id?: string;
  step_number: number;
  instruction_line: string;
  bbox: BBox | null;
  bbox_json?: string | null;
  terminal_command: string | null;
  screenshot_path: string | null;
  completed: boolean | number;
}

export interface HistoryDetail {
  session: HistorySession;
  steps: HistoryStep[];
}

export const DEFAULT_SETTINGS: Settings = {
  brain_mode: "auto",
  brain_priority: ["agent_cli", "byo_api", "groq_pro", "local_vlm"],
  byo_provider: "groq",
  byo_model: null,
  agent_id: "claude",
  ollama_model: "qwen2.5vl:3b",
  stt_engine: "web_speech",
  voice_enabled: false,
  tts_enabled: true,
  tts_voice: "M2",
  tts_speed: 1.0,
  tts_pitch_shift: 0.0,
  tts_auto_speak: true,
  voice_conversation_mode: true,
  high_contrast: false,
  always_magnify: false,
  capture_retention_days: 7,
  onboarding_complete: false,
  bar_position: null,
  companion_id: "pixel_cat",
  companion_wander: true,
  screenday_enabled: false,
  screenday_interval_sec: 15,
  screenday_excluded_apps: [],
  screenday_skip_private: true,
  custom_api_base_url: null,
  custom_agent_cmd: null,
  summary_brain_mode: null,
  summary_byo_provider: null,
  summary_byo_model: null,
};

export const API_PROVIDER_LABELS: Record<ApiProvider, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  custom_openai: "Custom OpenAI",
};

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini CLI",
  agy: "Antigravity",
  hermes: "Hermes",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  custom: "Custom CLI",
};

export const COMPANION_LABELS: Record<KnownCompanionId, string> = {
  pixel_cat: "Mochi — Pixel Cat",
  tech_nerd: "Byte — Tech Nerd",
  anime_guide: "Sora — Anime Spirit",
  minimal_orb: "Flow — Minimal Orb",
  none: "Hidden",
};

export const BRAIN_LABELS: Record<BrainKind, string> = {
  local_vlm: "Local",
  byo_api: "BYO API",
  groq_pro: "Groq Pro",
  agent_cli: "Agent CLI",
  agent_mcp: "Agent MCP",
};

export const OLLAMA_MODELS = [
  {
    id: "qwen2.5vl:3b",
    label: "Qwen 2.5 VL 3B (Recommended Default — ~2.5 GB)",
  },
  {
    id: "qwen2.5vl:7b",
    label: "Qwen 2.5 VL 7B (Higher Accuracy — ~5.2 GB)",
  },
  {
    id: "llama3.2-vision",
    label: "Llama 3.2 Vision 11B (~7.8 GB)",
  },
] as const;

export const MAX_INSTRUCTION_LENGTH = 140;

/**
 * Ensures instruction lines never exceed 140 characters per decisions.md §3.
 */
export function clampInstruction(text: string | null | undefined): string {
  if (!text) return "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_INSTRUCTION_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_INSTRUCTION_LENGTH - 1).trimEnd() + "…";
}

/**
 * Formats the compact brain mode pill label per product_design.md §3.A:
 * (Local | BYO: <provider> | Groq Pro | Agent: <name>)
 */
export function formatBrainPillLabel(
  settings: Pick<Settings, "brain_mode" | "byo_provider" | "agent_id">,
  activeBrain?: BrainKind | null,
): string {
  const effective: BrainMode = activeBrain ?? settings.brain_mode;
  switch (effective) {
    case "local_vlm":
      return "Local";
    case "byo_api": {
      const prov = settings.byo_provider
        ? API_PROVIDER_LABELS[settings.byo_provider]
        : "Key";
      return `BYO: ${prov}`;
    }
    case "groq_pro":
      return "Groq Pro";
    case "agent_cli":
    case "agent_mcp": {
      const agent = settings.agent_id
        ? AGENT_LABELS[settings.agent_id]
        : "Claude";
      return `Agent: ${agent}`;
    }
    case "auto":
    default:
      return "Auto";
  }
}
