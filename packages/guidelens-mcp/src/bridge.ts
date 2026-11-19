import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BridgeConfig,
  BridgeConfigSchema,
  CaptureResponse,
  CaptureResponseSchema,
  HealthResponse,
  HealthResponseSchema,
  HighlightInput,
  HighlightInputSchema,
  OkResponse,
  OkResponseSchema,
  ShowCommandInput,
  ShowCommandInputSchema,
  StepPlanInput,
  StepPlanSchema,
} from "./types.js";

export class GuideLensNotRunningError extends Error {
  public readonly code = "GUIDELENS_NOT_RUNNING";

  constructor(detail?: string) {
    const suffix = detail ? ` (${detail})` : "";
    super(`GuideLens desktop app is not running${suffix}. Start GuideLens first.`);
    this.name = "GuideLensNotRunningError";
  }
}

export class BridgeAuthError extends Error {
  public readonly code = "BRIDGE_AUTH_ERROR";
  public readonly status: number;

  constructor(status: number, message?: string) {
    super(
      message ??
        `GuideLens bridge authentication failed (HTTP ${status}). Start GuideLens first to refresh bridge credentials.`
    );
    this.name = "BridgeAuthError";
    this.status = status;
  }
}

export class BridgeHttpError extends Error {
  public readonly code = "BRIDGE_HTTP_ERROR";
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, body: string) {
    super(`GuideLens bridge HTTP ${status}: ${body || "Unknown error"}`);
    this.name = "BridgeHttpError";
    this.status = status;
    this.body = body;
  }
}

export interface BridgeClientOptions {
  /** Override path to bridge.json (defaults to %LOCALAPPDATA%\GuideLens\bridge.json) */
  bridgeFilePath?: string;
  /** Optional static config override (bypasses reading bridge.json) */
  config?: BridgeConfig;
  /** Request timeout in milliseconds (default 10000) */
  timeoutMs?: number;
  /** Custom fetch implementation for testing */
  fetchFn?: typeof fetch;
}

export function getDefaultBridgeFilePath(
  env: NodeJS.ProcessEnv = process.env
): string {
  if (env.GUIDELENS_BRIDGE_FILE && env.GUIDELENS_BRIDGE_FILE.trim().length > 0) {
    return env.GUIDELENS_BRIDGE_FILE.trim();
  }
  const localAppData =
    env.LOCALAPPDATA && env.LOCALAPPDATA.trim().length > 0
      ? env.LOCALAPPDATA.trim()
      : path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "GuideLens", "bridge.json");
}

export async function readBridgeConfig(
  bridgeFilePath: string = getDefaultBridgeFilePath()
): Promise<BridgeConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(bridgeFilePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    throw new GuideLensNotRunningError(
      code === "ENOENT"
        ? `bridge.json not found at ${bridgeFilePath}`
        : `unable to read ${bridgeFilePath}`
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new GuideLensNotRunningError(`invalid JSON in ${bridgeFilePath}`);
  }

  const validated = BridgeConfigSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new GuideLensNotRunningError(
      `malformed bridge.json: ${validated.error.issues.map((i) => i.message).join(", ")}`
    );
  }

  return validated.data;
}

export class BridgeClient {
  private readonly bridgeFilePath?: string;
  private readonly staticConfig?: BridgeConfig;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: BridgeClientOptions = {}) {
    this.bridgeFilePath = options.bridgeFilePath;
    this.staticConfig = options.config;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  public async getConfig(): Promise<BridgeConfig> {
    if (this.staticConfig) {
      return BridgeConfigSchema.parse(this.staticConfig);
    }
    return readBridgeConfig(this.bridgeFilePath ?? getDefaultBridgeFilePath());
  }

  private async request<T>(
    method: "GET" | "POST",
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const config = await this.getConfig();
    const url = `http://127.0.0.1:${config.port}${endpoint}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/json",
    };

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GuideLensNotRunningError(
        `cannot connect to 127.0.0.1:${config.port} — ${msg}`
      );
    }

    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
      throw new BridgeAuthError(response.status, text || undefined);
    }

    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        detail = parsed.error ?? parsed.message ?? text;
      } catch {
        // leave raw text
      }
      throw new BridgeHttpError(response.status, detail);
    }

    try {
      return (text ? JSON.parse(text) : { ok: true }) as T;
    } catch {
      throw new BridgeHttpError(
        response.status,
        `Invalid JSON response from bridge: ${text}`
      );
    }
  }

  public async health(): Promise<HealthResponse> {
    const raw = await this.request<unknown>("GET", "/v1/health");
    return HealthResponseSchema.parse(raw);
  }

  public async capture(): Promise<CaptureResponse> {
    const raw = await this.request<unknown>("POST", "/v1/capture", {});
    return CaptureResponseSchema.parse(raw);
  }

  public async highlight(input: HighlightInput): Promise<OkResponse> {
    const validated = HighlightInputSchema.parse(input);
    const payload = {
      x: validated.x,
      y: validated.y,
      width: validated.width,
      height: validated.height,
      coords: validated.coords,
      step_label: validated.step_label,
      instruction_text: validated.instruction_text,
      magnify: validated.magnify,
    };
    const raw = await this.request<unknown>("POST", "/v1/highlight", payload);
    return OkResponseSchema.parse(raw);
  }

  public async showCommand(input: ShowCommandInput): Promise<OkResponse> {
    const validated = ShowCommandInputSchema.parse(input);
    const payload = {
      command: validated.command,
      explanation: validated.explanation,
    };
    const raw = await this.request<unknown>(
      "POST",
      "/v1/show_command",
      payload
    );
    return OkResponseSchema.parse(raw);
  }

  public async guide(plan: StepPlanInput): Promise<OkResponse> {
    const validatedPlan = StepPlanSchema.parse(plan);
    const raw = await this.request<unknown>("POST", "/v1/guide", {
      plan: validatedPlan,
    });
    return OkResponseSchema.parse(raw);
  }

  public async clear(): Promise<OkResponse> {
    const raw = await this.request<unknown>("POST", "/v1/clear", {});
    return OkResponseSchema.parse(raw);
  }
}
