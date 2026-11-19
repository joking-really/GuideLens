import React, { useEffect, useState } from "react";
import {
  detectAgents,
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
  type BrainMode,
  type DetectedAgent,
  OLLAMA_MODELS,
  type OllamaStatus,
  type Settings,
} from "../types";

export interface OnboardingViewProps {
  settings: Settings;
  onComplete: (updated: Settings) => void;
}

export const OnboardingView: React.FC<OnboardingViewProps> = ({
  settings,
  onComplete,
}) => {
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [selectedBrainMode, setSelectedBrainMode] = useState<BrainMode>(
    settings.brain_mode,
  );
  const [byoProvider, setByoProvider] = useState<ApiProvider>(
    settings.byo_provider ?? "gemini",
  );
  // Ephemeral input state cleared immediately on save (never persisted in JS state)
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keySavedProvider, setKeySavedProvider] = useState<ApiProvider | null>(
    null,
  );
  const [ollamaInfo, setOllamaInfo] = useState<OllamaStatus | null>(null);
  const [pullPct, setPullPct] = useState<number | null>(null);
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentId>(
    settings.agent_id ?? "claude",
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    ollamaStatus()
      .then((st) => {
        if (mounted) setOllamaInfo(st);
      })
      .catch(() => {});

    detectAgents()
      .then((list) => {
        if (!mounted) return;
        setAgents(list);
        const firstInstalled = list.find((a) => a.installed);
        if (firstInstalled) {
          setSelectedAgent(firstInstalled.id);
        }
      })
      .catch(() => {});

    const unlistenPromise = onOllamaPullProgress((prog) => {
      if (mounted) {
        setPullPct(prog.pct);
      }
    });

    return () => {
      mounted = false;
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const handleSaveByoKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;
    // Clear key from JS state immediately before saving to Windows Credential Manager
    setApiKeyInput("");
    await setApiKey(byoProvider, trimmed);
    setKeySavedProvider(byoProvider);
  };

  const handlePullModel = async () => {
    setPullPct(0);
    try {
      await ollamaPull(settings.ollama_model || OLLAMA_MODELS[0].id);
      setPullPct(100);
    } catch {
      setPullPct(null);
    }
  };

  const handleFinish = async () => {
    if (!privacyAccepted) return;
    setSaving(true);
    try {
      const pendingKey = apiKeyInput.trim();
      setApiKeyInput("");
      if (pendingKey) {
        await setApiKey(byoProvider, pendingKey);
      }
      const updated: Settings = {
        ...settings,
        brain_mode: selectedBrainMode,
        byo_provider: byoProvider,
        agent_id: selectedAgent,
        onboarding_complete: true,
      };
      await setSettings(updated);
      onComplete(updated);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main
      aria-label="GuideLens First-Run Onboarding"
      data-testid="onboarding-view"
      className="h-screen overflow-y-auto bg-[#121216] text-[#F4F4F5] p-6 flex flex-col items-center justify-start"
    >
      <div className="w-full max-w-xl gl-glass-bar rounded-2xl p-6 space-y-5 shadow-2xl">
        <header className="space-y-1">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold tracking-tight text-[#F4F4F5]">
              Welcome to GuideLens
            </h1>
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#38BDF8]/20 text-[#38BDF8]">
              Windows AI Copilot
            </span>
          </div>
          <p className="text-[13px] text-[#A1A1AA]">
            Press <kbd className="gl-mono px-1.5 py-0.5 rounded bg-white/10 text-[#F4F4F5]">Ctrl + Space</kbd> anytime to summon on-screen visual guidance.
          </p>
        </header>

        {/* Upfront Privacy Disclaimer per security.md §3 */}
        <section
          aria-label="Privacy Disclaimer"
          data-testid="privacy-disclaimer-banner"
          className="rounded-xl bg-[#09090B]/90 border border-[#38BDF8]/30 p-4 space-y-2"
        >
          <h2 className="text-[13px] font-semibold text-[#38BDF8] flex items-center gap-1.5">
            <span>Screen Capture & Privacy Notice</span>
          </h2>
          <p className="text-[12.5px] text-[#F4F4F5] leading-relaxed">
            GuideLens captures a full-screen screenshot of your active monitor only when you ask a question. Local screenshots and session history stay strictly on your PC in{" "}
            <code className="gl-mono text-[11.5px] text-[#38BDF8]">
              %LOCALAPPDATA%\GuideLens\
            </code>{" "}
            and are auto-pruned after {settings.capture_retention_days} days.
          </p>
          <p className="text-[12px] text-[#A1A1AA] leading-relaxed">
            <strong>Important:</strong> Please close sensitive windows (banking, password managers,{" "}
            <code className="gl-mono text-[11px]">.env</code> files) before triggering Cloud Pro, BYO API, or external Agent modes. On Cloud Pro, screenshots are held in memory only for the duration of the Groq API call and immediately discarded—never stored on remote servers.
          </p>
          <label className="pt-1 flex items-center gap-2 cursor-pointer select-none text-[12.5px] font-medium text-[#F4F4F5]">
            <input
              type="checkbox"
              checked={privacyAccepted}
              onChange={(e) => setPrivacyAccepted(e.target.checked)}
              data-testid="privacy-accept-checkbox"
              className="rounded border-white/20 bg-black text-[#38BDF8] focus:ring-[#38BDF8]"
            />
            <span>I understand how screen captures are processed</span>
          </label>
        </section>

        {/* Brain Setup Selection */}
        <section aria-label="Choose Your Brain Setup" className="space-y-3">
          <h2 className="text-[13px] font-semibold text-[#F4F4F5]">
            Choose Your AI Brain Mode
          </h2>

          <div className="grid grid-cols-2 gap-2.5">
            {(
              [
                {
                  mode: "auto",
                  title: "Auto (Recommended)",
                  desc: "Agent CLI → BYO Key → Groq Pro → Local Ollama",
                },
                {
                  mode: "local_vlm",
                  title: "Local VLM (Free)",
                  desc: "100% offline via Ollama (qwen2.5vl:3b)",
                },
                {
                  mode: "byo_api",
                  title: "BYO API Key (Free)",
                  desc: "Use your Gemini, OpenAI, Anthropic, Groq, or OpenRouter key",
                },
                {
                  mode: "agent_cli",
                  title: "Coding Agent CLI",
                  desc: "Claude Code, Antigravity, Codex, Gemini CLI, Hermes",
                },
              ] as const
            ).map((opt) => (
              <button
                key={opt.mode}
                type="button"
                onClick={() => setSelectedBrainMode(opt.mode)}
                data-testid={`onboarding-brain-${opt.mode}`}
                className={`text-left p-3 rounded-xl border transition-colors ${
                  selectedBrainMode === opt.mode
                    ? "bg-[#38BDF8]/15 border-[#38BDF8] text-[#F4F4F5]"
                    : "bg-white/5 border-white/10 text-[#A1A1AA] hover:text-[#F4F4F5]"
                }`}
              >
                <div className="text-[13px] font-semibold text-[#F4F4F5]">
                  {opt.title}
                </div>
                <div className="text-[11.5px] text-[#A1A1AA] mt-0.5">
                  {opt.desc}
                </div>
              </button>
            ))}
          </div>

          {selectedBrainMode === "local_vlm" && (
            <div className="rounded-xl bg-white/5 border border-white/10 p-3 space-y-2 text-[12.5px]">
              <div className="flex items-center justify-between">
                <span>
                  Ollama Status:{" "}
                  <strong className={ollamaInfo?.running ? "text-[#22C55E]" : "text-amber-400"}>
                    {ollamaInfo?.running ? "Running" : "Not detected"}
                  </strong>
                </span>
                {!ollamaInfo?.running ? (
                  <button
                    type="button"
                    onClick={() =>
                      openExternalUrl(
                        ollamaInfo?.install_url || "https://ollama.com/download",
                      )
                    }
                    className="text-[#38BDF8] underline"
                  >
                    Download Ollama
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handlePullModel}
                    data-testid="onboarding-pull-ollama"
                    className="px-2.5 py-1 rounded bg-[#38BDF8] text-[#0F172A] font-semibold text-[12px]"
                  >
                    Pull qwen2.5vl:3b
                  </button>
                )}
              </div>
              {pullPct !== null && (
                <div className="text-[11.5px] text-[#38BDF8]">
                  Pulling model: {pullPct}%
                </div>
              )}
            </div>
          )}

          {selectedBrainMode === "byo_api" && (
            <div className="rounded-xl bg-white/5 border border-white/10 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <label htmlFor="onboarding-byo-provider" className="sr-only">
                  API Provider
                </label>
                <select
                  id="onboarding-byo-provider"
                  value={byoProvider}
                  onChange={(e) => setByoProvider(e.target.value as ApiProvider)}
                  className="rounded bg-[#09090B] border border-white/15 px-2.5 py-1.5 text-[12.5px] text-[#F4F4F5]"
                >
                  {(Object.keys(API_PROVIDER_LABELS) as ApiProvider[]).map(
                    (p) => (
                      <option key={p} value={p}>
                        {API_PROVIDER_LABELS[p]}
                      </option>
                    ),
                  )}
                </select>
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={`Paste ${API_PROVIDER_LABELS[byoProvider]} API key...`}
                  aria-label="BYO API Key"
                  className="flex-1 rounded bg-[#09090B] border border-white/15 px-2.5 py-1.5 text-[12.5px] text-[#F4F4F5]"
                />
                <button
                  type="button"
                  onClick={handleSaveByoKey}
                  className="px-3 py-1.5 rounded bg-[#38BDF8] text-[#0F172A] font-semibold text-[12px]"
                >
                  Save Key
                </button>
              </div>
              {keySavedProvider && (
                <p className="text-[11.5px] text-[#22C55E]">
                  Stored {API_PROVIDER_LABELS[keySavedProvider]} key in Windows Credential Manager.
                </p>
              )}
            </div>
          )}

          {selectedBrainMode === "agent_cli" && (
            <div className="rounded-xl bg-white/5 border border-white/10 p-3 space-y-2">
              <label
                htmlFor="onboarding-agent-select"
                className="block text-[12px] text-[#A1A1AA]"
              >
                Preferred Coding Agent CLI:
              </label>
              <select
                id="onboarding-agent-select"
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value as AgentId)}
                className="w-full rounded bg-[#09090B] border border-white/15 px-2.5 py-1.5 text-[12.5px] text-[#F4F4F5]"
              >
                {(Object.keys(AGENT_LABELS) as AgentId[]).map((id) => {
                  const found = agents.find((a) => a.id === id);
                  return (
                    <option key={id} value={id}>
                      {AGENT_LABELS[id]}{" "}
                      {found?.installed ? "(Installed)" : ""}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
        </section>

        <footer className="pt-2 flex items-center justify-end">
          <button
            type="button"
            disabled={!privacyAccepted || saving}
            onClick={handleFinish}
            data-testid="onboarding-finish-btn"
            className={`px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors ${
              privacyAccepted
                ? "bg-[#38BDF8] text-[#0F172A] hover:bg-[#38BDF8]/90"
                : "bg-white/10 text-[#A1A1AA] cursor-not-allowed"
            }`}
          >
            {saving ? "Saving..." : "Start Using GuideLens"}
          </button>
        </footer>
      </div>
    </main>
  );
};
