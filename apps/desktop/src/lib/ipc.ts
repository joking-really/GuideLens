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
  type BrainKind,
  type BrainStatusPayload,
  clampInstruction,
  DEFAULT_SETTINGS,
  type DetectedAgent,
  type HistoryDetail,
  type HistorySession,
  type HistoryStep,
  type MonitorInfo,
  type OllamaPullProgressPayload,
  type OllamaStatus,
  type ResolvedStep,
  type Settings,
  type Step,
  type StepChangedPayload,
  type StepMode,
  type StepPlan,
  type SttEngine,
} from "../types";
import { normalizedToPhysical } from "./overlayGeometry";

const BAR_POS_STORAGE_KEY = "guidelens.bar_position";

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
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
  const bbox =
    Array.isArray(obj.bbox) && obj.bbox.length === 4
      ? ([
          Number(obj.bbox[0]) || 0,
          Number(obj.bbox[1]) || 0,
          Number(obj.bbox[2]) || 0,
          Number(obj.bbox[3]) || 0,
        ] as [number, number, number, number])
      : null;

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
  };
}

function normalizeResolvedStep(
  raw: unknown,
  idx: number,
  monitor?: MonitorInfo | null,
): ResolvedStep {
  const base = normalizeStep(raw, idx);
  const obj = isRecord(raw) ? raw : {};
  let rectPx: ResolvedStep["rect_px"] = null;

  if (isRecord(obj.rect_px)) {
    rectPx = {
      x: Number(obj.rect_px.x) || 0,
      y: Number(obj.rect_px.y) || 0,
      w: Number(obj.rect_px.w ?? obj.rect_px.width) || 0,
      h: Number(obj.rect_px.h ?? obj.rect_px.height) || 0,
    };
  } else if (base.bbox && base.confidence >= 0.5) {
    const mon = monitor ?? { x: 0, y: 0, w: 1920, h: 1080, scale: 1 };
    rectPx = normalizedToPhysical(base.bbox, mon);
  }

  const rawSource = obj.source;
  const source: ResolvedStep["source"] =
    rawSource === "uia" || rawSource === "vlm" || rawSource === "none"
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
  const monitor: MonitorInfo | null = isRecord(obj.monitor)
    ? {
        x: Number(obj.monitor.x) || 0,
        y: Number(obj.monitor.y) || 0,
        w: Number(obj.monitor.w ?? obj.monitor.width) || 1920,
        h: Number(obj.monitor.h ?? obj.monitor.height) || 1080,
        scale: Number(obj.monitor.scale) || 1,
      }
    : null;

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
): Promise<AskResponse> {
  try {
    const res = await invoke<unknown>("ask", {
      query,
      brain: brainOverride ?? null,
      brainOverride: brainOverride ?? null,
      brain_override: brainOverride ?? null,
    });
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

export async function getSettings(): Promise<Settings> {
  try {
    const raw = await invoke<Partial<Settings>>("get_settings");
    const savedPos = readSavedBarPosition();
    return {
      ...DEFAULT_SETTINGS,
      ...(isRecord(raw) ? raw : {}),
      bar_position:
        (isRecord(raw) && isRecord(raw.bar_position)
          ? {
              x: Number(raw.bar_position.x) || 0,
              y: Number(raw.bar_position.y) || 0,
            }
          : null) ?? savedPos,
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      bar_position: readSavedBarPosition(),
    };
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

export function onSettingsChanged(
  handler: (settings: Settings) => void,
): Promise<UnlistenFn> {
  return listen<Partial<Settings>>("settings-changed", (event) => {
    const raw = isRecord(event.payload) ? event.payload : {};
    handler({
      ...DEFAULT_SETTINGS,
      ...(raw as Partial<Settings>),
    });
  });
}

export function onSettingsRoute(
  handler: (route: "/settings" | "/onboarding") => void,
): Promise<UnlistenFn> {
  return listen<{ route?: unknown }>("settings-route", (event) => {
    const route =
      isRecord(event.payload) && event.payload.route === "/onboarding"
        ? "/onboarding"
        : "/settings";
    handler(route);
  });
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
): Promise<boolean> {
  try {
    const existing = await WebviewWindow.getByLabel("settings");
    if (existing) {
      try {
        await existing.emit("settings-route", { route });
      } catch {
        // Ignore if event emission is unavailable
      }
      try {
        await existing.setTitle(
          route === "/onboarding"
            ? "Welcome to GuideLens"
            : "GuideLens Settings & History",
        );
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
      url: route,
      title:
        route === "/onboarding"
          ? "Welcome to GuideLens"
          : "GuideLens Settings & History",
      width: 780,
      height: 640,
      minWidth: 640,
      minHeight: 520,
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
  width = 480,
): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.setSize(
      new LogicalSize(Math.max(480, Math.round(width)), Math.max(52, Math.round(height))),
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
