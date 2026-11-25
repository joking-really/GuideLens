import React, { useEffect, useRef, useState } from "react";
import {
  authLogin,
  authLogout,
  billingCheckout,
  openExternalUrl,
} from "../lib/ipc";
import type { AuthStatus, Settings, SttEngine } from "../types";
import { KeyboardIcon, ShieldIcon, UserIcon } from "./HubIcons";

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
      setAuthMessage("Signed in successfully.");
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
      {/* Screen Day Privacy Shield */}
      <section className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-amber-500/15 border border-amber-400/30 flex items-center justify-center text-amber-300">
              <ShieldIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-[14px] font-semibold text-zinc-100">
                Screen Day Privacy Shield
              </h2>
              <p className="text-[11.5px] text-zinc-400">
                Automatically pauses frame capture on sensitive windows and respects custom app exclusions
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer text-[12.5px] font-medium text-zinc-200">
            <input
              type="checkbox"
              data-testid="screenday-skip-private-checkbox"
              checked={settings.screenday_skip_private}
              onChange={(e) =>
                void onUpdateSettings({
                  screenday_skip_private: e.target.checked,
                })
              }
            />
            Block password managers &amp; incognito
          </label>
        </div>

        {settings.screenday_skip_private && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-zinc-500 mr-1">Auto-blocked:</span>
            {DEFAULT_BLOCKED_PREVIEW.map((item) => (
              <span
                key={item}
                className="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-400/25 text-amber-200"
              >
                {item}
              </span>
            ))}
          </div>
        )}

        {/* Excluded Apps Editable Chips */}
        <div className="space-y-2 pt-2 border-t border-white/[0.07]">
          <label
            htmlFor="excluded-app-input"
            className="block text-[12px] font-medium text-zinc-300"
          >
            Excluded Apps &amp; Window Keywords
          </label>
          <form onSubmit={handleAddExcludedApp} className="flex items-center gap-2">
            <input
              id="excluded-app-input"
              type="text"
              data-testid="excluded-app-input"
              value={excludedAppInput}
              onChange={(e) => setExcludedAppInput(e.target.value)}
              placeholder="e.g., bank, keepass.exe, signal.exe"
              className="flex-1 rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12.5px] text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-sky-400"
            />
            <button
              type="submit"
              data-testid="add-excluded-app-btn"
              className="px-3.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-[12px] font-medium text-zinc-100"
            >
              Add Exclusion
            </button>
          </form>

          <div className="flex flex-wrap gap-1.5">
            {settings.screenday_excluded_apps.length === 0 ? (
              <span className="text-[11.5px] text-zinc-500">
                No custom excluded apps configured.
              </span>
            ) : (
              settings.screenday_excluded_apps.map((app) => (
                <span
                  key={app}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#090B10] border border-white/15 text-[11.5px] font-mono text-zinc-200"
                >
                  {app}
                  <button
                    type="button"
                    aria-label={`Remove ${app}`}
                    onClick={() => handleRemoveExcludedApp(app)}
                    className="text-rose-400 hover:text-rose-300 text-xs"
                  >
                    ✕
                  </button>
                </span>
              ))
            )}
          </div>
        </div>

        {/* Capture Interval Slider & Retention Days */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-white/[0.07]">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[12px]">
              <label
                htmlFor="screenday-interval-slider"
                className="text-zinc-200"
              >
                Screen Day Capture Cadence
              </label>
              <span
                data-testid="screenday-interval-value"
                className="font-mono text-sky-300"
              >
                {settings.screenday_interval_sec}s
              </span>
            </div>
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
              className="w-full accent-sky-400"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="retention-days-input"
              className="text-[12.5px] text-zinc-200"
            >
              Auto-prune local captures older than (days):
            </label>
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
              className="w-20 rounded-xl bg-[#090B10] border border-white/15 px-2.5 py-1.5 text-[12.5px] font-mono text-zinc-100"
            />
          </div>
        </div>

        <p className="text-[11.5px] text-zinc-400 leading-relaxed pt-1">
          <strong>Local-First Guarantee:</strong> Screen Day frames, SQLite
          memories, and <code className="gl-mono text-[11px]">.graph.md</code>{" "}
          files stay strictly on your PC in{" "}
          <code className="gl-mono text-[11px]">%LOCALAPPDATA%\GuideLens\</code>
          . Close sensitive windows before triggering Cloud Pro, BYO API, or
          external Agent modes.
        </p>
      </section>

      {/* Voice, Accessibility & Global Hotkeys */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[13.5px] font-semibold text-zinc-100">
              Voice &amp; Overlay Accessibility
            </h2>
            <button
              type="button"
              data-testid="open-voice-studio-btn"
              onClick={onOpenCompanionsVoice}
              className="px-2.5 py-1 rounded-lg bg-sky-400/15 border border-sky-400/40 text-sky-300 text-[12px] font-medium hover:bg-sky-400/25 transition-colors"
            >
              Open Voice Studio →
            </button>
          </div>

          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="stt-engine-select"
              className="text-[12.5px] text-zinc-200"
            >
              Speech-to-Text (STT) Engine
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
              className="rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12px] text-zinc-100"
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
            <span className="text-[12.5px] text-zinc-200">
              High-Contrast Overlay (#FACC15 Yellow Border &amp; Badge)
            </span>
            <input
              type="checkbox"
              data-testid="high-contrast-checkbox"
              checked={settings.high_contrast}
              onChange={(e) =>
                void onUpdateSettings({ high_contrast: e.target.checked })
              }
            />
          </label>

          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[12.5px] text-zinc-200">
              Always Show 2.5× Magnifier Lens
            </span>
            <input
              type="checkbox"
              data-testid="always-magnify-checkbox"
              checked={settings.always_magnify}
              onChange={(e) =>
                void onUpdateSettings({ always_magnify: e.target.checked })
              }
            />
          </label>
        </section>

        {/* Global Hotkeys Guide */}
        <section className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-3">
          <div className="flex items-center gap-2">
            <KeyboardIcon className="w-4 h-4 text-sky-300" />
            <h2 className="text-[13.5px] font-semibold text-zinc-100">
              Global Hotkeys &amp; Live Gestures
            </h2>
          </div>
          <div className="space-y-2 text-[12px]">
            {(
              [
                {
                  keys: "Ctrl + Space",
                  desc: "Summon / focus GuideLens capsule over any app",
                },
                {
                  keys: "Click Target",
                  desc: "Auto-advances Live Copilot after 280ms UI settle",
                },
                {
                  keys: "Esc",
                  desc: "Clear active overlay highlight & dismiss step badge",
                },
                {
                  keys: "Tray Icon",
                  desc: "Toggle Screen Day, Start/Stop Live Session, or open Hub",
                },
              ] as const
            ).map((hk) => (
              <div
                key={hk.keys}
                className="flex items-center justify-between gap-3 rounded-xl bg-[#090B10]/85 border border-white/[0.07] px-3 py-2"
              >
                <span className="text-zinc-300">{hk.desc}</span>
                <kbd className="shrink-0 px-2 py-0.5 rounded-md bg-white/10 border border-white/15 font-mono text-[11px] text-sky-200">
                  {hk.keys}
                </kbd>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* GuideLens Cloud Account & Pro Billing (Preserves data-testid="panel-account") */}
      <div
        id="account-billing"
        ref={accountSectionRef}
        data-testid="panel-account"
        className="space-y-4"
      >
        <section className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-sky-400/15 border border-sky-400/30 flex items-center justify-center text-sky-300">
                <UserIcon className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-[14px] font-semibold text-zinc-100">
                  GuideLens Cloud Account
                </h2>
                <p className="text-[12px] text-zinc-400">
                  {auth.logged_in
                    ? `Signed in as ${auth.email} (${auth.tier})`
                    : "Sign in to access Groq Pro ultra-fast cloud guidance"}
                </p>
              </div>
            </div>
            {auth.logged_in && (
              <button
                type="button"
                onClick={() => void handleLogout()}
                data-testid="logout-btn"
                className="px-3 py-1.5 rounded-xl bg-white/10 text-zinc-100 text-[12px]"
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
                className="rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12.5px] text-zinc-100"
              />
              <input
                type="password"
                autoComplete="off"
                aria-label="Account Password"
                data-testid="login-password-input"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="Password"
                className="rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12.5px] text-zinc-100"
              />
              <button
                type="submit"
                data-testid="login-submit-btn"
                className="rounded-xl bg-sky-400 text-slate-950 font-semibold text-[12.5px] px-3 py-1.5"
              >
                Sign In
              </button>
            </form>
          )}

          {authMessage && (
            <p className="text-[12px] text-sky-300">{authMessage}</p>
          )}
        </section>

        {/* Usage Meter */}
        <section
          aria-label="Groq Pro Usage Meter"
          data-testid="usage-meter-section"
          className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-2.5"
        >
          <div className="flex items-center justify-between text-[13px]">
            <span className="font-semibold text-zinc-100">
              Monthly Groq Pro Fair-Use Quota
            </span>
            <span data-testid="usage-count-text" className="text-sky-300 font-mono">
              {auth.usage} / {auth.limit} requests
            </span>
          </div>
          <div className="w-full h-2.5 rounded-full bg-[#090B10] overflow-hidden">
            <div
              style={{ width: `${usagePct}%` }}
              className="h-full bg-sky-400 transition-all"
            />
          </div>
          <p className="text-[11.5px] text-zinc-400">
            Includes 1,500 Groq vision requests/month (up to 20 req/min). Local VLM and BYO API keys remain unlimited and free.
          </p>
        </section>

        {/* Upgrade Cards */}
        <section
          aria-label="Upgrade to GuideLens Pro"
          className="grid grid-cols-1 sm:grid-cols-2 gap-3"
        >
          <div className="rounded-2xl bg-[#11141D]/90 border border-white/15 p-4 flex flex-col justify-between space-y-3">
            <div>
              <h3 className="text-[14px] font-bold text-zinc-100">
                Pro Monthly — $19/mo
              </h3>
              <p className="text-[12px] text-zinc-400 mt-1">
                Instant Groq cloud vision &amp; OCR (&lt;2s latency), 1,500 requests/month.
              </p>
            </div>
            <button
              type="button"
              data-testid="upgrade-monthly-btn"
              onClick={() => void handleCheckout("monthly")}
              className="w-full py-2 rounded-xl bg-sky-400 text-slate-950 font-semibold text-[12.5px]"
            >
              Upgrade Monthly ($19/mo)
            </button>
          </div>

          <div className="rounded-2xl bg-sky-400/10 border border-sky-400/45 p-4 flex flex-col justify-between space-y-3">
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-bold text-zinc-100">
                  Pro Annual — $190/yr
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-sky-400 text-slate-950">
                  Save 2 Months
                </span>
              </div>
              <p className="text-[12px] text-zinc-400 mt-1">
                Full Groq Pro speed billed annually ($15.83/mo effective).
              </p>
            </div>
            <button
              type="button"
              data-testid="upgrade-annual-btn"
              onClick={() => void handleCheckout("annual")}
              className="w-full py-2 rounded-xl bg-sky-400 text-slate-950 font-semibold text-[12.5px]"
            >
              Upgrade Annual ($190/yr)
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
