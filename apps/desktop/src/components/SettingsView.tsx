import React, { useEffect, useState } from "react";
import {
  authLogin,
  authLogout,
  authStatus,
  billingCheckout,
  copyToClipboard,
  deleteApiKey,
  detectAgents,
  getSettings,
  historyGet,
  historyList,
  listApiKeyProviders,
  ollamaPull,
  ollamaStatus,
  onOllamaPullProgress,
  openExternalUrl,
  setApiKey,
  setSettings,
} from "../lib/ipc";
import {
  AGENT_LABELS,
  type AgentId,
  API_PROVIDER_LABELS,
  type ApiProvider,
  type AuthStatus,
  BRAIN_LABELS,
  type BrainKind,
  type BrainMode,
  DEFAULT_SETTINGS,
  type DetectedAgent,
  type HistoryDetail,
  type HistorySession,
  OLLAMA_MODELS,
  type OllamaStatus,
  type Settings,
  type SttEngine,
} from "../types";

export interface SettingsViewProps {
  initialSettings?: Settings;
  initialTab?: "brains" | "account" | "privacy" | "history";
  onSettingsChange?: (settings: Settings) => void;
  onClose?: () => void;
}

const ALL_API_PROVIDERS: ApiProvider[] = [
  "gemini",
  "openai",
  "anthropic",
  "groq",
  "openrouter",
];

const ALL_AGENT_IDS: AgentId[] = ["claude", "codex", "gemini", "agy", "hermes"];

export const SettingsView: React.FC<SettingsViewProps> = ({
  initialSettings,
  initialTab = "brains",
  onSettingsChange,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<
    "brains" | "account" | "privacy" | "history"
  >(initialTab);
  const [settings, setLocalSettings] = useState<Settings>(
    initialSettings ?? DEFAULT_SETTINGS,
  );
  const [configuredProviders, setConfiguredProviders] = useState<ApiProvider[]>(
    [],
  );
  const [selectedKeyProvider, setSelectedKeyProvider] = useState<ApiProvider>(
    initialSettings?.byo_provider ?? "groq",
  );
  // Ephemeral input: cleared immediately after setApiKey so it is NEVER kept in JS state
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyStatusMessage, setKeyStatusMessage] = useState<string | null>(null);

  const [ollamaInfo, setOllamaInfo] = useState<OllamaStatus>({
    running: false,
    models: [],
    install_url: "https://ollama.com/download",
  });
  const [pullProgress, setPullProgress] = useState<{
    model: string;
    pct: number;
  } | null>(null);

  const [detectedAgents, setDetectedAgents] = useState<DetectedAgent[]>([]);

  const [auth, setAuth] = useState<AuthStatus>({
    logged_in: false,
    email: null,
    tier: "free",
    status: "inactive",
    usage: 0,
    limit: 1500,
  });
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [selectedHistory, setSelectedHistory] = useState<HistoryDetail | null>(
    null,
  );
  const [copiedStepCmd, setCopiedStepCmd] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;
    if (!initialSettings) {
      getSettings()
        .then((s) => {
          if (mounted) setLocalSettings(s);
        })
        .catch(() => {});
    }

    listApiKeyProviders()
      .then((list) => {
        if (mounted) setConfiguredProviders(list);
      })
      .catch(() => {});

    ollamaStatus()
      .then((info) => {
        if (mounted) setOllamaInfo(info);
      })
      .catch(() => {});

    detectAgents()
      .then((list) => {
        if (mounted) setDetectedAgents(list);
      })
      .catch(() => {});

    authStatus()
      .then((st) => {
        if (mounted) setAuth(st);
      })
      .catch(() => {});

    historyList(50)
      .then((rows) => {
        if (mounted) setSessions(rows);
      })
      .catch(() => {});

    const unlistenPullPromise = onOllamaPullProgress((payload) => {
      if (mounted) {
        setPullProgress({ model: payload.model, pct: payload.pct });
      }
    });

    return () => {
      mounted = false;
      unlistenPullPromise.then((fn) => fn()).catch(() => {});
    };
  }, [initialSettings]);

  const updateSettings = async (patch: Partial<Settings>) => {
    const next: Settings = { ...settings, ...patch };
    setLocalSettings(next);
    onSettingsChange?.(next);
    try {
      await setSettings(next);
    } catch {
      // Ignore error in preview/test if mock doesn't handle
    }
  };

  const movePriority = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= settings.brain_priority.length) {
      return;
    }
    const list = [...settings.brain_priority];
    const [item] = list.splice(index, 1);
    list.splice(targetIndex, 0, item);
    void updateSettings({ brain_priority: list });
  };

  const handleSaveApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const rawKey = apiKeyInput.trim();
    if (!rawKey) return;
    // Immediately wipe from React state before awaiting or in finally block
    setApiKeyInput("");
    try {
      await setApiKey(selectedKeyProvider, rawKey);
      setConfiguredProviders((prev) =>
        prev.includes(selectedKeyProvider)
          ? prev
          : [...prev, selectedKeyProvider],
      );
      if (settings.byo_provider !== selectedKeyProvider) {
        void updateSettings({ byo_provider: selectedKeyProvider });
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
    setConfiguredProviders((prev) => prev.filter((p) => p !== provider));
    setKeyStatusMessage(
      `Removed ${API_PROVIDER_LABELS[provider]} key from Credential Manager.`,
    );
  };

  const handlePullOllamaModel = async (modelId: string) => {
    setPullProgress({ model: modelId, pct: 0 });
    try {
      await ollamaPull(modelId);
      setPullProgress({ model: modelId, pct: 100 });
      const refreshed = await ollamaStatus();
      setOllamaInfo(refreshed);
    } catch {
      setPullProgress(null);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginEmail.trim() || !loginPassword) return;
    const pwd = loginPassword;
    setLoginPassword("");
    try {
      const nextAuth = await authLogin(loginEmail.trim(), pwd);
      setAuth(nextAuth);
      setAuthMessage("Signed in successfully.");
    } catch (err) {
      setAuthMessage(err instanceof Error ? err.message : "Sign-in failed.");
    }
  };

  const handleLogout = async () => {
    await authLogout();
    setAuth({
      logged_in: false,
      email: null,
      tier: "free",
      status: "inactive",
      usage: 0,
      limit: 1500,
    });
    setAuthMessage("Signed out.");
  };

  const handleCheckout = async (plan: "monthly" | "annual") => {
    try {
      const res = await billingCheckout(plan);
      if (res.url) {
        await openExternalUrl(res.url);
      }
    } catch (err) {
      setAuthMessage(
        err instanceof Error ? err.message : "Unable to open checkout URL.",
      );
    }
  };

  const handleSelectSession = async (sessionId: string) => {
    try {
      const detail = await historyGet(sessionId);
      setSelectedHistory(detail);
    } catch {
      // Ignore error
    }
  };

  const usagePct =
    auth.limit > 0
      ? Math.min(100, Math.round((auth.usage / auth.limit) * 100))
      : 0;

  return (
    <div
      aria-label="GuideLens Settings and History"
      data-testid="settings-view"
      className="h-screen overflow-y-auto bg-[#121216] text-[#F4F4F5] p-5"
    >
      <div className="max-w-3xl mx-auto gl-glass-bar rounded-2xl p-5 space-y-5 shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 pb-3">
          <div>
            <h1 className="text-base font-bold text-[#F4F4F5]">
              GuideLens Settings & History
            </h1>
            <p className="text-[12px] text-[#A1A1AA]">
              Configure multi-brain routing, BYO API keys, Ollama models, Pro billing, and local history
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Settings"
              data-testid="close-settings-btn"
              className="px-2.5 py-1 rounded-md bg-white/5 text-[#A1A1AA] hover:text-[#F4F4F5] text-[12px]"
            >
              Close
            </button>
          )}
        </header>

        {/* Navigation Tabs */}
        <nav
          role="tablist"
          aria-label="Settings Sections"
          className="flex items-center gap-2 border-b border-white/10 pb-2.5"
        >
          {(
            [
              { id: "brains", label: "Brains & Models" },
              { id: "account", label: "Account & Pro ($19/mo)" },
              { id: "privacy", label: "Voice, Display & Privacy" },
              { id: "history", label: "Session History" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              data-testid={`tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${
                activeTab === tab.id
                  ? "bg-[#38BDF8] text-[#0F172A] font-semibold"
                  : "bg-white/5 text-[#A1A1AA] hover:text-[#F4F4F5]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* TAB 1: Brains, BYO Keys, Ollama, Coding Agents */}
        {activeTab === "brains" && (
          <div className="space-y-5" data-testid="panel-brains">
            {/* Brain Mode & Priority */}
            <section className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <label
                    htmlFor="brain-mode-select"
                    className="block text-[13px] font-semibold text-[#F4F4F5]"
                  >
                    Active Brain Mode
                  </label>
                  <p className="text-[11.5px] text-[#A1A1AA]">
                    Auto routes through your priority order below
                  </p>
                </div>
                <select
                  id="brain-mode-select"
                  aria-label="Active Brain Mode"
                  data-testid="brain-mode-select"
                  value={settings.brain_mode}
                  onChange={(e) =>
                    void updateSettings({
                      brain_mode: e.target.value as BrainMode,
                    })
                  }
                  className="rounded-lg bg-[#09090B] border border-white/15 px-3 py-1.5 text-[12.5px] text-[#F4F4F5]"
                >
                  <option value="auto">Auto (Follow Priority)</option>
                  <option value="local_vlm">Local (Ollama VLM)</option>
                  <option value="byo_api">BYO API Key</option>
                  <option value="groq_pro">Groq Pro Cloud</option>
                  <option value="agent_cli">Coding Agent CLI</option>
                </select>
              </div>

              <div className="space-y-1.5 pt-2 border-t border-white/10">
                <span className="block text-[12px] font-medium text-[#A1A1AA]">
                  Auto Fallback Priority Order:
                </span>
                <ul className="space-y-1" data-testid="brain-priority-list">
                  {settings.brain_priority.map((b, idx) => (
                    <li
                      key={b}
                      className="flex items-center justify-between rounded-lg bg-[#09090B]/70 px-3 py-1.5 text-[12.5px]"
                    >
                      <span>
                        {idx + 1}. {BRAIN_LABELS[b] ?? b}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => movePriority(idx, -1)}
                          disabled={idx === 0}
                          aria-label={`Move ${BRAIN_LABELS[b] ?? b} up`}
                          className="px-1.5 py-0.5 rounded bg-white/5 text-[#A1A1AA] hover:text-[#F4F4F5] disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => movePriority(idx, 1)}
                          disabled={idx === settings.brain_priority.length - 1}
                          aria-label={`Move ${BRAIN_LABELS[b] ?? b} down`}
                          className="px-1.5 py-0.5 rounded bg-white/5 text-[#A1A1AA] hover:text-[#F4F4F5] disabled:opacity-30"
                        >
                          ↓
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            {/* BYO API Keys */}
            <section
              aria-label="Bring Your Own API Keys"
              className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                    Bring Your Own API Keys (Windows Credential Manager)
                  </h2>
                  <p className="text-[11.5px] text-[#A1A1AA]">
                    Keys are stored strictly in Windows Credential Manager and cleared from memory immediately on save.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    aria-label="Active BYO Provider"
                    data-testid="active-byo-provider-select"
                    value={settings.byo_provider ?? "gemini"}
                    onChange={(e) =>
                      void updateSettings({
                        byo_provider: e.target.value as ApiProvider,
                      })
                    }
                    className="rounded-lg bg-[#09090B] border border-white/15 px-2.5 py-1 text-[12px] text-[#F4F4F5]"
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
                      void updateSettings({
                        byo_model: e.target.value.trim() ? e.target.value : null,
                      })
                    }
                    placeholder="Default model"
                    className="w-36 rounded-lg bg-[#09090B] border border-white/15 px-2.5 py-1 text-[12px] text-[#F4F4F5] placeholder-[#A1A1AA]"
                  />
                </div>
              </div>

              <form
                onSubmit={handleSaveApiKey}
                className="flex items-center gap-2"
              >
                <select
                  aria-label="Key Provider to Save"
                  data-testid="key-provider-select"
                  value={selectedKeyProvider}
                  onChange={(e) =>
                    setSelectedKeyProvider(e.target.value as ApiProvider)
                  }
                  className="rounded-lg bg-[#09090B] border border-white/15 px-2.5 py-1.5 text-[12.5px] text-[#F4F4F5]"
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
                  className="flex-1 rounded-lg bg-[#09090B] border border-white/15 px-3 py-1.5 text-[12.5px] text-[#F4F4F5]"
                />
                <button
                  type="submit"
                  data-testid="save-api-key-btn"
                  className="px-3 py-1.5 rounded-lg bg-[#38BDF8] text-[#0F172A] font-semibold text-[12.5px]"
                >
                  Save Key
                </button>
              </form>

              {keyStatusMessage && (
                <p
                  data-testid="api-key-status-msg"
                  className="text-[12px] text-[#22C55E]"
                >
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
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] border ${
                        hasKey
                          ? "bg-[#22C55E]/15 border-[#22C55E]/40 text-[#22C55E]"
                          : "bg-white/5 border-white/10 text-[#A1A1AA]"
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

            {/* Local VLM (Ollama) */}
            <section
              aria-label="Local Ollama Vision Model"
              className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                    Local Vision Model (Ollama)
                  </h2>
                  <p className="text-[11.5px] text-[#A1A1AA]">
                    Status:{" "}
                    <strong
                      data-testid="ollama-running-badge"
                      className={
                        ollamaInfo.running ? "text-[#22C55E]" : "text-amber-400"
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
                    className="px-3 py-1 rounded-lg bg-white/10 text-[#38BDF8] text-[12px]"
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
                    void updateSettings({ ollama_model: e.target.value })
                  }
                  className="flex-1 rounded-lg bg-[#09090B] border border-white/15 px-3 py-1.5 text-[12.5px] text-[#F4F4F5]"
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
                  className="px-3 py-1.5 rounded-lg bg-[#38BDF8] text-[#0F172A] font-semibold text-[12.5px]"
                >
                  Pull Model
                </button>
              </div>

              {pullProgress && (
                <div
                  data-testid="ollama-pull-progress"
                  className="space-y-1 pt-1"
                >
                  <div className="flex justify-between text-[11.5px] text-[#38BDF8]">
                    <span>Pulling {pullProgress.model}...</span>
                    <span>{pullProgress.pct}%</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-black overflow-hidden">
                    <div
                      style={{ width: `${pullProgress.pct}%` }}
                      className="h-full bg-[#38BDF8] transition-all"
                    />
                  </div>
                </div>
              )}
            </section>

            {/* Coding Agent CLIs */}
            <section
              aria-label="Detected Coding Agent CLIs"
              className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3"
            >
              <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                Coding Agent CLIs (Headless Brain Bridge)
              </h2>
              <div className="grid grid-cols-1 gap-2" data-testid="agent-cli-list">
                {ALL_AGENT_IDS.map((id) => {
                  const info = detectedAgents.find((a) => a.id === id);
                  const installed = Boolean(info?.installed);
                  return (
                    <label
                      key={id}
                      className="flex items-center justify-between rounded-lg bg-[#09090B]/80 border border-white/10 px-3 py-2 cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5">
                        <input
                          type="radio"
                          name="agent_id"
                          checked={settings.agent_id === id}
                          onChange={() => void updateSettings({ agent_id: id })}
                          aria-label={`Select ${AGENT_LABELS[id]}`}
                        />
                        <span className="text-[13px] font-medium text-[#F4F4F5]">
                          {AGENT_LABELS[id]}
                        </span>
                        {info?.path && (
                          <code className="gl-mono text-[11px] text-[#A1A1AA]">
                            {info.path}
                          </code>
                        )}
                      </div>
                      <span
                        className={`text-[11.5px] px-2 py-0.5 rounded-full ${
                          installed
                            ? "bg-[#22C55E]/15 text-[#22C55E]"
                            : "bg-white/5 text-[#A1A1AA]"
                        }`}
                      >
                        {installed ? "Detected" : "Not on PATH"}
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {/* TAB 2: Account, Usage Meter, Pro Upgrade */}
        {activeTab === "account" && (
          <div className="space-y-5" data-testid="panel-account">
            <section className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                    GuideLens Cloud Account
                  </h2>
                  <p className="text-[12px] text-[#A1A1AA]">
                    {auth.logged_in
                      ? `Signed in as ${auth.email} (${auth.tier})`
                      : "Sign in to access Groq Pro ultra-fast cloud guidance"}
                  </p>
                </div>
                {auth.logged_in && (
                  <button
                    type="button"
                    onClick={() => void handleLogout()}
                    data-testid="logout-btn"
                    className="px-3 py-1 rounded bg-white/10 text-[#F4F4F5] text-[12px]"
                  >
                    Sign Out
                  </button>
                )}
              </div>

              {!auth.logged_in && (
                <form
                  onSubmit={handleLogin}
                  className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1"
                >
                  <input
                    type="email"
                    aria-label="Account Email"
                    data-testid="login-email-input"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="rounded-lg bg-[#09090B] border border-white/15 px-3 py-1.5 text-[12.5px] text-[#F4F4F5]"
                  />
                  <input
                    type="password"
                    autoComplete="off"
                    aria-label="Account Password"
                    data-testid="login-password-input"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Password"
                    className="rounded-lg bg-[#09090B] border border-white/15 px-3 py-1.5 text-[12.5px] text-[#F4F4F5]"
                  />
                  <button
                    type="submit"
                    data-testid="login-submit-btn"
                    className="rounded-lg bg-[#38BDF8] text-[#0F172A] font-semibold text-[12.5px] px-3 py-1.5"
                  >
                    Sign In
                  </button>
                </form>
              )}

              {authMessage && (
                <p className="text-[12px] text-[#38BDF8]">{authMessage}</p>
              )}
            </section>

            {/* Usage Meter */}
            <section
              aria-label="Groq Pro Usage Meter"
              data-testid="usage-meter-section"
              className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-2"
            >
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-semibold text-[#F4F4F5]">
                  Monthly Groq Pro Fair-Use Quota
                </span>
                <span data-testid="usage-count-text" className="text-[#38BDF8]">
                  {auth.usage} / {auth.limit} requests
                </span>
              </div>
              <div className="w-full h-2.5 rounded-full bg-[#09090B] overflow-hidden">
                <div
                  style={{ width: `${usagePct}%` }}
                  className="h-full bg-[#38BDF8] transition-all"
                />
              </div>
              <p className="text-[11.5px] text-[#A1A1AA]">
                Includes 1,500 Groq vision requests/month (up to 20 req/min). Local VLM and BYO API keys remain unlimited and free.
              </p>
            </section>

            {/* Upgrade Cards: $19/mo and $190/yr */}
            <section
              aria-label="Upgrade to GuideLens Pro"
              className="grid grid-cols-1 sm:grid-cols-2 gap-3"
            >
              <div className="rounded-xl bg-white/5 border border-white/15 p-4 flex flex-col justify-between space-y-3">
                <div>
                  <h3 className="text-[14px] font-bold text-[#F4F4F5]">
                    Pro Monthly — $19/mo
                  </h3>
                  <p className="text-[12px] text-[#A1A1AA] mt-1">
                    Instant Groq cloud vision & OCR (&lt;2s latency), 1,500 requests/month.
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="upgrade-monthly-btn"
                  onClick={() => void handleCheckout("monthly")}
                  className="w-full py-2 rounded-lg bg-[#38BDF8] text-[#0F172A] font-semibold text-[12.5px]"
                >
                  Upgrade Monthly ($19/mo)
                </button>
              </div>

              <div className="rounded-xl bg-[#38BDF8]/10 border border-[#38BDF8]/50 p-4 flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-[14px] font-bold text-[#F4F4F5]">
                      Pro Annual — $190/yr
                    </h3>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#38BDF8] text-[#0F172A]">
                      Save 2 Months
                    </span>
                  </div>
                  <p className="text-[12px] text-[#A1A1AA] mt-1">
                    Full Groq Pro speed billed annually ($15.83/mo effective).
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="upgrade-annual-btn"
                  onClick={() => void handleCheckout("annual")}
                  className="w-full py-2 rounded-lg bg-[#38BDF8] text-[#0F172A] font-semibold text-[12.5px]"
                >
                  Upgrade Annual ($190/yr)
                </button>
              </div>
            </section>
          </div>
        )}

        {/* TAB 3: Voice, Accessibility, Capture Retention & Privacy */}
        {activeTab === "privacy" && (
          <div className="space-y-4" data-testid="panel-privacy">
            <section className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3">
              <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                Voice & Accessibility
              </h2>

              <div className="flex items-center justify-between">
                <label
                  htmlFor="stt-engine-select"
                  className="text-[12.5px] text-[#F4F4F5]"
                >
                  Speech-to-Text (STT) Engine
                </label>
                <select
                  id="stt-engine-select"
                  aria-label="Speech-to-Text Engine"
                  data-testid="stt-engine-select"
                  value={settings.stt_engine}
                  onChange={(e) =>
                    void updateSettings({
                      stt_engine: e.target.value as SttEngine,
                    })
                  }
                  className="rounded-lg bg-[#09090B] border border-white/15 px-3 py-1.5 text-[12.5px] text-[#F4F4F5]"
                >
                  <option value="web_speech">
                    Web Speech API (Default — Zero Overhead)
                  </option>
                  <option value="whisper_cpp">
                    Local whisper.cpp (Offline)
                  </option>
                  <option value="cloud">
                    Cloud Whisper (Groq / OpenAI BYO Key)
                  </option>
                </select>
              </div>

              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-[12.5px] text-[#F4F4F5]">
                  High-Contrast Overlay (#FACC15 Yellow Border & Badge)
                </span>
                <input
                  type="checkbox"
                  data-testid="high-contrast-checkbox"
                  checked={settings.high_contrast}
                  onChange={(e) =>
                    void updateSettings({ high_contrast: e.target.checked })
                  }
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-[12.5px] text-[#F4F4F5]">
                  Always Show 2.5× Magnifier Lens
                </span>
                <input
                  type="checkbox"
                  data-testid="always-magnify-checkbox"
                  checked={settings.always_magnify}
                  onChange={(e) =>
                    void updateSettings({ always_magnify: e.target.checked })
                  }
                />
              </label>
            </section>

            <section className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3">
              <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                Screen Capture Retention & Privacy
              </h2>

              <div className="flex items-center justify-between">
                <label
                  htmlFor="retention-days-input"
                  className="text-[12.5px] text-[#F4F4F5]"
                >
                  Auto-prune local screenshots older than (days):
                </label>
                <input
                  id="retention-days-input"
                  type="number"
                  min={1}
                  max={90}
                  data-testid="retention-days-input"
                  value={settings.capture_retention_days}
                  onChange={(e) =>
                    void updateSettings({
                      capture_retention_days: Math.max(
                        1,
                        Number(e.target.value) || 7,
                      ),
                    })
                  }
                  className="w-20 rounded-lg bg-[#09090B] border border-white/15 px-2.5 py-1 text-[12.5px] text-[#F4F4F5]"
                />
              </div>

              <p className="text-[12px] text-[#A1A1AA] leading-relaxed">
                <strong>Privacy Disclaimer:</strong> GuideLens captures full-screen screenshots when summoned. Local SQLite history and screenshots stay in{" "}
                <code className="gl-mono text-[11px]">%LOCALAPPDATA%\GuideLens\</code>. Close sensitive windows (banking, password managers,{" "}
                <code className="gl-mono text-[11px]">.env</code> files) before triggering Cloud Pro, BYO API, or external Agent modes. Cloud Pro holds screenshots in memory only for the duration of the Groq API call and never stores them on disk.
              </p>
            </section>
          </div>
        )}

        {/* TAB 4: Local SQLite History */}
        {activeTab === "history" && (
          <div className="space-y-4" data-testid="panel-history">
            {sessions.length === 0 ? (
              <p className="text-[13px] text-[#A1A1AA] py-6 text-center">
                No guided sessions recorded in local SQLite yet.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <ul
                  aria-label="Session History List"
                  data-testid="history-session-list"
                  className="space-y-2 max-h-96 overflow-y-auto pr-1"
                >
                  {sessions.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => void handleSelectSession(s.id)}
                        data-testid={`history-item-${s.id}`}
                        className={`w-full text-left rounded-xl p-3 border transition-colors ${
                          selectedHistory?.session.id === s.id
                            ? "bg-[#38BDF8]/15 border-[#38BDF8]"
                            : "bg-white/5 border-white/10 hover:bg-white/10"
                        }`}
                      >
                        <div className="flex items-center justify-between text-[11.5px] text-[#A1A1AA]">
                          <span className="font-mono text-[#38BDF8]">
                            {s.active_app}
                          </span>
                          <span>{BRAIN_LABELS[s.brain_used] ?? s.brain_used}</span>
                        </div>
                        <div className="text-[13px] font-medium text-[#F4F4F5] mt-1 truncate">
                          {s.user_query}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>

                <div
                  data-testid="history-session-detail"
                  className="rounded-xl bg-white/5 border border-white/10 p-3.5 space-y-2.5"
                >
                  {selectedHistory ? (
                    <>
                      <h3 className="text-[13px] font-semibold text-[#F4F4F5]">
                        {selectedHistory.session.user_query}
                      </h3>
                      <ol className="space-y-2 text-[12.5px]">
                        {selectedHistory.steps.map((st) => (
                          <li
                            key={st.step_number}
                            className="rounded-lg bg-[#09090B] p-2.5 space-y-1.5 border border-white/10"
                          >
                            <div>
                              <span className="text-[#38BDF8] font-semibold mr-1.5">
                                Step {st.step_number}:
                              </span>
                              <span>{st.instruction_line}</span>
                            </div>
                            {st.terminal_command && (
                              <div className="flex items-center justify-between gap-2 bg-black px-2.5 py-1.5 rounded border border-white/10">
                                <code className="gl-mono text-[#F4F4F5] truncate">
                                  {st.terminal_command}
                                </code>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    await copyToClipboard(st.terminal_command!);
                                    setCopiedStepCmd(st.step_number);
                                    window.setTimeout(
                                      () => setCopiedStepCmd(null),
                                      2000,
                                    );
                                  }}
                                  className={`px-2 py-0.5 rounded text-[11px] ${
                                    copiedStepCmd === st.step_number
                                      ? "bg-[#22C55E]/20 text-[#22C55E]"
                                      : "bg-white/10 text-[#F4F4F5]"
                                  }`}
                                >
                                  {copiedStepCmd === st.step_number
                                    ? "Copied!"
                                    : "Copy"}
                                </button>
                              </div>
                            )}
                          </li>
                        ))}
                      </ol>
                    </>
                  ) : (
                    <p className="text-[12.5px] text-[#A1A1AA]">
                      Select a session on the left to inspect its steps.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
