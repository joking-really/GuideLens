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
import { CheckIcon } from "./HubIcons";

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

type BrainsSubTab = "api" | "clis" | "local";

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
    tag: "Fast",
  },
  {
    id: "qwen/qwen2.5-vl-72b-instruct",
    label: "Qwen 2.5 VL 72B",
    tag: "Vision",
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
  const [subTab, setSubTab] = useState<BrainsSubTab>("api");
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
    <div className="space-y-4" data-testid="panel-brains">
      {/* Compact Active Brain & Test Connection Header */}
      <section className="rounded-xl bg-[#111317] border border-white/[0.07] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <label
              htmlFor="brain-mode-select"
              className="block text-[13.5px] font-semibold text-[#F4F4F5]"
            >
              Active Brain Mode
            </label>
            <p className="text-[12px] text-[#8E929B]">
              Choose how GuideLens routes vision and reasoning requests
            </p>
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
              className="rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-[#F4F4F5]"
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
              className="px-3.5 py-1.5 rounded-lg bg-[#F4F4F5] hover:bg-white text-[#0A0B0D] font-medium text-[12.5px] disabled:opacity-40 transition-colors"
            >
              {testingConnection ? "Testing…" : "Test Connection"}
            </button>
          </div>
        </div>

        {connectionResult && (
          <div
            data-testid="connection-test-result"
            className="rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#E4E4E7]"
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  connectionResult.ok ? "bg-emerald-400" : "bg-[#5C606A]"
                }`}
              />
              <span className="font-medium">
                {connectionResult.ok ? "Connected" : "Check Failed"}:
              </span>
              <span className="text-[#8E929B]">{connectionResult.message}</span>
            </div>
            <span className="font-mono text-[#F4F4F5]">
              {connectionResult.latency_ms} ms
            </span>
          </div>
        )}
      </section>

      {/* 3 Clean Segmented Sub-Tabs */}
      <div
        role="tablist"
        aria-label="Models and Agents Sections"
        className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#111317] border border-white/[0.07]"
      >
        {(
          [
            { id: "api", label: "API Providers" },
            { id: "clis", label: "Subscription CLIs" },
            { id: "local", label: "Local & Routing" },
          ] as const
        ).map((tab) => {
          const active = subTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`brains-subtab-${tab.id}`}
              onClick={() => setSubTab(tab.id)}
              className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                active
                  ? "bg-[#17191E] text-[#F4F4F5] border border-white/[0.08]"
                  : "text-[#8E929B] hover:text-[#F4F4F5] border border-transparent"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Sub-Tab 1: API Providers + OpenRouter Presets + Key Vault */}
      {subTab === "api" && (
        <div className="space-y-4">
        <section
          aria-label="Bring Your Own API Keys"
          className="rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                API Providers &amp; Key Vault
              </h2>
              <p className="text-[12px] text-[#8E929B] mt-0.5">
                Stored in Windows Credential Manager and cleared from memory immediately
              </p>
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
                className="rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-2.5 py-1.5 text-[12px] text-[#F4F4F5]"
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
                placeholder="Model override"
                className="w-44 rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-2.5 py-1.5 text-[12px] text-[#F4F4F5] placeholder-[#5C606A]"
              />
            </div>
          </div>

          {/* OpenRouter Presets */}
          <div className="rounded-lg bg-[#0A0B0D] border border-white/[0.07] p-3 space-y-2">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="font-medium text-[#E4E4E7]">
                OpenRouter Vision Presets
              </span>
              <span className="text-[#5C606A]">1-click model override</span>
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
                    className={`text-left rounded-lg p-2.5 border transition-colors ${
                      selected
                        ? "bg-[#17191E] border-white/30 text-[#F4F4F5]"
                        : "bg-[#111317] border-white/[0.07] hover:bg-[#17191E] text-[#8E929B]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[12px] font-medium text-[#F4F4F5] truncate">
                        {preset.label}
                      </span>
                      <span className="text-[10px] text-[#8E929B] shrink-0">
                        {preset.tag}
                      </span>
                    </div>
                    <div className="text-[10.5px] font-mono text-[#5C606A] truncate mt-0.5">
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
              className="md:col-span-4 text-[12px] text-[#8E929B]"
            >
              Custom OpenAI-Compatible URL
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
              className="md:col-span-8 rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] font-mono text-[#F4F4F5] placeholder-[#5C606A]"
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
              className="rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-2.5 py-1.5 text-[12.5px] text-[#F4F4F5]"
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
              placeholder={`Enter ${API_PROVIDER_LABELS[selectedKeyProvider]} API Key…`}
              className="flex-1 rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-[#F4F4F5] placeholder-[#5C606A]"
            />
            <button
              type="submit"
              data-testid="save-api-key-btn"
              className="px-3.5 py-1.5 rounded-lg bg-[#F4F4F5] hover:bg-white text-[#0A0B0D] font-medium text-[12.5px] transition-colors"
            >
              Save Key
            </button>
          </form>

          {keyStatusMessage && (
            <p
              data-testid="api-key-status-msg"
              className="text-[12px] text-[#E4E4E7] flex items-center gap-1.5"
            >
              <CheckIcon className="w-3.5 h-3.5 text-[#F4F4F5]" />
              {keyStatusMessage}
            </p>
          )}

          {/* Configured Key Badges */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {ALL_API_PROVIDERS.map((p) => {
              const hasKey = configuredProviders.includes(p);
              return (
                <div
                  key={p}
                  data-testid={`provider-badge-${p}`}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] border ${
                    hasKey
                      ? "bg-[#17191E] border-white/[0.15] text-[#F4F4F5]"
                      : "bg-[#0A0B0D] border-white/[0.07] text-[#5C606A]"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      hasKey ? "bg-[#F4F4F5]" : "bg-[#5C606A]"
                    }`}
                  />
                  <span>
                    {API_PROVIDER_LABELS[p]}:{" "}
                    {hasKey ? "Saved (••••)" : "Not set"}
                  </span>
                  {hasKey && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteApiKey(p)}
                      aria-label={`Delete ${API_PROVIDER_LABELS[p]} key`}
                      data-testid={`delete-key-${p}`}
                      className="ml-1 text-[11px] text-[#8E929B] hover:text-[#F4F4F5]"
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
        </div>
      )}

      {/* Sub-Tab 2: Subscription Coding Agent CLIs */}
      {subTab === "clis" && (
        <div className="space-y-4">
        <section
          aria-label="Detected Coding Agent CLIs"
          className="rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-4"
        >
          <div>
            <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
              Subscription Coding Agent CLIs
            </h2>
            <p className="text-[12px] text-[#8E929B] mt-0.5">
              Route requests through your local CLI subscriptions
            </p>
          </div>

          <div
            className="grid grid-cols-1 md:grid-cols-2 gap-2"
            data-testid="agent-cli-list"
          >
            {ALL_AGENT_IDS.map((id) => {
              const info = detectedAgents.find((a) => a.id === id);
              const installed = Boolean(info?.installed);
              const active = settings.agent_id === id;
              return (
                <label
                  key={id}
                  className={`flex items-center justify-between rounded-lg border px-3.5 py-2.5 cursor-pointer transition-colors ${
                    active
                      ? "bg-[#17191E] border-white/25"
                      : "bg-[#0A0B0D] border-white/[0.07] hover:bg-[#17191E]"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <input
                      type="radio"
                      name="agent_id"
                      checked={active}
                      onChange={() => void onUpdateSettings({ agent_id: id })}
                      aria-label={`Select ${AGENT_LABELS[id]}`}
                      className="accent-[#F4F4F5]"
                    />
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-medium text-[#F4F4F5]">
                        {AGENT_LABELS[id]}
                      </div>
                      <div className="text-[11px] text-[#5C606A] truncate">
                        {info?.path ? (
                          <code className="gl-mono text-[10.5px] text-[#8E929B]">
                            {info.path}
                          </code>
                        ) : (
                          AGENT_SUBTITLES[id]
                        )}
                      </div>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 text-[11px] font-medium ${
                      installed || id === "custom"
                        ? "text-[#F4F4F5]"
                        : "text-[#5C606A]"
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

          <div>
            <label
              htmlFor="custom-agent-cmd-input"
              className="block text-[11.5px] text-[#8E929B] mb-1.5"
            >
              Custom CLI Command
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
              className="w-full rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] font-mono text-[#F4F4F5] placeholder-[#5C606A] focus:outline-none focus:border-white/25"
            />
          </div>
        </section>
        </div>
      )}

      {/* Sub-Tab 3: Local Ollama & Split Routing */}
      {subTab === "local" && (
        <div className="space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Local Vision Model (Ollama) */}
          <section
            aria-label="Local Ollama Vision Model"
            className="min-w-0 rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                  Local Ollama
                </h2>
                <p className="text-[12px] text-[#8E929B] flex items-center gap-1.5 mt-0.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      ollamaInfo.running ? "bg-emerald-400" : "bg-[#5C606A]"
                    }`}
                  />
                  <strong
                    data-testid="ollama-running-badge"
                    className="font-medium text-[#E4E4E7] truncate"
                  >
                    {ollamaInfo.running
                      ? `Running (${ollamaInfo.models.length} models)`
                      : "Not Running"}
                  </strong>
                </p>
              </div>
              {!ollamaInfo.running && (
                <button
                  type="button"
                  onClick={() => void openExternalUrl(ollamaInfo.install_url)}
                  className="shrink-0 whitespace-nowrap px-3 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#E4E4E7] text-[12px]"
                >
                  Install Ollama
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 min-w-0">
              <select
                aria-label="Ollama Vision Model"
                data-testid="ollama-model-select"
                value={settings.ollama_model}
                onChange={(e) =>
                  void onUpdateSettings({ ollama_model: e.target.value })
                }
                className="flex-1 min-w-0 rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-[#F4F4F5]"
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
                className="shrink-0 whitespace-nowrap px-3.5 py-1.5 rounded-lg bg-[#F4F4F5] hover:bg-white text-[#0A0B0D] font-medium text-[12px] transition-colors"
              >
                Pull Model
              </button>
            </div>

            {pullProgress && (
              <div data-testid="ollama-pull-progress" className="space-y-1.5 pt-1">
                <div className="flex justify-between text-[11.5px] text-[#8E929B]">
                  <span>Pulling {pullProgress.model}…</span>
                  <span className="font-mono text-[#F4F4F5]">{pullProgress.pct}%</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-[#0A0B0D] overflow-hidden">
                  <div
                    style={{ width: `${pullProgress.pct}%` }}
                    className="h-full bg-[#F4F4F5] transition-all"
                  />
                </div>
              </div>
            )}
          </section>

          {/* Split Routing */}
          <section className="min-w-0 rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-3">
            <div>
              <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                Split Routing
              </h2>
              <p className="text-[12px] text-[#8E929B] mt-0.5">
                Use a separate model for end-of-day diary summaries
              </p>
            </div>

            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <label
                  htmlFor="summary-brain-mode-select"
                  className="text-[12px] text-[#8E929B] shrink-0"
                >
                  Summary Mode
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
                  className="min-w-0 max-w-[200px] rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12px] text-[#F4F4F5]"
                >
                  <option value="">Same as Live Step Brain</option>
                  <option value="byo_api">BYO API Key</option>
                  <option value="agent_cli">Coding Agent CLI</option>
                  <option value="groq_pro">Groq Pro Cloud</option>
                  <option value="local_vlm">Local Ollama</option>
                  <option value="auto">Auto Priority</option>
                </select>
              </div>

              <div className="flex items-center justify-between gap-2 min-w-0">
                <label
                  htmlFor="summary-provider-select"
                  className="text-[12px] text-[#8E929B] shrink-0"
                >
                  Summary Provider
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
                  className="min-w-0 max-w-[200px] rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12px] text-[#F4F4F5]"
                >
                  <option value="">Inherit Active BYO Provider</option>
                  {ALL_API_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {API_PROVIDER_LABELS[p]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between gap-2 min-w-0">
                <label
                  htmlFor="summary-model-input"
                  className="text-[12px] text-[#8E929B] shrink-0"
                >
                  Summary Model
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
                  className="min-w-0 w-48 rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12px] text-[#F4F4F5] placeholder-[#5C606A]"
                />
              </div>
            </div>
          </section>
        </div>

        {/* Auto Fallback Priority Order */}
        <section className="rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-2.5">
          <span className="block text-[12.5px] font-medium text-[#F4F4F5]">
            Auto Fallback Priority
          </span>
          <ul
            className="grid grid-cols-1 sm:grid-cols-2 gap-1.5"
            data-testid="brain-priority-list"
          >
            {settings.brain_priority.map((b, idx) => (
              <li
                key={b}
                className="flex items-center justify-between rounded-lg bg-[#0A0B0D] border border-white/[0.07] px-3 py-2 text-[12.5px]"
              >
                <span className="text-[#F4F4F5]">
                  <span className="font-mono text-[#5C606A] mr-2">
                    {idx + 1}.
                  </span>
                  {BRAIN_LABELS[b] ?? b}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => movePriority(idx, -1)}
                    disabled={idx === 0}
                    aria-label={`Move ${BRAIN_LABELS[b] ?? b} up`}
                    className="px-1.5 py-0.5 rounded bg-white/[0.04] text-[#8E929B] hover:text-[#F4F4F5] disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => movePriority(idx, 1)}
                    disabled={idx === settings.brain_priority.length - 1}
                    aria-label={`Move ${BRAIN_LABELS[b] ?? b} down`}
                    className="px-1.5 py-0.5 rounded bg-white/[0.04] text-[#8E929B] hover:text-[#F4F4F5] disabled:opacity-30"
                  >
                    ↓
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
        </div>
      )}
    </div>
  );
};
