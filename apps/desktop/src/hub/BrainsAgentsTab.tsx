import React, { useState } from "react";
import {
  deleteApiKey,
  ollamaPull,
  ollamaStatus,
  openExternalUrl,
  setApiKey,
  testBrainConnection,
} from "../lib/ipc";
import {
  AGENT_LABELS,
  type AgentId,
  API_PROVIDER_LABELS,
  type ApiProvider,
  BRAIN_LABELS,
  type BrainMode,
  type ConnectionTestResult,
  type DetectedAgent,
  OLLAMA_MODELS,
  type OllamaStatus,
  type Settings,
} from "../types";
import {
  BrainIcon,
  CheckIcon,
  KeyIcon,
  ZapIcon,
} from "./HubIcons";

export interface BrainsAgentsTabProps {
  settings: Settings;
  onUpdateSettings: (patch: Partial<Settings>) => Promise<void> | void;
  configuredProviders: ApiProvider[];
  onConfiguredProvidersChange: React.Dispatch<React.SetStateAction<ApiProvider[]>>;
  ollamaInfo: OllamaStatus;
  onOllamaInfoChange: React.Dispatch<React.SetStateAction<OllamaStatus>>;
  pullProgress: { model: string; pct: number } | null;
  onPullProgressChange: React.Dispatch<
    React.SetStateAction<{ model: string; pct: number } | null>
  >;
  detectedAgents: DetectedAgent[];
}

const ALL_API_PROVIDERS: ApiProvider[] = [
  "openrouter",
  "groq",
  "gemini",
  "openai",
  "anthropic",
  "deepseek",
  "custom_openai",
];

const ALL_AGENT_IDS: AgentId[] = [
  "claude",
  "codex",
  "gemini",
  "agy",
  "copilot",
  "opencode",
  "hermes",
  "custom",
];

const AGENT_SUBTITLES: Record<AgentId, string> = {
  claude: "Anthropic Claude Code CLI",
  codex: "OpenAI Codex CLI",
  gemini: "Google Gemini CLI",
  agy: "Antigravity Agent CLI",
  copilot: "GitHub Copilot CLI (gh)",
  opencode: "OpenCode Terminal Agent",
  hermes: "Hermes Local/Cloud CLI",
  custom: "Bring your own command",
};

const OPENROUTER_PRESETS = [
  {
    id: "google/gemma-3-27b-it",
    label: "Gemma 3 27B",
    tag: "Ultra-Fast",
  },
  {
    id: "qwen/qwen2.5-vl-72b-instruct",
    label: "Qwen 2.5 VL 72B",
    tag: "Vision Pro",
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    tag: "Balanced",
  },
  {
    id: "anthropic/claude-3.7-sonnet",
    label: "Claude 3.7 Sonnet",
    tag: "Reasoning",
  },
] as const;

export const BrainsAgentsTab: React.FC<BrainsAgentsTabProps> = ({
  settings,
  onUpdateSettings,
  configuredProviders,
  onConfiguredProvidersChange,
  ollamaInfo,
  onOllamaInfoChange,
  pullProgress,
  onPullProgressChange,
  detectedAgents,
}) => {
  const [selectedKeyProvider, setSelectedKeyProvider] = useState<ApiProvider>(
    settings.byo_provider ?? "groq",
  );
  // Ephemeral secret input: wiped immediately before awaiting IPC save
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyStatusMessage, setKeyStatusMessage] = useState<string | null>(null);

  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] =
    useState<ConnectionTestResult | null>(null);

  const movePriority = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= settings.brain_priority.length) {
      return;
    }
    const list = [...settings.brain_priority];
    const [item] = list.splice(index, 1);
    list.splice(targetIndex, 0, item);
    void onUpdateSettings({ brain_priority: list });
  };

  const handleSaveApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const rawKey = apiKeyInput.trim();
    if (!rawKey) return;
    setApiKeyInput("");
    try {
      await setApiKey(selectedKeyProvider, rawKey);
      onConfiguredProvidersChange((prev) =>
        prev.includes(selectedKeyProvider)
          ? prev
          : [...prev, selectedKeyProvider],
      );
      if (settings.byo_provider !== selectedKeyProvider) {
        void onUpdateSettings({ byo_provider: selectedKeyProvider });
      }
      setKeyStatusMessage(
        `${API_PROVIDER_LABELS[selectedKeyProvider]} key saved in Windows Credential Manager.`,
      );
    } catch (err) {
      setKeyStatusMessage(
        err instanceof Error ? err.message : "Failed to store API key",
      );
    }
  };

  const handleDeleteApiKey = async (provider: ApiProvider) => {
    await deleteApiKey(provider);
    onConfiguredProvidersChange((prev) => prev.filter((p) => p !== provider));
    setKeyStatusMessage(
      `Removed ${API_PROVIDER_LABELS[provider]} key from Credential Manager.`,
    );
  };

  const handlePullOllamaModel = async (modelId: string) => {
    onPullProgressChange({ model: modelId, pct: 0 });
    try {
      await ollamaPull(modelId);
      onPullProgressChange({ model: modelId, pct: 100 });
      const refreshed = await ollamaStatus();
      onOllamaInfoChange(refreshed);
    } catch {
      onPullProgressChange(null);
    }
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    try {
      const targetBrain =
        settings.brain_mode === "auto"
          ? settings.brain_priority[0] ?? "byo_api"
          : settings.brain_mode;
      const result = await testBrainConnection({
        brain: targetBrain,
        provider: settings.byo_provider,
        model: settings.byo_model,
        base_url: settings.custom_api_base_url,
      });
      setConnectionResult(result);
    } finally {
      setTestingConnection(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="panel-brains">
      {/* Brain Mode, Priority & Live Speed Check */}
      <section className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/15 border border-indigo-400/30 flex items-center justify-center text-indigo-300">
              <BrainIcon className="w-4 h-4" />
            </div>
            <div>
              <label
                htmlFor="brain-mode-select"
                className="block text-[14px] font-semibold text-zinc-100"
              >
                Active Brain Mode
              </label>
              <p className="text-[11.5px] text-zinc-400">
                Auto routes through your priority chain below with instant fallback
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              id="brain-mode-select"
              aria-label="Active Brain Mode"
              data-testid="brain-mode-select"
              value={settings.brain_mode}
              onChange={(e) =>
                void onUpdateSettings({
                  brain_mode: e.target.value as BrainMode,
                })
              }
              className="rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12.5px] text-zinc-100"
            >
              <option value="auto">Auto (Follow Priority)</option>
              <option value="local_vlm">Local (Ollama VLM)</option>
              <option value="byo_api">BYO API Key</option>
              <option value="groq_pro">Groq Pro Cloud</option>
              <option value="agent_cli">Coding Agent CLI</option>
            </select>

            <button
              type="button"
              data-testid="test-brain-connection-btn"
              onClick={() => void handleTestConnection()}
              disabled={testingConnection}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-sky-400 hover:bg-sky-300 text-slate-950 font-semibold text-[12.5px] disabled:opacity-40"
            >
              <ZapIcon className="w-3.5 h-3.5" />
              {testingConnection ? "Testing…" : "Test Connection & Speed"}
            </button>
          </div>
        </div>

        {connectionResult && (
          <div
            data-testid="connection-test-result"
            className={`rounded-xl px-3.5 py-2.5 border flex flex-wrap items-center justify-between gap-2 text-[12px] ${
              connectionResult.ok
                ? "bg-emerald-500/10 border-emerald-400/35 text-emerald-200"
                : "bg-rose-500/10 border-rose-400/35 text-rose-200"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="font-semibold">
                {connectionResult.ok ? "Connected" : "Check Failed"}:
              </span>
              <span>{connectionResult.message}</span>
            </div>
            <span className="font-mono font-semibold">
              {connectionResult.latency_ms} ms
            </span>
          </div>
        )}

        <div className="space-y-1.5 pt-2 border-t border-white/[0.08]">
          <span className="block text-[11.5px] font-medium text-zinc-400">
            Auto Fallback Priority Order:
          </span>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" data-testid="brain-priority-list">
            {settings.brain_priority.map((b, idx) => (
              <li
                key={b}
                className="flex items-center justify-between rounded-xl bg-[#090B10]/80 border border-white/[0.07] px-3 py-1.5 text-[12.5px]"
              >
                <span>
                  <span className="font-mono text-sky-300 mr-1.5">{idx + 1}.</span>
                  {BRAIN_LABELS[b] ?? b}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => movePriority(idx, -1)}
                    disabled={idx === 0}
                    aria-label={`Move ${BRAIN_LABELS[b] ?? b} up`}
                    className="px-1.5 py-0.5 rounded bg-white/5 text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => movePriority(idx, 1)}
                    disabled={idx === settings.brain_priority.length - 1}
                    aria-label={`Move ${BRAIN_LABELS[b] ?? b} down`}
                    className="px-1.5 py-0.5 rounded bg-white/5 text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                  >
                    ↓
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Subscription Coding Agent CLIs */}
      <section
        aria-label="Detected Coding Agent CLIs"
        className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-3"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-semibold text-zinc-100">
              Subscription Coding Agent CLIs
            </h2>
            <p className="text-[11.5px] text-zinc-400">
              Use your existing Claude, Codex, Gemini, Antigravity, Copilot, OpenCode, Hermes, or custom CLI subscription
            </p>
          </div>
        </div>

        <div
          className="grid grid-cols-1 md:grid-cols-2 gap-2.5"
          data-testid="agent-cli-list"
        >
          {ALL_AGENT_IDS.map((id) => {
            const info = detectedAgents.find((a) => a.id === id);
            const installed = Boolean(info?.installed);
            const active = settings.agent_id === id;
            return (
              <label
                key={id}
                className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 cursor-pointer transition-colors ${
                  active
                    ? "bg-sky-400/12 border-sky-400/70"
                    : "bg-[#090B10]/80 border-white/10 hover:border-white/20"
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <input
                    type="radio"
                    name="agent_id"
                    checked={active}
                    onChange={() => void onUpdateSettings({ agent_id: id })}
                    aria-label={`Select ${AGENT_LABELS[id]}`}
                  />
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-zinc-100">
                      {AGENT_LABELS[id]}
                    </div>
                    <div className="text-[11px] text-zinc-400 truncate">
                      {info?.path ? (
                        <code className="gl-mono text-[10.5px] text-zinc-300">
                          {info.path}
                        </code>
                      ) : (
                        AGENT_SUBTITLES[id]
                      )}
                    </div>
                  </div>
                </div>
                <span
                  className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full font-medium ${
                    id === "custom"
                      ? "bg-indigo-500/15 text-indigo-300"
                      : installed
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-white/5 text-zinc-400"
                  }`}
                >
                  {id === "custom"
                    ? "Custom"
                    : installed
                      ? "Detected"
                      : "Not on PATH"}
                </span>
              </label>
            );
          })}
        </div>

        {/* Custom CLI Command Input */}
        <div className="pt-1">
          <label
            htmlFor="custom-agent-cmd-input"
            className="block text-[11.5px] font-medium text-zinc-400 mb-1"
          >
            Custom CLI Command (used when Custom CLI is selected)
          </label>
          <input
            id="custom-agent-cmd-input"
            type="text"
            data-testid="custom-agent-cmd-input"
            value={settings.custom_agent_cmd ?? ""}
            onChange={(e) =>
              void onUpdateSettings({
                custom_agent_cmd: e.target.value.trim()
                  ? e.target.value
                  : null,
              })
            }
            placeholder="e.g., my-agent-cli --headless --stdin"
            className="w-full rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12.5px] font-mono text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-sky-400"
          />
        </div>
      </section>

      {/* BYO API Providers + OpenRouter Presets + Windows Credential Manager */}
      <section
        aria-label="Bring Your Own API Keys"
        className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-sky-400/15 border border-sky-400/30 flex items-center justify-center text-sky-300">
              <KeyIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-[14px] font-semibold text-zinc-100">
                API Providers &amp; Windows Credential Manager Vault
              </h2>
              <p className="text-[11.5px] text-zinc-400">
                Keys are stored strictly in Windows Credential Manager and cleared from JS state immediately on save
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Active BYO Provider"
              data-testid="active-byo-provider-select"
              value={settings.byo_provider ?? "groq"}
              onChange={(e) =>
                void onUpdateSettings({
                  byo_provider: e.target.value as ApiProvider,
                })
              }
              className="rounded-xl bg-[#090B10] border border-white/15 px-2.5 py-1.5 text-[12px] text-zinc-100"
            >
              {ALL_API_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  Use: {API_PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
            <input
              type="text"
              aria-label="Optional BYO Model Override"
              data-testid="byo-model-input"
              value={settings.byo_model ?? ""}
              onChange={(e) =>
                void onUpdateSettings({
                  byo_model: e.target.value.trim() ? e.target.value : null,
                })
              }
              placeholder="Default model"
              className="w-48 rounded-xl bg-[#090B10] border border-white/15 px-2.5 py-1.5 text-[12px] text-zinc-100 placeholder-zinc-500"
            />
          </div>
        </div>

        {/* OpenRouter 1-Click Model Presets */}
        <div className="rounded-xl bg-[#090B10]/75 border border-white/[0.07] p-3 space-y-2">
          <div className="flex items-center justify-between text-[11.5px]">
            <span className="font-medium text-zinc-300">
              OpenRouter 1-Click Vision Presets
            </span>
            <span className="text-zinc-500">Sets OpenRouter + model override</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {OPENROUTER_PRESETS.map((preset) => {
              const selected =
                settings.byo_provider === "openrouter" &&
                settings.byo_model === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`openrouter-preset-${preset.id}`}
                  onClick={() =>
                    void onUpdateSettings({
                      byo_provider: "openrouter",
                      byo_model: preset.id,
                    })
                  }
                  className={`text-left rounded-xl p-2.5 border transition-colors ${
                    selected
                      ? "bg-sky-400/15 border-sky-400 text-zinc-100"
                      : "bg-white/[0.03] border-white/10 hover:bg-white/[0.06] text-zinc-300"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[12px] font-semibold truncate">
                      {preset.label}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-sky-300 shrink-0">
                      {preset.tag}
                    </span>
                  </div>
                  <div className="text-[10.5px] font-mono text-zinc-400 truncate mt-0.5">
                    {preset.id}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom OpenAI-Compatible Base URL */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
          <label
            htmlFor="custom-api-base-url"
            className="md:col-span-4 text-[12px] text-zinc-300"
          >
            Custom OpenAI-Compatible Base URL
          </label>
          <input
            id="custom-api-base-url"
            type="url"
            data-testid="custom-api-base-url-input"
            value={settings.custom_api_base_url ?? ""}
            onChange={(e) =>
              void onUpdateSettings({
                custom_api_base_url: e.target.value.trim()
                  ? e.target.value
                  : null,
              })
            }
            placeholder="https://api.together.xyz/v1 or http://localhost:1234/v1"
            className="md:col-span-8 rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12.5px] font-mono text-zinc-100 placeholder-zinc-500"
          />
        </div>

        {/* Save Key Form */}
        <form onSubmit={handleSaveApiKey} className="flex items-center gap-2">
          <select
            aria-label="Key Provider to Save"
            data-testid="key-provider-select"
            value={selectedKeyProvider}
            onChange={(e) =>
              setSelectedKeyProvider(e.target.value as ApiProvider)
            }
            className="rounded-xl bg-[#090B10] border border-white/15 px-2.5 py-1.5 text-[12.5px] text-zinc-100"
          >
            {ALL_API_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {API_PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
          <input
            type="password"
            autoComplete="off"
            aria-label="API Key Secret Input"
            data-testid="api-key-input"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder={`Enter ${API_PROVIDER_LABELS[selectedKeyProvider]} API Key (masked)...`}
            className="flex-1 rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12.5px] text-zinc-100"
          />
          <button
            type="submit"
            data-testid="save-api-key-btn"
            className="px-3.5 py-1.5 rounded-xl bg-sky-400 text-slate-950 font-semibold text-[12.5px]"
          >
            Save Key
          </button>
        </form>

        {keyStatusMessage && (
          <p
            data-testid="api-key-status-msg"
            className="text-[12px] text-emerald-300 flex items-center gap-1.5"
          >
            <CheckIcon className="w-3.5 h-3.5" />
            {keyStatusMessage}
          </p>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {ALL_API_PROVIDERS.map((p) => {
            const hasKey = configuredProviders.includes(p);
            return (
              <div
                key={p}
                data-testid={`provider-badge-${p}`}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] border ${
                  hasKey
                    ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-300"
                    : "bg-white/[0.04] border-white/10 text-zinc-400"
                }`}
              >
                <span>
                  {API_PROVIDER_LABELS[p]}: {hasKey ? "Saved (••••)" : "Not set"}
                </span>
                {hasKey && (
                  <button
                    type="button"
                    onClick={() => void handleDeleteApiKey(p)}
                    aria-label={`Delete ${API_PROVIDER_LABELS[p]} key`}
                    data-testid={`delete-key-${p}`}
                    className="ml-1 text-xs text-rose-400 hover:text-rose-300"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Split Routing: Fast Live Step vs Nightly Summary Brain + Local Ollama */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Fast-Step vs Nightly-Summary Split Routing */}
        <section className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-3">
          <div>
            <h2 className="text-[13.5px] font-semibold text-zinc-100">
              Fast-Step vs Nightly-Summary Split Routing
            </h2>
            <p className="text-[11.5px] text-zinc-400">
              Keep live step guidance blazing fast while routing end-of-day diary digests to a deeper model
            </p>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="summary-brain-mode-select"
                className="text-[12px] text-zinc-300"
              >
                Summary Brain Mode
              </label>
              <select
                id="summary-brain-mode-select"
                data-testid="summary-brain-mode-select"
                value={settings.summary_brain_mode ?? ""}
                onChange={(e) =>
                  void onUpdateSettings({
                    summary_brain_mode: e.target.value
                      ? (e.target.value as BrainMode)
                      : null,
                  })
                }
                className="rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12px] text-zinc-100"
              >
                <option value="">Same as Live Step Brain</option>
                <option value="byo_api">BYO API Key</option>
                <option value="agent_cli">Coding Agent CLI</option>
                <option value="groq_pro">Groq Pro Cloud</option>
                <option value="local_vlm">Local Ollama</option>
                <option value="auto">Auto Priority</option>
              </select>
            </div>

            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="summary-provider-select"
                className="text-[12px] text-zinc-300"
              >
                Summary Provider Override
              </label>
              <select
                id="summary-provider-select"
                data-testid="summary-provider-select"
                value={settings.summary_byo_provider ?? ""}
                onChange={(e) =>
                  void onUpdateSettings({
                    summary_byo_provider: e.target.value
                      ? (e.target.value as ApiProvider)
                      : null,
                  })
                }
                className="rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12px] text-zinc-100"
              >
                <option value="">Inherit Active BYO Provider</option>
                {ALL_API_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {API_PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="summary-model-input"
                className="text-[12px] text-zinc-300"
              >
                Summary Model Override
              </label>
              <input
                id="summary-model-input"
                type="text"
                data-testid="summary-model-input"
                value={settings.summary_byo_model ?? ""}
                onChange={(e) =>
                  void onUpdateSettings({
                    summary_byo_model: e.target.value.trim()
                      ? e.target.value
                      : null,
                  })
                }
                placeholder="e.g., anthropic/claude-3.7-sonnet"
                className="w-56 rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12px] text-zinc-100 placeholder-zinc-500"
              />
            </div>
          </div>
        </section>

        {/* Local Vision Model (Ollama) */}
        <section
          aria-label="Local Ollama Vision Model"
          className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[13.5px] font-semibold text-zinc-100">
                Local Vision Model (Ollama)
              </h2>
              <p className="text-[11.5px] text-zinc-400">
                Status:{" "}
                <strong
                  data-testid="ollama-running-badge"
                  className={
                    ollamaInfo.running ? "text-emerald-300" : "text-amber-400"
                  }
                >
                  {ollamaInfo.running
                    ? `Running (${ollamaInfo.models.length} models installed)`
                    : "Not Running"}
                </strong>
              </p>
            </div>
            {!ollamaInfo.running && (
              <button
                type="button"
                onClick={() => void openExternalUrl(ollamaInfo.install_url)}
                className="px-3 py-1 rounded-xl bg-white/10 text-sky-300 text-[12px]"
              >
                Install Ollama
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <select
              aria-label="Ollama Vision Model"
              data-testid="ollama-model-select"
              value={settings.ollama_model}
              onChange={(e) =>
                void onUpdateSettings({ ollama_model: e.target.value })
              }
              className="flex-1 rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12.5px] text-zinc-100"
            >
              {OLLAMA_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="ollama-pull-btn"
              onClick={() =>
                void handlePullOllamaModel(settings.ollama_model)
              }
              className="px-3.5 py-1.5 rounded-xl bg-sky-400 text-slate-950 font-semibold text-[12.5px]"
            >
              Pull Model
            </button>
          </div>

          {pullProgress && (
            <div data-testid="ollama-pull-progress" className="space-y-1 pt-1">
              <div className="flex justify-between text-[11.5px] text-sky-300">
                <span>Pulling {pullProgress.model}...</span>
                <span>{pullProgress.pct}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-black overflow-hidden">
                <div
                  style={{ width: `${pullProgress.pct}%` }}
                  className="h-full bg-sky-400 transition-all"
                />
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
