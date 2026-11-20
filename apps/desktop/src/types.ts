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

export type StepSource = "uia" | "vlm" | "none";

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
  | "openrouter";

export type AgentId = "claude" | "codex" | "gemini" | "agy" | "hermes";

export type SttEngine = "web_speech" | "whisper_cpp" | "cloud";

export interface MonitorInfo {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export interface AskResponse {
  session_id: string;
  brain: BrainKind;
  plan: StepPlan;
  resolved_steps: ResolvedStep[];
  capture_path: string | null;
  monitor: MonitorInfo | null;
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
  high_contrast: boolean;
  always_magnify: boolean;
  capture_retention_days: number;
  onboarding_complete: boolean;
  bar_position: { x: number; y: number } | null;
  cloud_url?: string;
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
  high_contrast: false,
  always_magnify: false,
  capture_retention_days: 7,
  onboarding_complete: false,
  bar_position: null,
};

export const API_PROVIDER_LABELS: Record<ApiProvider, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  openrouter: "OpenRouter",
};

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini CLI",
  agy: "Antigravity",
  hermes: "Hermes",
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
