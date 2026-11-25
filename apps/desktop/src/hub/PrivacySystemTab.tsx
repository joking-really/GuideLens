import React, { useEffect, useRef, useState } from "react";
import {
  authLogin,
  authLogout,
  billingCheckout,
  openExternalUrl,
} from "../lib/ipc";
import type { AuthStatus, Settings, SttEngine } from "../types";

export interface PrivacySystemTabProps {
  settings: Settings;
  onUpdateSettings: (patch: Partial<Settings>) => Promise<void> | void;
  auth: AuthStatus;
  onAuthChange: (next: AuthStatus) => void;
  onOpenCompanionsVoice: () => void;
  focusAccountSeq?: number;
}

const DEFAULT_BLOCKED_PREVIEW = [
  "1Password",
  "Bitwarden",
  "KeePass",
  "Windows Credential Prompt",
  "Incognito / InPrivate",
];

export const PrivacySystemTab: React.FC<PrivacySystemTabProps> = ({
  settings,
  onUpdateSettings,
  auth,
  onAuthChange,
  onOpenCompanionsVoice,
  focusAccountSeq = 0,
}) => {
  const [excludedAppInput, setExcludedAppInput] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const accountSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusAccountSeq > 0) {
      accountSectionRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [focusAccountSeq]);

  const handleAddExcludedApp = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = excludedAppInput.trim();
    if (!trimmed) return;
    setExcludedAppInput("");
    if (
      settings.screenday_excluded_apps.some(
        (a) => a.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      return;
    }
    void onUpdateSettings({
      screenday_excluded_apps: [...settings.screenday_excluded_apps, trimmed],
    });
  };

  const handleRemoveExcludedApp = (target: string) => {
    void onUpdateSettings({
      screenday_excluded_apps: settings.screenday_excluded_apps.filter(
        (a) => a !== target,
      ),
    });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginEmail.trim() || !loginPassword) return;
    const pwd = loginPassword;
    setLoginPassword("");
    try {
      const nextAuth = await authLogin(loginEmail.trim(), pwd);
      onAuthChange(nextAuth);
      setAuthMessage("Signed in.");
    } catch (err) {
      setAuthMessage(err instanceof Error ? err.message : "Sign-in failed.");
    }
  };

  const handleLogout = async () => {
    await authLogout();
    onAuthChange({
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

  const usagePct =
    auth.limit > 0
      ? Math.min(100, Math.round((auth.usage / auth.limit) * 100))
      : 0;

  return (
    <div className="space-y-5" data-testid="panel-privacy">
      {/* Privacy Shield Settings */}
      <section className="rounded-xl bg-[#111317] border border-white/[0.07] divide-y divide-white/[0.06]">
        <div className="px-5 py-4 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
              Privacy Shield
            </h2>
            <p className="text-[12px] text-[#8E929B] mt-0.5">
              Pause capture automatically on password managers and private browsers
            </p>
          </div>
          <input
            type="checkbox"
            aria-label="Block password managers and incognito"
            data-testid="screenday-skip-private-checkbox"
            checked={settings.screenday_skip_private}
            onChange={(e) =>
              void onUpdateSettings({
                screenday_skip_private: e.target.checked,
              })
            }
            className="accent-[#F4F4F5]"
          />
        </div>

        {settings.screenday_skip_private && (
          <div className="px-5 py-3 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-[#5C606A] mr-1">Auto-blocked:</span>
            {DEFAULT_BLOCKED_PREVIEW.map((item) => (
              <span
                key={item}
                className="px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.07] text-[#8E929B]"
              >
                {item}
              </span>
            ))}
          </div>
        )}

        {/* Excluded Apps */}
        <div className="px-5 py-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <label
                htmlFor="excluded-app-input"
                className="block text-[12.5px] font-medium text-[#F4F4F5]"
              >
                Excluded Apps
              </label>
              <span className="text-[11.5px] text-[#8E929B]">
                Process names or window title keywords never captured
              </span>
            </div>
          </div>

          <form onSubmit={handleAddExcludedApp} className="flex items-center gap-2">
            <input
              id="excluded-app-input"
              type="text"
              data-testid="excluded-app-input"
              value={excludedAppInput}
              onChange={(e) => setExcludedAppInput(e.target.value)}
              placeholder="e.g., bank, keepass.exe, signal.exe"
              className="flex-1 rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-[#F4F4F5] placeholder-[#5C606A] focus:outline-none focus:border-white/25"
            />
            <button
              type="submit"
              data-testid="add-excluded-app-btn"
              className="px-3.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[12px] font-medium text-[#E4E4E7] transition-colors"
            >
              Add
            </button>
          </form>

          <div className="flex flex-wrap gap-1.5">
            {settings.screenday_excluded_apps.length === 0 ? (
              <span className="text-[11.5px] text-[#5C606A]">
                No custom exclusions configured.
              </span>
            ) : (
              settings.screenday_excluded_apps.map((app) => (
                <span
                  key={app}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#0A0B0D] border border-white/[0.08] text-[11.5px] font-mono text-[#E4E4E7]"
                >
                  {app}
                  <button
                    type="button"
                    aria-label={`Remove ${app}`}
                    onClick={() => handleRemoveExcludedApp(app)}
                    className="text-[#5C606A] hover:text-[#F4F4F5] text-xs"
                  >
                    ✕
                  </button>
                </span>
              ))
            )}
          </div>
        </div>

        {/* Capture Cadence Row */}
        <div className="px-5 py-3.5 flex items-center justify-between gap-4">
          <div>
            <label
              htmlFor="screenday-interval-slider"
              className="block text-[12.5px] font-medium text-[#F4F4F5]"
            >
              Capture Cadence
            </label>
            <span className="text-[11.5px] text-[#8E929B]">
              Minimum interval between Screen Day frames
            </span>
          </div>
          <div className="flex items-center gap-3 w-52">
            <input
              id="screenday-interval-slider"
              data-testid="screenday-interval-slider"
              type="range"
              min={5}
              max={60}
              step={5}
              value={settings.screenday_interval_sec}
              onChange={(e) =>
                void onUpdateSettings({
                  screenday_interval_sec: Number(e.target.value),
                })
              }
              className="flex-1 h-1 accent-[#F4F4F5]"
            />
            <span
              data-testid="screenday-interval-value"
              className="font-mono text-[12px] text-[#F4F4F5] w-8 text-right"
            >
              {settings.screenday_interval_sec}s
            </span>
          </div>
        </div>

        {/* Retention Days Row */}
        <div className="px-5 py-3.5 flex items-center justify-between gap-4">
          <div>
            <label
              htmlFor="retention-days-input"
              className="block text-[12.5px] font-medium text-[#F4F4F5]"
            >
              Local Retention (Days)
            </label>
            <span className="text-[11.5px] text-[#8E929B]">
              Auto-prune frames and memories stored in %LOCALAPPDATA%\GuideLens\
            </span>
          </div>
          <input
            id="retention-days-input"
            type="number"
            min={1}
            max={90}
            data-testid="retention-days-input"
            value={settings.capture_retention_days}
            onChange={(e) =>
              void onUpdateSettings({
                capture_retention_days: Math.max(
                  1,
                  Number(e.target.value) || 7,
                ),
              })
            }
            className="w-20 rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-2.5 py-1.5 text-[12.5px] font-mono text-[#F4F4F5]"
          />
        </div>
      </section>

      {/* Voice, Accessibility & Hotkeys */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-xl bg-[#111317] border border-white/[0.07] divide-y divide-white/[0.06]">
          <div className="px-5 py-3.5 flex items-center justify-between gap-2">
            <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
              Voice &amp; Accessibility
            </h2>
            <button
              type="button"
              data-testid="open-voice-studio-btn"
              onClick={onOpenCompanionsVoice}
              className="px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#E4E4E7] text-[11.5px] font-medium transition-colors"
            >
              Voice Studio →
            </button>
          </div>

          <div className="px-5 py-3.5 flex items-center justify-between gap-3">
            <label
              htmlFor="stt-engine-select"
              className="text-[12.5px] text-[#F4F4F5]"
            >
              Speech-to-Text
            </label>
            <select
              id="stt-engine-select"
              aria-label="Speech-to-Text Engine"
              data-testid="stt-engine-select"
              value={settings.stt_engine}
              onChange={(e) =>
                void onUpdateSettings({
                  stt_engine: e.target.value as SttEngine,
                })
              }
              className="rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-2.5 py-1.5 text-[12px] text-[#F4F4F5]"
            >
              <option value="web_speech">Web Speech API (Default)</option>
              <option value="whisper_cpp">Local whisper.cpp</option>
              <option value="cloud">Cloud Whisper (BYO Key)</option>
            </select>
          </div>

          <label className="px-5 py-3.5 flex items-center justify-between gap-3 cursor-pointer">
            <div>
              <span className="block text-[12.5px] text-[#F4F4F5]">
                High-Contrast Overlay
              </span>
              <span className="block text-[11.5px] text-[#8E929B]">
                Use #FACC15 yellow border &amp; badge on screen targets
              </span>
            </div>
            <input
              type="checkbox"
              data-testid="high-contrast-checkbox"
              checked={settings.high_contrast}
              onChange={(e) =>
                void onUpdateSettings({ high_contrast: e.target.checked })
              }
              className="accent-[#F4F4F5]"
            />
          </label>

          <label className="px-5 py-3.5 flex items-center justify-between gap-3 cursor-pointer">
            <div>
              <span className="block text-[12.5px] text-[#F4F4F5]">
                Always Show 2.5× Magnifier
              </span>
              <span className="block text-[11.5px] text-[#8E929B]">
                Render zoom lens beside active target box
              </span>
            </div>
            <input
              type="checkbox"
              data-testid="always-magnify-checkbox"
              checked={settings.always_magnify}
              onChange={(e) =>
                void onUpdateSettings({ always_magnify: e.target.checked })
              }
              className="accent-[#F4F4F5]"
            />
          </label>
        </section>

        {/* Keyboard Shortcuts Table */}
        <section
          data-testid="keyboard-shortcuts-section"
          className="rounded-xl bg-[#111317] border border-white/[0.07] divide-y divide-white/[0.06]"
        >
          <div className="px-5 py-3.5">
            <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
              Keyboard Shortcuts
            </h2>
          </div>
          {(
            [
              {
                keys: "Ctrl + Space",
                desc: "Toggle top bar (companion remains active)",
              },
              {
                keys: "Ctrl + Alt + H",
                desc: "Hide / show top bar (Companion-only mode)",
              },
              {
                keys: "Ctrl + Alt + M",
                desc: "Toggle Mic On / Off",
              },
              {
                keys: "Ctrl + Alt + L",
                desc: "Toggle Live Guidance Session",
              },
              {
                keys: "Ctrl + Alt + D",
                desc: "Toggle Screen Day Recording",
              },
              {
                keys: "Ctrl + Alt + O",
                desc: "Switch to Use Local (Ollama)",
              },
              {
                keys: "Ctrl + Alt + A",
                desc: "Switch to Use Agent (Claude / Codex / Gemini)",
              },
              {
                keys: "Esc",
                desc: "Dismiss active step highlight",
              },
            ] as const
          ).map((hk) => (
            <div
              key={hk.keys}
              className="px-5 py-3 flex items-center justify-between gap-3 text-[12px]"
            >
              <span className="text-[#8E929B]">{hk.desc}</span>
              <kbd className="shrink-0 px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.08] font-mono text-[11px] text-[#E4E4E7]">
                {hk.keys}
              </kbd>
            </div>
          ))}
        </section>
      </div>

      {/* GuideLens Cloud Account */}
      <div
        id="account-billing"
        ref={accountSectionRef}
        data-testid="panel-account"
        className="space-y-4"
      >
        <section className="rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                GuideLens Cloud Account
              </h2>
              <p className="text-[12px] text-[#8E929B] mt-0.5">
                {auth.logged_in
                  ? `Signed in as ${auth.email} (${auth.tier})`
                  : "Optional cloud sync and Groq Pro routing"}
              </p>
            </div>
            {auth.logged_in && (
              <button
                type="button"
                onClick={() => void handleLogout()}
                data-testid="logout-btn"
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#E4E4E7] text-[12px]"
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
                className="rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-[#F4F4F5] placeholder-[#5C606A]"
              />
              <input
                type="password"
                autoComplete="off"
                aria-label="Account Password"
                data-testid="login-password-input"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="Password"
                className="rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-[#F4F4F5] placeholder-[#5C606A]"
              />
              <button
                type="submit"
                data-testid="login-submit-btn"
                className="rounded-lg bg-[#F4F4F5] hover:bg-white text-[#0A0B0D] font-medium text-[12.5px] px-3 py-1.5 transition-colors"
              >
                Sign In
              </button>
            </form>
          )}

          {authMessage && (
            <p className="text-[12px] text-[#8E929B]">{authMessage}</p>
          )}
        </section>

        {/* Usage Meter */}
        <section
          aria-label="Groq Pro Usage Meter"
          data-testid="usage-meter-section"
          className="rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-2.5"
        >
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="font-medium text-[#F4F4F5]">
              Monthly Cloud Quota
            </span>
            <span
              data-testid="usage-count-text"
              className="text-[#8E929B] font-mono"
            >
              {auth.usage} / {auth.limit} requests
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-[#0A0B0D] overflow-hidden">
            <div
              style={{ width: `${usagePct}%` }}
              className="h-full bg-[#F4F4F5] transition-all"
            />
          </div>
          <p className="text-[11.5px] text-[#5C606A]">
            Local Ollama, Subscription CLIs, and BYO API keys remain unlimited.
          </p>
        </section>

        {/* Upgrade Cards */}
        <section
          aria-label="Upgrade to GuideLens Pro"
          className="grid grid-cols-1 sm:grid-cols-2 gap-3"
        >
          <div className="rounded-xl bg-[#111317] border border-white/[0.07] p-4 flex flex-col justify-between space-y-3">
            <div>
              <h3 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                Pro Monthly — $19/mo
              </h3>
              <p className="text-[12px] text-[#8E929B] mt-1">
                Groq cloud vision &amp; OCR, 1,500 requests/month.
              </p>
            </div>
            <button
              type="button"
              data-testid="upgrade-monthly-btn"
              onClick={() => void handleCheckout("monthly")}
              className="w-full py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#E4E4E7] font-medium text-[12.5px] transition-colors"
            >
              Upgrade Monthly ($19/mo)
            </button>
          </div>

          <div className="rounded-xl bg-[#111317] border border-white/[0.15] p-4 flex flex-col justify-between space-y-3">
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                  Pro Annual — $190/yr
                </h3>
                <span className="px-2 py-0.5 rounded text-[10.5px] font-medium bg-white/[0.06] border border-white/[0.08] text-[#E4E4E7]">
                  Save 2 Months
                </span>
              </div>
              <p className="text-[12px] text-[#8E929B] mt-1">
                Full Groq Pro speed billed annually.
              </p>
            </div>
            <button
              type="button"
              data-testid="upgrade-annual-btn"
              onClick={() => void handleCheckout("annual")}
              className="w-full py-1.5 rounded-lg bg-[#F4F4F5] hover:bg-white text-[#0A0B0D] font-medium text-[12.5px] transition-colors"
            >
              Upgrade Annual ($190/yr)
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
