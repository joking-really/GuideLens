import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  type AgentId,
  type ApiProvider,
  type AskError,
  type AskErrorCode,
  type AskResponse,
  type AuthStatus,
  type BBox,
  type BrainKind,
  type BrainMode,
  type BrainStatusPayload,
  clampInstruction,
  type CompanionId,
  type CompiledPlaybookDto,
  type ConnectionTestResult,
  DEFAULT_SETTINGS,
  type DefaultOptionsResponse,
  type DetectedAgent,
  type HistoryDetail,
  type HistorySession,
  type HistoryStep,
  type KgEdgeDto,
  type KgNodeDto,
  type KnowledgeGraphDto,
  type LatencyBreakdown,
  type LatencyStats,
  type LearningStatsDto,
  type LiveSessionState,
  type LiveSessionStatus,
  type LiveSessionTurn,
  type MonitorInfo,
  type OllamaPullProgressPayload,
  type OllamaStatus,
  type OverlayCompanionPayload,
  type PlaybookStepDto,
  type RectPx,
  type ResolvedStep,
  type ScreenDayDetailDto,
  type ScreenDayFrameDto,
  type ScreenDayMeetingGroup,
  type ScreenDayProjectGroup,
  type ScreenDayStatusDto,
  type ScreenDaySummaryDto,
  type SessionGraphSummaryDto,
  type Settings,
  type SettingsTab,
  type Step,
  type StepChangedPayload,
  type StepMode,
  type StepPlan,
  type SttEngine,
  type TinyVocaVoice,
} from "../types";
import { normalizedToPhysical } from "./overlayGeometry";

const BAR_POS_STORAGE_KEY = "guidelens.bar_position";

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function normalizeBBox(raw: unknown): BBox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  return [
    Number(raw[0]) || 0,
    Number(raw[1]) || 0,
    Number(raw[2]) || 0,
    Number(raw[3]) || 0,
  ];
}

function normalizeMonitor(raw: unknown): MonitorInfo | null {
  if (!isRecord(raw)) return null;
  return {
    x: Number(raw.x) || 0,
    y: Number(raw.y) || 0,
    w: Number(raw.w ?? raw.width) || 1920,
    h: Number(raw.h ?? raw.height) || 1080,
    scale: Number(raw.scale) || 1,
  };
}

function normalizeRectPx(raw: unknown): RectPx | null {
  if (!isRecord(raw)) return null;
  return {
    x: Number(raw.x) || 0,
    y: Number(raw.y) || 0,
    w: Number(raw.w ?? raw.width) || 0,
    h: Number(raw.h ?? raw.height) || 0,
  };
}

function normalizeLatency(raw: unknown): LatencyBreakdown | null {
  if (!isRecord(raw)) return null;
  return {
    capture_ms: Math.max(0, Number(raw.capture_ms) || 0),
    grounding_ms: Math.max(0, Number(raw.grounding_ms) || 0),
    memory_ms: Math.max(0, Number(raw.memory_ms) || 0),
    llm_ms: Math.max(0, Number(raw.llm_ms) || 0),
    total_ms: Math.max(0, Number(raw.total_ms) || 0),
  };
}

function normalizeStep(raw: unknown, idx: number): Step {
  const obj = isRecord(raw) ? raw : {};
  const stepNumber =
    typeof obj.step_number === "number" ? obj.step_number : idx + 1;
  const instructionLine = clampInstruction(
    typeof obj.instruction_line === "string"
      ? obj.instruction_line
      : typeof obj.instruction === "string"
        ? obj.instruction
        : "",
  );
  const bbox = normalizeBBox(obj.bbox);

  return {
    step_number: stepNumber,
    instruction_line: instructionLine,
    target_name:
      typeof obj.target_name === "string" ? obj.target_name : null,
    control_type:
      typeof obj.control_type === "string" ? obj.control_type : null,
    bbox,
    confidence:
      typeof obj.confidence === "number"
        ? Math.max(0, Math.min(1, obj.confidence))
        : bbox
          ? 0.8
          : 0,
    shortcut: typeof obj.shortcut === "string" ? obj.shortcut : null,
    terminal_command:
      typeof obj.terminal_command === "string" ? obj.terminal_command : null,
    explanation:
      typeof obj.explanation === "string"
        ? clampInstruction(obj.explanation)
        : null,
    spoken_text:
      typeof obj.spoken_text === "string" && obj.spoken_text.trim().length > 0
        ? clampInstruction(obj.spoken_text)
        : null,
    target_id: typeof obj.target_id === "number" ? obj.target_id : null,
    action_kind: typeof obj.action_kind === "string" ? obj.action_kind : null,
    companion_emotion:
      typeof obj.companion_emotion === "string" ? obj.companion_emotion : null,
    goal_complete: Boolean(obj.goal_complete),
  };
}

function normalizeResolvedStep(
  raw: unknown,
  idx: number,
  monitor?: MonitorInfo | null,
): ResolvedStep {
  const base = normalizeStep(raw, idx);
  const obj = isRecord(raw) ? raw : {};
  const rawSource = obj.source;
  let rectPx = normalizeRectPx(obj.rect_px);

  if (!rectPx && base.bbox && (base.confidence >= 0.5 || rawSource === "uia" || rawSource === "som")) {
    const mon = monitor ?? { x: 0, y: 0, w: 1920, h: 1080, scale: 1 };
    rectPx = normalizedToPhysical(base.bbox, mon);
  }

  const source: ResolvedStep["source"] =
    rawSource === "uia" ||
    rawSource === "som" ||
    rawSource === "vlm" ||
    rawSource === "none"
      ? rawSource
      : rectPx
        ? "vlm"
        : "none";

  return {
    ...base,
    rect_px: rectPx,
    source,
  };
}

export function normalizeAskResponse(raw: unknown): AskResponse {
  const obj = isRecord(raw) ? raw : {};
  const monitor = normalizeMonitor(obj.monitor);

  const planObj = isRecord(obj.plan) ? obj.plan : obj;
  const rawMode = planObj.mode;
  const mode: StepMode =
    rawMode === "guide" || rawMode === "explain" || rawMode === "terminal"
      ? rawMode
      : "guide";

  const rawSteps = Array.isArray(planObj.steps) ? planObj.steps : [];
  const steps: Step[] = rawSteps.map((s, i) => normalizeStep(s, i));

  const rawResolved = Array.isArray(obj.resolved_steps)
    ? obj.resolved_steps
    : rawSteps;
  const resolvedSteps: ResolvedStep[] = rawResolved.map((s, i) =>
    normalizeResolvedStep(s, i, monitor),
  );

  const totalSteps =
    typeof planObj.total_steps === "number" && planObj.total_steps > 0
      ? planObj.total_steps
      : Math.max(steps.length, resolvedSteps.length, 1);

  const plan: StepPlan = {
    mode,
    total_steps: totalSteps,
    steps:
      steps.length > 0
        ? steps
        : resolvedSteps.map(
            ({ rect_px: _r, source: _s, ...stepFields }) => stepFields,
          ),
  };

  const rawBrain = obj.brain;
  const brain: BrainKind =
    rawBrain === "agent_mcp" ||
    rawBrain === "agent_cli" ||
    rawBrain === "local_vlm" ||
    rawBrain === "byo_api" ||
    rawBrain === "groq_pro"
      ? rawBrain
      : "local_vlm";

  return {
    session_id:
      typeof obj.session_id === "string" ? obj.session_id : "session-local",
    brain,
    plan,
    resolved_steps: resolvedSteps,
    capture_path:
      typeof obj.capture_path === "string"
        ? obj.capture_path
        : typeof obj.screenshot_path === "string"
          ? obj.screenshot_path
          : null,
    monitor,
    latency: normalizeLatency(obj.latency),
    resolution_tier:
      typeof obj.resolution_tier === "string" ? obj.resolution_tier : null,
    tokens_saved:
      typeof obj.tokens_saved === "number" && Number.isFinite(obj.tokens_saved)
        ? Math.max(0, Math.round(obj.tokens_saved))
        : null,
    playbook_id:
      typeof obj.playbook_id === "string" && obj.playbook_id.trim().length > 0
        ? obj.playbook_id
        : null,
  };
}

export function parseAskError(err: unknown): AskError {
  if (isRecord(err) && typeof err.message === "string" && Array.isArray(err.fallbacks)) {
    return {
      code: (err.code as AskErrorCode) || "unknown",
      brain: err.brain as BrainKind | undefined,
      message: err.message,
      fallbacks: err.fallbacks as BrainKind[],
    };
  }

  let rawText = "";
  if (typeof err === "string") {
    rawText = err;
  } else if (err instanceof Error) {
    rawText = err.message;
  } else if (isRecord(err) && typeof err.message === "string") {
    rawText = err.message;
  } else {
    rawText = String(err ?? "Unknown error");
  }

  try {
    const parsed = JSON.parse(rawText);
    if (isRecord(parsed)) {
      const fallbacks: BrainKind[] = Array.isArray(parsed.fallbacks)
        ? (parsed.fallbacks as BrainKind[])
        : ["local_vlm", "agent_cli"];
      return {
        code: (parsed.code as AskErrorCode) || "unknown",
        brain: parsed.brain as BrainKind | undefined,
        message:
          typeof parsed.message === "string"
            ? parsed.message
            : "Request failed",
        fallbacks,
      };
    }
  } catch {
    // Plain string error; infer code and fallbacks below
  }

  const lower = rawText.toLowerCase();
  let code: AskErrorCode = "unknown";
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("504")) {
    code = "timeout";
  } else if (lower.includes("429") || lower.includes("rate limit")) {
    code = "rate_limited";
  } else if (lower.includes("quota")) {
    code = "quota";
  } else if (lower.includes("402") || lower.includes("pro") || lower.includes("subscription")) {
    code = "not_pro";
  } else if (lower.includes("401") || lower.includes("auth") || lower.includes("login")) {
    code = "unauthenticated";
  } else if (lower.includes("ollama") || lower.includes("unavailable")) {
    code = "unavailable";
  }

  const inferredBrain: BrainKind | undefined = lower.includes("groq")
    ? "groq_pro"
    : lower.includes("ollama")
      ? "local_vlm"
      : undefined;

  return {
    code,
    brain: inferredBrain,
    message: rawText || "Unable to reach active brain",
    fallbacks: ["local_vlm", "agent_cli"],
  };
}

// ============================================================================
// Tauri IPC Commands (decisions.md §4)
// ============================================================================

export async function ask(
  query: string,
  brainOverride?: BrainKind,
  forceAi?: boolean,
): Promise<AskResponse> {
  try {
    const payload: Record<string, unknown> = {
      query,
      brain: brainOverride ?? null,
      brainOverride: brainOverride ?? null,
      brain_override: brainOverride ?? null,
    };
    if (forceAi !== undefined) {
      payload.forceAi = forceAi;
      payload.force_ai = forceAi;
    }
    const res = await invoke<unknown>("ask", payload);
    return normalizeAskResponse(res);
  } catch (err) {
    throw parseAskError(err);
  }
}

export async function nextStep(): Promise<ResolvedStep | null> {
  const res = await invoke<unknown>("next_step");
  if (!res) return null;
  return normalizeResolvedStep(res, 0);
}

export async function clearOverlay(): Promise<void> {
  await invoke("clear_overlay");
}

export async function toggleMagnify(on: boolean): Promise<void> {
  await invoke("toggle_magnify", { on, enabled: on, magnify: on });
}

function normalizeTtsVoice(value: unknown): TinyVocaVoice {
  return value === "F2" || value === "M2" ? value : DEFAULT_SETTINGS.tts_voice;
}

function normalizeSettings(
  raw: unknown,
  fallbackPos: { x: number; y: number } | null = null,
): Settings {
  const obj = isRecord(raw) ? raw : {};
  const barPos = isRecord(obj.bar_position)
    ? {
        x: Number(obj.bar_position.x) || 0,
        y: Number(obj.bar_position.y) || 0,
      }
    : fallbackPos;

  return {
    ...DEFAULT_SETTINGS,
    ...(obj as Partial<Settings>),
    tts_enabled:
      typeof obj.tts_enabled === "boolean"
        ? obj.tts_enabled
        : DEFAULT_SETTINGS.tts_enabled,
    tts_voice: normalizeTtsVoice(obj.tts_voice),
    tts_speed:
      typeof obj.tts_speed === "number" && Number.isFinite(obj.tts_speed)
        ? obj.tts_speed
        : DEFAULT_SETTINGS.tts_speed,
    tts_pitch_shift:
      typeof obj.tts_pitch_shift === "number" &&
      Number.isFinite(obj.tts_pitch_shift)
        ? obj.tts_pitch_shift
        : DEFAULT_SETTINGS.tts_pitch_shift,
    tts_auto_speak:
      typeof obj.tts_auto_speak === "boolean"
        ? obj.tts_auto_speak
        : DEFAULT_SETTINGS.tts_auto_speak,
    voice_conversation_mode:
      typeof obj.voice_conversation_mode === "boolean"
        ? obj.voice_conversation_mode
        : DEFAULT_SETTINGS.voice_conversation_mode,
    companion_id:
      typeof obj.companion_id === "string" && obj.companion_id.trim().length > 0
        ? (obj.companion_id as CompanionId)
        : DEFAULT_SETTINGS.companion_id,
    companion_wander:
      typeof obj.companion_wander === "boolean"
        ? obj.companion_wander
        : DEFAULT_SETTINGS.companion_wander,
    screenday_enabled:
      typeof obj.screenday_enabled === "boolean"
        ? obj.screenday_enabled
        : DEFAULT_SETTINGS.screenday_enabled,
    screenday_interval_sec:
      typeof obj.screenday_interval_sec === "number" &&
      Number.isFinite(obj.screenday_interval_sec) &&
      obj.screenday_interval_sec > 0
        ? Math.round(obj.screenday_interval_sec)
        : DEFAULT_SETTINGS.screenday_interval_sec,
    screenday_excluded_apps: Array.isArray(obj.screenday_excluded_apps)
      ? obj.screenday_excluded_apps.map((a) => String(a))
      : DEFAULT_SETTINGS.screenday_excluded_apps,
    screenday_skip_private:
      typeof obj.screenday_skip_private === "boolean"
        ? obj.screenday_skip_private
        : DEFAULT_SETTINGS.screenday_skip_private,
    custom_api_base_url:
      typeof obj.custom_api_base_url === "string"
        ? obj.custom_api_base_url
        : DEFAULT_SETTINGS.custom_api_base_url,
    custom_agent_cmd:
      typeof obj.custom_agent_cmd === "string"
        ? obj.custom_agent_cmd
        : DEFAULT_SETTINGS.custom_agent_cmd,
    summary_brain_mode:
      typeof obj.summary_brain_mode === "string"
        ? (obj.summary_brain_mode as BrainMode)
        : DEFAULT_SETTINGS.summary_brain_mode,
    summary_byo_provider:
      typeof obj.summary_byo_provider === "string"
        ? (obj.summary_byo_provider as ApiProvider)
        : DEFAULT_SETTINGS.summary_byo_provider,
    summary_byo_model:
      typeof obj.summary_byo_model === "string"
        ? obj.summary_byo_model
        : DEFAULT_SETTINGS.summary_byo_model,
    bar_position: barPos,
    bar_opacity:
      typeof obj.bar_opacity === "number" && Number.isFinite(obj.bar_opacity)
        ? Math.min(0.85, Math.max(0.12, obj.bar_opacity))
        : DEFAULT_SETTINGS.bar_opacity,
    bar_blur_enabled:
      typeof obj.bar_blur_enabled === "boolean"
        ? obj.bar_blur_enabled
        : DEFAULT_SETTINGS.bar_blur_enabled,
  };
}

export async function getSettings(): Promise<Settings> {
  const savedPos = readSavedBarPosition();
  try {
    const raw = await invoke<Partial<Settings>>("get_settings");
    return normalizeSettings(raw, savedPos);
  } catch {
    return normalizeSettings(null, savedPos);
  }
}

export async function setSettings(settings: Settings): Promise<void> {
  if (settings.bar_position) {
    writeSavedBarPosition(settings.bar_position);
  }
  await invoke("set_settings", {
    s: settings,
    settings,
  });
}

export async function setApiKey(
  provider: ApiProvider,
  key: string,
): Promise<void> {
  await invoke("set_api_key", {
    provider,
    key,
    apiKey: key,
    api_key: key,
  });
}

export async function deleteApiKey(provider: ApiProvider): Promise<void> {
  await invoke("delete_api_key", { provider });
}

export async function listApiKeyProviders(): Promise<ApiProvider[]> {
  const raw = await invoke<unknown>("list_api_key_providers");
  if (!Array.isArray(raw)) return [];
  const validProviders: ApiProvider[] = [
    "gemini",
    "openai",
    "anthropic",
    "groq",
    "openrouter",
    "deepseek",
    "custom_openai",
  ];
  const result: ApiProvider[] = [];
  for (const item of raw) {
    if (typeof item === "string" && validProviders.includes(item as ApiProvider)) {
      result.push(item as ApiProvider);
    } else if (
      isRecord(item) &&
      typeof item.provider === "string" &&
      item.configured !== false &&
      validProviders.includes(item.provider as ApiProvider)
    ) {
      result.push(item.provider as ApiProvider);
    }
  }
  return result;
}

export async function ollamaStatus(): Promise<OllamaStatus> {
  const raw = await invoke<unknown>("ollama_status");
  if (isRecord(raw)) {
    return {
      running: Boolean(raw.running),
      models: Array.isArray(raw.models)
        ? raw.models.map((m) => String(m))
        : [],
      install_url:
        typeof raw.install_url === "string"
          ? raw.install_url
          : "https://ollama.com/download",
    };
  }
  return {
    running: false,
    models: [],
    install_url: "https://ollama.com/download",
  };
}

export async function ollamaPull(model: string): Promise<void> {
  await invoke("ollama_pull", { model });
}

export async function detectAgents(): Promise<DetectedAgent[]> {
  const raw = await invoke<unknown>("detect_agents");
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((item) => ({
      id: (item.id as AgentId) || "claude",
      installed: Boolean(item.installed),
      path: typeof item.path === "string" ? item.path : null,
    }));
}

export async function historyList(limit = 50): Promise<HistorySession[]> {
  const raw = await invoke<unknown>("history_list", { limit });
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((row) => ({
    id: String(row.id ?? ""),
    active_app: String(row.active_app ?? "Unknown"),
    user_query: String(row.user_query ?? ""),
    brain_used: (row.brain_used as BrainKind) || "local_vlm",
    created_at: Number(row.created_at) || Math.floor(Date.now() / 1000),
    step_count:
      typeof row.step_count === "number" ? row.step_count : undefined,
  }));
}

export async function historyGet(sessionId: string): Promise<HistoryDetail> {
  const raw = await invoke<unknown>("history_get", {
    sessionId,
    session_id: sessionId,
    id: sessionId,
  });
  const obj = isRecord(raw) ? raw : {};
  const sessionObj = isRecord(obj.session) ? obj.session : obj;
  const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];

  const steps: HistoryStep[] = rawSteps.filter(isRecord).map((s, idx) => {
    let bbox: HistoryStep["bbox"] = null;
    if (Array.isArray(s.bbox) && s.bbox.length === 4) {
      bbox = [
        Number(s.bbox[0]) || 0,
        Number(s.bbox[1]) || 0,
        Number(s.bbox[2]) || 0,
        Number(s.bbox[3]) || 0,
      ];
    } else if (typeof s.bbox_json === "string" && s.bbox_json.trim()) {
      try {
        const parsed = JSON.parse(s.bbox_json);
        if (Array.isArray(parsed) && parsed.length === 4) {
          bbox = [
            Number(parsed[0]) || 0,
            Number(parsed[1]) || 0,
            Number(parsed[2]) || 0,
            Number(parsed[3]) || 0,
          ];
        }
      } catch {
        bbox = null;
      }
    }

    return {
      id: typeof s.id === "string" ? s.id : undefined,
      session_id: typeof s.session_id === "string" ? s.session_id : sessionId,
      step_number:
        typeof s.step_number === "number" ? s.step_number : idx + 1,
      instruction_line: clampInstruction(String(s.instruction_line ?? "")),
      bbox,
      terminal_command:
        typeof s.terminal_command === "string" ? s.terminal_command : null,
      screenshot_path:
        typeof s.screenshot_path === "string" ? s.screenshot_path : null,
      completed: Boolean(s.completed),
    };
  });

  return {
    session: {
      id: String(sessionObj.id ?? sessionId),
      active_app: String(sessionObj.active_app ?? "Unknown"),
      user_query: String(sessionObj.user_query ?? ""),
      brain_used: (sessionObj.brain_used as BrainKind) || "local_vlm",
      created_at:
        Number(sessionObj.created_at) || Math.floor(Date.now() / 1000),
      step_count: steps.length,
    },
    steps,
  };
}

function normalizeAuthStatus(raw: unknown): AuthStatus {
  const obj = isRecord(raw) ? raw : {};
  const tier =
    obj.tier === "pro_monthly" || obj.tier === "pro_annual"
      ? obj.tier
      : "free";
  return {
    logged_in: Boolean(obj.logged_in),
    email: typeof obj.email === "string" ? obj.email : null,
    tier,
    status: typeof obj.status === "string" ? obj.status : "inactive",
    usage: typeof obj.usage === "number" ? obj.usage : 0,
    limit: typeof obj.limit === "number" ? obj.limit : 1500,
  };
}

export async function authLogin(
  email: string,
  password: string,
): Promise<AuthStatus> {
  const raw = await invoke<unknown>("auth_login", { email, password });
  return normalizeAuthStatus(raw);
}

export async function authLogout(): Promise<void> {
  await invoke("auth_logout");
}

export async function authStatus(): Promise<AuthStatus> {
  try {
    const raw = await invoke<unknown>("auth_status");
    return normalizeAuthStatus(raw);
  } catch {
    return {
      logged_in: false,
      email: null,
      tier: "free",
      status: "inactive",
      usage: 0,
      limit: 1500,
    };
  }
}

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await invoke("copy_to_clipboard", { text });
  } catch {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  }
}

export async function billingCheckout(
  plan: "monthly" | "annual",
): Promise<{ url: string }> {
  const raw = await invoke<unknown>("billing_checkout", {
    plan,
    tier: plan === "annual" ? "pro_annual" : "pro_monthly",
  });
  if (typeof raw === "string") {
    return { url: raw };
  }
  if (isRecord(raw) && typeof raw.url === "string") {
    return { url: raw.url };
  }
  if (isRecord(raw) && typeof raw.checkout_url === "string") {
    return { url: raw.checkout_url };
  }
  throw new Error("Failed to create billing checkout session");
}

export async function transcribeAudio(
  audioBase64: string,
  engine: SttEngine,
): Promise<{ text: string }> {
  const raw = await invoke<unknown>("transcribe", {
    audioBase64,
    audio_base64: audioBase64,
    engine,
  });
  if (typeof raw === "string") {
    return { text: raw };
  }
  if (isRecord(raw) && typeof raw.text === "string") {
    return { text: raw.text };
  }
  return { text: "" };
}

// ============================================================================
// Tauri Events (decisions.md §4)
// ============================================================================

export function onStepChanged(
  handler: (payload: StepChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<unknown>("step-changed", (event) => {
    const raw = isRecord(event.payload) ? event.payload : {};
    const monitor: MonitorInfo | null = isRecord(raw.monitor)
      ? {
          x: Number(raw.monitor.x) || 0,
          y: Number(raw.monitor.y) || 0,
          w: Number(raw.monitor.w ?? raw.monitor.width) || 1920,
          h: Number(raw.monitor.h ?? raw.monitor.height) || 1080,
          scale: Number(raw.monitor.scale) || 1,
        }
      : null;

    const index = typeof raw.index === "number" ? raw.index : 0;
    const total = typeof raw.total === "number" && raw.total > 0 ? raw.total : 1;
    const step = normalizeResolvedStep(raw.step ?? raw, index, monitor);
    if (
      !step.spoken_text &&
      typeof raw.spoken_text === "string" &&
      raw.spoken_text.trim().length > 0
    ) {
      step.spoken_text = clampInstruction(raw.spoken_text);
    }
    const mode: StepMode =
      raw.mode === "terminal" || step.terminal_command
        ? "terminal"
        : raw.mode === "explain"
          ? "explain"
          : "guide";

    handler({
      step,
      index,
      total,
      magnify: typeof raw.magnify === "boolean" ? raw.magnify : undefined,
      high_contrast:
        typeof raw.high_contrast === "boolean" ? raw.high_contrast : undefined,
      capture_path:
        typeof raw.capture_path === "string"
          ? raw.capture_path
          : typeof raw.screenshot_path === "string"
            ? raw.screenshot_path
            : null,
      image_base64:
        typeof raw.image_base64 === "string" ? raw.image_base64 : null,
      monitor,
      mode,
    });
  });
}

export function onOverlayCleared(handler: () => void): Promise<UnlistenFn> {
  return listen("overlay-cleared", () => {
    handler();
  });
}

export function onBrainStatus(
  handler: (payload: BrainStatusPayload) => void,
): Promise<UnlistenFn> {
  return listen<BrainStatusPayload>("brain-status", (event) => {
    if (isRecord(event.payload)) {
      handler({
        state: (event.payload.state as BrainStatusPayload["state"]) || "thinking",
        brain:
          typeof event.payload.brain === "string"
            ? event.payload.brain
            : undefined,
        message:
          typeof event.payload.message === "string"
            ? event.payload.message
            : undefined,
      });
    }
  });
}

export function onOllamaPullProgress(
  handler: (payload: OllamaPullProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<OllamaPullProgressPayload>("ollama-pull-progress", (event) => {
    if (isRecord(event.payload)) {
      handler({
        model: String(event.payload.model ?? "qwen2.5vl:3b"),
        pct: Math.max(0, Math.min(100, Number(event.payload.pct) || 0)),
        status:
          typeof event.payload.status === "string"
            ? event.payload.status
            : undefined,
      });
    }
  });
}

export function onBarSummoned(handler: () => void): Promise<UnlistenFn> {
  return listen("bar-summoned", () => {
    handler();
  });
}

export interface ShortcutActionPayload {
  action: string;
  active: boolean;
  label: string;
}

export interface CursorGazePayload {
  x: number;
  y: number;
}

export async function toggleBarOnly(): Promise<boolean> {
  const raw = await invokeWithFallback<unknown>(
    "toggle_bar_only",
    undefined,
    () => false,
  );
  return Boolean(raw);
}

export function onShortcutAction(
  cb: (payload: ShortcutActionPayload) => void,
): Promise<UnlistenFn> {
  return safeListen<unknown>("shortcut-action", (payload) => {
    const obj = isRecord(payload) ? payload : {};
    cb({
      action: typeof obj.action === "string" ? obj.action : "",
      active: Boolean(obj.active),
      label: typeof obj.label === "string" ? obj.label : "",
    });
  });
}

export function onOverlayCursor(
  cb: (payload: CursorGazePayload) => void,
): Promise<UnlistenFn> {
  return safeListen<unknown>("overlay-cursor", (payload) => {
    if (!isRecord(payload)) return;
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      cb({ x, y });
    }
  });
}

const VALID_SETTINGS_TABS: readonly SettingsTab[] = [
  "overview",
  "brains",
  "voice",
  "diary",
  "graph",
  "companions",
  "account",
  "privacy",
  "history",
];

function parseSettingsTab(value: unknown): SettingsTab | undefined {
  return typeof value === "string" &&
    (VALID_SETTINGS_TABS as readonly string[]).includes(value)
    ? (value as SettingsTab)
    : undefined;
}

export function onSettingsChanged(
  handler: (settings: Settings) => void,
): Promise<UnlistenFn> {
  return listen<Partial<Settings>>("settings-changed", (event) => {
    handler(normalizeSettings(event.payload, readSavedBarPosition()));
  });
}

export function onSettingsRoute(
  handler: (payload: {
    route: "/settings" | "/onboarding";
    tab?: SettingsTab;
  }) => void,
): Promise<UnlistenFn> {
  return listen<{ route?: unknown; tab?: unknown }>(
    "settings-route",
    (event) => {
      const rawPayload = isRecord(event.payload) ? event.payload : {};
      const route =
        rawPayload.route === "/onboarding" ? "/onboarding" : "/settings";
      const tab = parseSettingsTab(rawPayload.tab);
      handler(tab ? { route, tab } : { route });
    },
  );
}

// ============================================================================
// Window & Asset Helpers
// ============================================================================

export function toAssetUrl(pathOrData: string | null | undefined): string | null {
  if (!pathOrData) return null;
  if (
    pathOrData.startsWith("data:") ||
    pathOrData.startsWith("http://") ||
    pathOrData.startsWith("https://") ||
    pathOrData.startsWith("asset:")
  ) {
    return pathOrData;
  }
  try {
    return convertFileSrc(pathOrData);
  } catch {
    return `asset://localhost/${encodeURIComponent(pathOrData)}`;
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!url) return;
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    if (typeof opener.openUrl === "function") {
      await opener.openUrl(url);
      return;
    }
  } catch {
    // Fallback to standard window.open below
  }
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export async function openSettingsWindow(
  route: "/settings" | "/onboarding" = "/settings",
  tab?: SettingsTab,
): Promise<boolean> {
  const validTab = parseSettingsTab(tab);
  const windowUrl = validTab
    ? `${route}?tab=${encodeURIComponent(validTab)}`
    : route;
  const windowTitle =
    route === "/onboarding"
      ? "Welcome to GuideLens"
      : validTab === "voice"
        ? "GuideLens Voice Studio"
        : "GuideLens Control Center";
  try {
    const existing = await WebviewWindow.getByLabel("settings");
    if (existing) {
      try {
        await existing.emit(
          "settings-route",
          validTab ? { route, tab: validTab } : { route },
        );
      } catch {
        // Ignore if event emission is unavailable
      }
      try {
        await existing.setTitle(windowTitle);
      } catch {
        // Ignore if setTitle is denied by capability
      }
      try {
        await existing.unminimize();
      } catch {
        // Ignore if unminimize is unsupported
      }
      await existing.show();
      await existing.setFocus();
      return true;
    }
    const win = new WebviewWindow("settings", {
      url: windowUrl,
      title: windowTitle,
      width: 1120,
      height: 740,
      minWidth: 880,
      minHeight: 600,
      resizable: true,
      center: true,
      decorations: true,
    });
    return await new Promise<boolean>((resolve) => {
      win.once("tauri://created", () => resolve(true));
      win.once("tauri://error", () => resolve(false));
    });
  } catch {
    return false;
  }
}

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export async function getOverlayOrigin(): Promise<{ x: number; y: number }> {
  try {
    const win = getCurrentWindow();
    const pos = await win.innerPosition();
    return { x: pos.x, y: pos.y };
  } catch {
    return { x: 0, y: 0 };
  }
}

export async function onWindowMoved(
  handler: (pos: { x: number; y: number }) => void,
): Promise<UnlistenFn> {
  try {
    const win = getCurrentWindow();
    return await win.onMoved(({ payload }) => {
      handler({ x: payload.x, y: payload.y });
    });
  } catch {
    return () => {};
  }
}

export async function closeCurrentWindow(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.close();
  } catch {
    // No-op outside Tauri webview
  }
}

export async function resizeBarWindow(
  height: number,
  width = 640,
): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.setSize(
      new LogicalSize(
        Math.max(520, Math.round(width)),
        Math.max(54, Math.round(height)),
      ),
    );
  } catch {
    // No-op outside Tauri webview
  }
}

export function readSavedBarPosition(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(BAR_POS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      typeof parsed.x === "number" &&
      typeof parsed.y === "number"
    ) {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

export function writeSavedBarPosition(pos: { x: number; y: number }): void {
  try {
    localStorage.setItem(BAR_POS_STORAGE_KEY, JSON.stringify(pos));
  } catch {
    // Ignore storage errors
  }
}

export async function restoreBarPosition(
  pos: { x: number; y: number } | null,
): Promise<void> {
  const target = pos ?? readSavedBarPosition();
  if (!target) return;
  try {
    const win = getCurrentWindow();
    await win.setPosition(new PhysicalPosition(target.x, target.y));
    await invoke("clamp_bar_position").catch(() => {});
  } catch {
    // Ignore outside Tauri runtime
  }
}

export async function startBarDrag(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.startDragging();
    const pos = await win.outerPosition();
    writeSavedBarPosition({ x: pos.x, y: pos.y });
  } catch {
    // Ignore outside Tauri runtime
  }
}

// ============================================================================
// GuideLens v2 IPC Commands & Events
// ============================================================================

const VALID_LIVE_STATUSES: readonly LiveSessionStatus[] = [
  "idle",
  "listening",
  "observing",
  "guiding",
  "waiting_settle",
  "paused",
  "completed",
];

function todayKeyLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function invokeWithFallback<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  fallback: () => T,
): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    if (!isTauriRuntime()) {
      return fallback();
    }
    throw err;
  }
}

async function safeListen<T>(
  event: string,
  callback: (payload: T) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<T>(event, (ev) => callback(ev.payload));
  } catch {
    return () => {};
  }
}

function defaultLiveSessionState(
  overrides: Partial<LiveSessionState> = {},
): LiveSessionState {
  return {
    session_id: null,
    status: "idle",
    goal: "",
    companion_id: DEFAULT_SETTINGS.companion_id,
    current_step: null,
    current_monitor: null,
    turn_count: 0,
    turns: [],
    graph_md_path: null,
    started_at: null,
    ...overrides,
  };
}

function normalizeLiveSessionTurn(raw: unknown, idx: number): LiveSessionTurn {
  const obj = isRecord(raw) ? raw : {};
  return {
    turn_number:
      typeof obj.turn_number === "number" ? obj.turn_number : idx + 1,
    user_text: typeof obj.user_text === "string" ? obj.user_text : null,
    instruction_line: clampInstruction(
      typeof obj.instruction_line === "string" ? obj.instruction_line : "",
    ),
    spoken_text:
      typeof obj.spoken_text === "string" && obj.spoken_text.trim().length > 0
        ? clampInstruction(obj.spoken_text)
        : null,
    action_kind: typeof obj.action_kind === "string" ? obj.action_kind : null,
    companion_emotion:
      typeof obj.companion_emotion === "string"
        ? obj.companion_emotion
        : null,
    target_name: typeof obj.target_name === "string" ? obj.target_name : null,
    rect_px: normalizeRectPx(obj.rect_px),
    active_app: typeof obj.active_app === "string" ? obj.active_app : "Unknown",
    window_title:
      typeof obj.window_title === "string" ? obj.window_title : "",
    latency: normalizeLatency(obj.latency),
    timestamp:
      typeof obj.timestamp === "number"
        ? obj.timestamp
        : Math.floor(Date.now() / 1000),
  };
}

function normalizeLiveSessionState(raw: unknown): LiveSessionState {
  const obj = isRecord(raw) ? raw : {};
  const rawStatus = obj.status;
  const status: LiveSessionStatus =
    typeof rawStatus === "string" &&
    (VALID_LIVE_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as LiveSessionStatus)
      : "idle";
  const currentMonitor = normalizeMonitor(obj.current_monitor);
  const currentStep = isRecord(obj.current_step)
    ? normalizeResolvedStep(obj.current_step, 0, currentMonitor)
    : null;
  const turns = Array.isArray(obj.turns)
    ? obj.turns.map((t, i) => normalizeLiveSessionTurn(t, i))
    : [];

  return {
    session_id: typeof obj.session_id === "string" ? obj.session_id : null,
    status,
    goal: typeof obj.goal === "string" ? obj.goal : "",
    companion_id:
      typeof obj.companion_id === "string" && obj.companion_id.trim().length > 0
        ? (obj.companion_id as CompanionId)
        : DEFAULT_SETTINGS.companion_id,
    current_step: currentStep,
    current_monitor: currentMonitor,
    turn_count:
      typeof obj.turn_count === "number" ? obj.turn_count : turns.length,
    turns,
    graph_md_path:
      typeof obj.graph_md_path === "string" ? obj.graph_md_path : null,
    started_at: typeof obj.started_at === "number" ? obj.started_at : null,
  };
}

function normalizeOverlayCompanion(raw: unknown): OverlayCompanionPayload {
  const obj = isRecord(raw) ? raw : {};
  return {
    mode: typeof obj.mode === "string" ? obj.mode : "idle",
    companion_id:
      typeof obj.companion_id === "string" && obj.companion_id.trim().length > 0
        ? (obj.companion_id as CompanionId)
        : DEFAULT_SETTINGS.companion_id,
    emotion: typeof obj.emotion === "string" ? obj.emotion : "idle",
    wander:
      typeof obj.wander === "boolean"
        ? obj.wander
        : DEFAULT_SETTINGS.companion_wander,
    x: typeof obj.x === "number" ? obj.x : null,
    y: typeof obj.y === "number" ? obj.y : null,
    bubble_text:
      typeof obj.bubble_text === "string" ? obj.bubble_text : null,
    screenday_recording: Boolean(obj.screenday_recording),
  };
}

function normalizeKgNode(raw: unknown): KgNodeDto {
  const obj = isRecord(raw) ? raw : {};
  return {
    id: String(obj.id ?? ""),
    node_type: String(obj.node_type ?? "control"),
    app_exe: String(obj.app_exe ?? ""),
    label: String(obj.label ?? ""),
    metadata_json:
      typeof obj.metadata_json === "string" ? obj.metadata_json : null,
    hit_count: Number(obj.hit_count) || 0,
    updated_at: Number(obj.updated_at) || 0,
  };
}

function normalizeKgEdge(raw: unknown): KgEdgeDto {
  const obj = isRecord(raw) ? raw : {};
  return {
    id: String(obj.id ?? ""),
    from_node: String(obj.from_node ?? ""),
    to_node: String(obj.to_node ?? ""),
    relation: String(obj.relation ?? "leads_to"),
    intent: String(obj.intent ?? ""),
    control_name:
      typeof obj.control_name === "string" ? obj.control_name : null,
    control_type:
      typeof obj.control_type === "string" ? obj.control_type : null,
    shortcut: typeof obj.shortcut === "string" ? obj.shortcut : null,
    norm_bbox: normalizeBBox(obj.norm_bbox),
    success_count: Number(obj.success_count) || 0,
    updated_at: Number(obj.updated_at) || 0,
  };
}

function normalizeSessionGraphSummary(raw: unknown): SessionGraphSummaryDto {
  const obj = isRecord(raw) ? raw : {};
  return {
    session_id: String(obj.session_id ?? ""),
    day_key: String(obj.day_key ?? todayKeyLocal()),
    active_app: String(obj.active_app ?? "Unknown"),
    goal: String(obj.goal ?? ""),
    graph_md_path: String(obj.graph_md_path ?? ""),
    node_count: Math.max(0, Number(obj.node_count) || 0),
    edge_count: Math.max(0, Number(obj.edge_count) || 0),
    completed: Boolean(obj.completed),
    created_at: Number(obj.created_at) || 0,
  };
}

function normalizeScreenDayFrame(raw: unknown): ScreenDayFrameDto {
  const obj = isRecord(raw) ? raw : {};
  return {
    id: String(obj.id ?? ""),
    day_key: String(obj.day_key ?? todayKeyLocal()),
    captured_at: Number(obj.captured_at) || 0,
    image_path: String(obj.image_path ?? ""),
    active_app: String(obj.active_app ?? "Unknown"),
    window_title: String(obj.window_title ?? ""),
    project_name:
      typeof obj.project_name === "string" ? obj.project_name : null,
    meeting_name:
      typeof obj.meeting_name === "string" ? obj.meeting_name : null,
    ocr_excerpt: typeof obj.ocr_excerpt === "string" ? obj.ocr_excerpt : null,
    dhash: String(obj.dhash ?? ""),
    file_bytes: Math.max(0, Number(obj.file_bytes) || 0),
  };
}

function normalizeScreenDaySummary(raw: unknown): ScreenDaySummaryDto {
  const obj = isRecord(raw) ? raw : {};
  return {
    day_key: String(obj.day_key ?? todayKeyLocal()),
    folder_path: String(obj.folder_path ?? ""),
    frame_count: Math.max(0, Number(obj.frame_count) || 0),
    total_bytes: Math.max(0, Number(obj.total_bytes) || 0),
    session_count: Math.max(0, Number(obj.session_count) || 0),
    projects: Array.isArray(obj.projects)
      ? obj.projects.map((p) => String(p))
      : [],
    meetings: Array.isArray(obj.meetings)
      ? obj.meetings.map((m) => String(m))
      : [],
    summary_md: typeof obj.summary_md === "string" ? obj.summary_md : null,
    graph_md_path:
      typeof obj.graph_md_path === "string" ? obj.graph_md_path : null,
    updated_at: Number(obj.updated_at) || 0,
  };
}

function normalizeScreenDayStatus(
  raw: unknown,
  fallbackEnabled = false,
): ScreenDayStatusDto {
  const obj = isRecord(raw) ? raw : {};
  return {
    enabled:
      typeof obj.enabled === "boolean" ? obj.enabled : fallbackEnabled,
    interval_sec:
      typeof obj.interval_sec === "number" && obj.interval_sec > 0
        ? obj.interval_sec
        : DEFAULT_SETTINGS.screenday_interval_sec,
    today_key:
      typeof obj.today_key === "string" ? obj.today_key : todayKeyLocal(),
    today_frames: Math.max(0, Number(obj.today_frames) || 0),
    today_bytes: Math.max(0, Number(obj.today_bytes) || 0),
    last_captured_at:
      typeof obj.last_captured_at === "number" ? obj.last_captured_at : null,
    current_project:
      typeof obj.current_project === "string" ? obj.current_project : null,
    current_meeting:
      typeof obj.current_meeting === "string" ? obj.current_meeting : null,
    skipped_private: Boolean(obj.skipped_private),
  };
}

function normalizeScreenDayDetail(raw: unknown): ScreenDayDetailDto | null {
  if (!isRecord(raw)) return null;
  const projectGroups: ScreenDayProjectGroup[] = Array.isArray(
    raw.project_groups,
  )
    ? raw.project_groups.filter(isRecord).map((g) => ({
        name: String(g.name ?? ""),
        frame_count: Math.max(0, Number(g.frame_count) || 0),
        apps: Array.isArray(g.apps) ? g.apps.map((a) => String(a)) : [],
      }))
    : [];
  const meetingGroups: ScreenDayMeetingGroup[] = Array.isArray(
    raw.meeting_groups,
  )
    ? raw.meeting_groups.filter(isRecord).map((g) => ({
        name: String(g.name ?? ""),
        started_at: Number(g.started_at) || 0,
        ended_at: Number(g.ended_at) || 0,
        frame_count: Math.max(0, Number(g.frame_count) || 0),
        screen_topics: Array.isArray(g.screen_topics)
          ? g.screen_topics.map((t) => String(t))
          : [],
      }))
    : [];

  return {
    summary: normalizeScreenDaySummary(raw.summary),
    frames: Array.isArray(raw.frames)
      ? raw.frames.map(normalizeScreenDayFrame)
      : [],
    project_groups: projectGroups,
    meeting_groups: meetingGroups,
    sessions: Array.isArray(raw.sessions)
      ? raw.sessions.map(normalizeSessionGraphSummary)
      : [],
    day_graph_md:
      typeof raw.day_graph_md === "string" ? raw.day_graph_md : null,
    day_diary_md:
      typeof raw.day_diary_md === "string" ? raw.day_diary_md : null,
  };
}

export async function startLiveSession(
  goal: string,
  brainOverride?: BrainKind | null,
): Promise<LiveSessionState> {
  const raw = await invokeWithFallback<unknown>(
    "start_live_session",
    {
      goal,
      brain: brainOverride ?? null,
      brainOverride: brainOverride ?? null,
      brain_override: brainOverride ?? null,
    },
    () =>
      defaultLiveSessionState({
        session_id: "browser-live-session",
        status: "guiding",
        goal,
        started_at: Math.floor(Date.now() / 1000),
      }),
  );
  return normalizeLiveSessionState(raw);
}

export async function sendLiveMessage(
  text: string,
  sessionId?: string | null,
): Promise<LiveSessionState> {
  const now = Math.floor(Date.now() / 1000);
  const raw = await invokeWithFallback<unknown>(
    "send_live_message",
    {
      text,
      message: text,
      sessionId: sessionId ?? null,
      session_id: sessionId ?? null,
    },
    () =>
      defaultLiveSessionState({
        session_id: sessionId ?? "browser-live-session",
        status: "guiding",
        goal: text,
        turn_count: 1,
        turns: [
          {
            turn_number: 1,
            user_text: text,
            instruction_line: clampInstruction(text),
            spoken_text: null,
            action_kind: null,
            companion_emotion: "thinking",
            target_name: null,
            rect_px: null,
            active_app: "Browser",
            window_title: "GuideLens Preview",
            latency: null,
            timestamp: now,
          },
        ],
        started_at: now,
      }),
  );
  return normalizeLiveSessionState(raw);
}

export async function endLiveSession(
  sessionId?: string | null,
): Promise<LiveSessionState> {
  const raw = await invokeWithFallback<unknown>(
    "end_live_session",
    {
      sessionId: sessionId ?? null,
      session_id: sessionId ?? null,
    },
    () =>
      defaultLiveSessionState({
        session_id: sessionId ?? null,
        status: "completed",
      }),
  );
  return normalizeLiveSessionState(raw);
}

export async function getLiveSession(): Promise<LiveSessionState> {
  const raw = await invokeWithFallback<unknown>(
    "get_live_session",
    undefined,
    () => defaultLiveSessionState(),
  );
  return normalizeLiveSessionState(raw);
}

export async function pauseLiveSession(
  paused: boolean,
  sessionId?: string | null,
): Promise<LiveSessionState> {
  const raw = await invokeWithFallback<unknown>(
    "pause_live_session",
    {
      paused,
      sessionId: sessionId ?? null,
      session_id: sessionId ?? null,
    },
    () =>
      defaultLiveSessionState({
        session_id: sessionId ?? null,
        status: paused ? "paused" : "guiding",
      }),
  );
  return normalizeLiveSessionState(raw);
}

export function onLiveSessionEvent(
  handler: (state: LiveSessionState) => void,
): Promise<UnlistenFn> {
  return safeListen<unknown>("live-session-event", (payload) => {
    handler(normalizeLiveSessionState(payload));
  });
}

export function onOverlayCompanion(
  handler: (payload: OverlayCompanionPayload) => void,
): Promise<UnlistenFn> {
  return safeListen<unknown>("overlay-companion", (payload) => {
    handler(normalizeOverlayCompanion(payload));
  });
}

export async function previewCompanion(
  companionId: CompanionId,
  emotion = "happy",
  bubbleText?: string | null,
): Promise<void> {
  await invokeWithFallback<void>(
    "preview_companion",
    {
      companionId,
      companion_id: companionId,
      emotion,
      bubbleText: bubbleText ?? null,
      bubble_text: bubbleText ?? null,
    },
    () => undefined,
  );
}

export const emitCompanionPreview = previewCompanion;

export async function getKnowledgeGraph(
  appFilter?: string | null,
): Promise<KnowledgeGraphDto> {
  const raw = await invokeWithFallback<unknown>(
    "get_knowledge_graph",
    {
      appFilter: appFilter ?? null,
      app_filter: appFilter ?? null,
    },
    () => ({
      nodes: [],
      edges: [],
      sessions: [],
      master_md_path: null,
    }),
  );
  const obj = isRecord(raw) ? raw : {};
  return {
    nodes: Array.isArray(obj.nodes) ? obj.nodes.map(normalizeKgNode) : [],
    edges: Array.isArray(obj.edges) ? obj.edges.map(normalizeKgEdge) : [],
    sessions: Array.isArray(obj.sessions)
      ? obj.sessions.map(normalizeSessionGraphSummary)
      : [],
    master_md_path:
      typeof obj.master_md_path === "string" ? obj.master_md_path : null,
  };
}

export async function listSessionGraphs(
  dayKey?: string | null,
  limit = 50,
): Promise<SessionGraphSummaryDto[]> {
  const raw = await invokeWithFallback<unknown>(
    "list_session_graphs",
    {
      dayKey: dayKey ?? null,
      day_key: dayKey ?? null,
      limit,
    },
    () => [],
  );
  return Array.isArray(raw) ? raw.map(normalizeSessionGraphSummary) : [];
}

export async function readGraphMarkdown(path: string): Promise<string> {
  const raw = await invokeWithFallback<unknown>(
    "read_graph_markdown",
    { path },
    () => "",
  );
  return typeof raw === "string" ? raw : "";
}

export async function deleteMemoryNode(nodeId: string): Promise<void> {
  await invokeWithFallback<void>(
    "delete_memory_node",
    {
      nodeId,
      node_id: nodeId,
      id: nodeId,
    },
    () => undefined,
  );
}

export async function screendaySetEnabled(
  enabled: boolean,
): Promise<ScreenDayStatusDto> {
  const raw = await invokeWithFallback<unknown>(
    "screenday_set_enabled",
    { enabled },
    () => normalizeScreenDayStatus(null, enabled),
  );
  return normalizeScreenDayStatus(raw, enabled);
}

export async function screendayStatus(): Promise<ScreenDayStatusDto> {
  const raw = await invokeWithFallback<unknown>(
    "screenday_status",
    undefined,
    () => normalizeScreenDayStatus(null, false),
  );
  return normalizeScreenDayStatus(raw, false);
}

export async function screendayCaptureNow(): Promise<ScreenDayFrameDto | null> {
  const raw = await invokeWithFallback<unknown>(
    "screenday_capture_now",
    undefined,
    () => null,
  );
  return isRecord(raw) ? normalizeScreenDayFrame(raw) : null;
}

export async function screendayListDays(
  limit = 30,
): Promise<ScreenDaySummaryDto[]> {
  const raw = await invokeWithFallback<unknown>(
    "screenday_list_days",
    { limit },
    () => [],
  );
  return Array.isArray(raw) ? raw.map(normalizeScreenDaySummary) : [];
}

export async function screendayGetDay(
  dayKey: string,
): Promise<ScreenDayDetailDto | null> {
  const raw = await invokeWithFallback<unknown>(
    "screenday_get_day",
    {
      dayKey,
      day_key: dayKey,
    },
    () => null,
  );
  return normalizeScreenDayDetail(raw);
}

export async function screendayGenerateSummary(
  dayKey: string,
): Promise<ScreenDayDetailDto | null> {
  const raw = await invokeWithFallback<unknown>(
    "screenday_generate_summary",
    {
      dayKey,
      day_key: dayKey,
    },
    () => null,
  );
  return normalizeScreenDayDetail(raw);
}

export function onScreenDayFrame(
  handler: (frame: ScreenDayFrameDto) => void,
): Promise<UnlistenFn> {
  return safeListen<unknown>("screenday-frame", (payload) => {
    if (isRecord(payload)) {
      handler(normalizeScreenDayFrame(payload));
    }
  });
}

export interface TestBrainConnectionOptions {
  brain: string;
  provider?: ApiProvider | string | null;
  model?: string | null;
  base_url?: string | null;
}

export async function testBrainConnection(
  brainOrOpts: string | TestBrainConnectionOptions,
  provider?: ApiProvider | string | null,
  model?: string | null,
  baseUrl?: string | null,
): Promise<ConnectionTestResult> {
  const opts: TestBrainConnectionOptions =
    typeof brainOrOpts === "string"
      ? {
          brain: brainOrOpts,
          provider: provider ?? null,
          model: model ?? null,
          base_url: baseUrl ?? null,
        }
      : brainOrOpts;

  try {
    const raw = await invoke<unknown>("test_brain_connection", {
      brain: opts.brain,
      provider: opts.provider ?? null,
      model: opts.model ?? null,
      baseUrl: opts.base_url ?? null,
      base_url: opts.base_url ?? null,
    });
    const obj = isRecord(raw) ? raw : {};
    return {
      ok: Boolean(obj.ok),
      brain: typeof obj.brain === "string" ? obj.brain : opts.brain,
      provider:
        typeof obj.provider === "string"
          ? obj.provider
          : (opts.provider ?? null),
      model: typeof obj.model === "string" ? obj.model : (opts.model ?? null),
      latency_ms: Math.max(0, Number(obj.latency_ms) || 0),
      message:
        typeof obj.message === "string"
          ? obj.message
          : Boolean(obj.ok)
            ? "Connection successful"
            : "Connection failed",
    };
  } catch (err) {
    return {
      ok: false,
      brain: opts.brain,
      provider: opts.provider ?? null,
      model: opts.model ?? null,
      latency_ms: 0,
      message:
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Desktop runtime unavailable (browser mode)",
    };
  }
}

function computeAverageLatency(samples: LatencyBreakdown[]): LatencyBreakdown | null {
  if (samples.length === 0) return null;
  const sums = samples.reduce(
    (acc, item) => ({
      capture_ms: acc.capture_ms + item.capture_ms,
      grounding_ms: acc.grounding_ms + item.grounding_ms,
      memory_ms: acc.memory_ms + item.memory_ms,
      llm_ms: acc.llm_ms + item.llm_ms,
      total_ms: acc.total_ms + item.total_ms,
    }),
    { capture_ms: 0, grounding_ms: 0, memory_ms: 0, llm_ms: 0, total_ms: 0 },
  );
  const n = samples.length;
  return {
    capture_ms: Math.round(sums.capture_ms / n),
    grounding_ms: Math.round(sums.grounding_ms / n),
    memory_ms: Math.round(sums.memory_ms / n),
    llm_ms: Math.round(sums.llm_ms / n),
    total_ms: Math.round(sums.total_ms / n),
  };
}

export async function getLatencyStats(limit = 25): Promise<LatencyStats> {
  const raw = await invokeWithFallback<unknown>(
    "get_latency_stats",
    { limit },
    () => ({ recent: [], average: null, count: 0 }),
  );
  if (Array.isArray(raw)) {
    const recent = raw
      .map(normalizeLatency)
      .filter((x): x is LatencyBreakdown => x !== null);
    return {
      recent,
      average: computeAverageLatency(recent),
      count: recent.length,
    };
  }
  const obj = isRecord(raw) ? raw : {};
  const rawList = Array.isArray(obj.recent)
    ? obj.recent
    : Array.isArray(obj.samples)
      ? obj.samples
      : [];
  const recent = rawList
    .map(normalizeLatency)
    .filter((x): x is LatencyBreakdown => x !== null);
  const average = normalizeLatency(obj.average) ?? computeAverageLatency(recent);
  const count =
    typeof obj.count === "number" ? Math.max(0, obj.count) : recent.length;
  return { recent, average, count };
}

// ============================================================================
// GuideLens v2.3 Playbooks & Acrylic Glass Commands
// ============================================================================

function normalizePlaybookStep(raw: unknown, idx: number): PlaybookStepDto {
  const obj = isRecord(raw) ? raw : {};
  return {
    step_number:
      typeof obj.step_number === "number" ? obj.step_number : idx + 1,
    instruction_line: clampInstruction(String(obj.instruction_line ?? "")),
    target_name:
      typeof obj.target_name === "string" ? obj.target_name : null,
    control_type:
      typeof obj.control_type === "string" ? obj.control_type : null,
    shortcut: typeof obj.shortcut === "string" ? obj.shortcut : null,
    terminal_command:
      typeof obj.terminal_command === "string" ? obj.terminal_command : null,
    action_kind:
      typeof obj.action_kind === "string" ? obj.action_kind : null,
    spoken_text:
      typeof obj.spoken_text === "string" ? obj.spoken_text : null,
    norm_bbox: normalizeBBox(obj.norm_bbox),
  };
}

function normalizeCompiledPlaybook(raw: unknown): CompiledPlaybookDto {
  const obj = isRecord(raw) ? raw : {};
  const steps = Array.isArray(obj.steps)
    ? obj.steps.map((s, i) => normalizePlaybookStep(s, i))
    : [];
  return {
    id: String(obj.id ?? ""),
    app_exe: String(obj.app_exe ?? ""),
    view_key: String(obj.view_key ?? ""),
    canonical_goal: String(obj.canonical_goal ?? ""),
    display_label: String(obj.display_label ?? obj.canonical_goal ?? ""),
    confidence_tier:
      typeof obj.confidence_tier === "string"
        ? obj.confidence_tier
        : "inferred",
    confidence_score:
      typeof obj.confidence_score === "number" &&
      Number.isFinite(obj.confidence_score)
        ? obj.confidence_score
        : 0.5,
    success_count: Math.max(0, Number(obj.success_count) || 0),
    failure_count: Math.max(0, Number(obj.failure_count) || 0),
    tokens_saved_est: Math.max(0, Number(obj.tokens_saved_est) || 0),
    steps,
    updated_at: Number(obj.updated_at) || 0,
  };
}

export async function getDefaultOptions(
  appExe?: string | null,
  limit = 4,
): Promise<DefaultOptionsResponse> {
  const raw = await invokeWithFallback<unknown>(
    "get_default_options",
    {
      appExe: appExe ?? null,
      app_exe: appExe ?? null,
      limit,
    },
    () => ({
      active_app: "",
      window_title: "",
      options: [],
      total_tokens_saved: 0,
    }),
  );
  const obj = isRecord(raw) ? raw : {};
  return {
    active_app: typeof obj.active_app === "string" ? obj.active_app : "",
    window_title: typeof obj.window_title === "string" ? obj.window_title : "",
    options: Array.isArray(obj.options)
      ? obj.options.map(normalizeCompiledPlaybook)
      : [],
    total_tokens_saved: Math.max(0, Number(obj.total_tokens_saved) || 0),
  };
}

export async function runPlaybook(
  playbookId: string,
  forceAi = false,
): Promise<AskResponse> {
  try {
    const res = await invoke<unknown>("run_playbook", {
      playbookId,
      playbook_id: playbookId,
      forceAi,
      force_ai: forceAi,
    });
    return normalizeAskResponse(res);
  } catch (err) {
    throw parseAskError(err);
  }
}

export async function reportGuidanceFeedback(
  sessionId: string,
  playbookId: string | null | undefined,
  worked: boolean,
): Promise<void> {
  await invokeWithFallback<void>(
    "report_guidance_feedback",
    {
      sessionId,
      session_id: sessionId,
      playbookId: playbookId ?? null,
      playbook_id: playbookId ?? null,
      worked,
    },
    () => undefined,
  );
}

export async function listCompiledPlaybooks(
  appFilter?: string | null,
): Promise<CompiledPlaybookDto[]> {
  const raw = await invokeWithFallback<unknown>(
    "list_compiled_playbooks",
    {
      appFilter: appFilter ?? null,
      app_filter: appFilter ?? null,
    },
    () => [],
  );
  return Array.isArray(raw) ? raw.map(normalizeCompiledPlaybook) : [];
}

export async function deletePlaybook(playbookId: string): Promise<void> {
  await invokeWithFallback<void>(
    "delete_playbook",
    {
      playbookId,
      playbook_id: playbookId,
    },
    () => undefined,
  );
}

export async function getLearningStats(): Promise<LearningStatsDto> {
  const raw = await invokeWithFallback<unknown>(
    "get_learning_stats",
    undefined,
    () => ({
      total_playbooks: 0,
      verified_playbooks: 0,
      stale_playbooks: 0,
      total_tier0_hits: 0,
      total_tokens_saved: 0,
    }),
  );
  const obj = isRecord(raw) ? raw : {};
  return {
    total_playbooks: Math.max(0, Number(obj.total_playbooks) || 0),
    verified_playbooks: Math.max(0, Number(obj.verified_playbooks) || 0),
    stale_playbooks: Math.max(0, Number(obj.stale_playbooks) || 0),
    total_tier0_hits: Math.max(0, Number(obj.total_tier0_hits) || 0),
    total_tokens_saved: Math.max(0, Number(obj.total_tokens_saved) || 0),
  };
}

export async function setBarGlass(
  opacity: number,
  blurEnabled: boolean,
  highContrast: boolean,
): Promise<void> {
  await invokeWithFallback<void>(
    "set_bar_glass",
    {
      opacity,
      blurEnabled,
      blur_enabled: blurEnabled,
      highContrast,
      high_contrast: highContrast,
    },
    () => undefined,
  );
}

export async function saveBarPosition(x: number, y: number): Promise<void> {
  await invokeWithFallback<void>(
    "save_bar_position",
    {
      x: Math.round(x),
      y: Math.round(y),
    },
    () => undefined,
  );
}

export async function clampBarPosition(): Promise<{ x: number; y: number } | null> {
  const raw = await invokeWithFallback<unknown>(
    "clamp_bar_position",
    undefined,
    () => null,
  );
  if (Array.isArray(raw) && raw.length >= 2) {
    return { x: Number(raw[0]) || 0, y: Number(raw[1]) || 0 };
  }
  return null;
}
