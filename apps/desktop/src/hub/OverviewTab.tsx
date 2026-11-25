import React, { useState } from "react";
import {
  endLiveSession,
  pauseLiveSession,
  screendayCaptureNow,
  sendLiveMessage,
  startLiveSession,
} from "../lib/ipc";
import {
  formatBrainPillLabel,
  type LatencyBreakdown,
  type LatencyStats,
  type LiveSessionState,
  type ScreenDayStatusDto,
  type ScreenDaySummaryDto,
  type Settings,
} from "../types";
import {
  BrainIcon,
  ClockIcon,
  CompanionIcon,
  DiaryIcon,
  EyeIcon,
  GraphIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  ShieldIcon,
  StopIcon,
  ZapIcon,
} from "./HubIcons";

export type OverviewTargetTab =
  | "diary"
  | "graph"
  | "companions"
  | "brains"
  | "privacy";

export interface OverviewTabProps {
  settings: Settings;
  liveSession: LiveSessionState;
  screenDayStatus: ScreenDayStatusDto;
  todaySummary: ScreenDaySummaryDto | null;
  latencyStats: LatencyStats;
  kgNodeCount: number;
  sessionGraphCount: number;
  onLiveSessionChange: (next: LiveSessionState) => void;
  onToggleScreenDay: (enabled: boolean) => Promise<void> | void;
  onRefreshTelemetry: () => Promise<void> | void;
  onJumpToTab: (tab: OverviewTargetTab) => void;
}

const SAMPLE_GOALS = [
  "Configure launch.json debugger in VS Code",
  "Export selected artboard as transparent PNG",
  "Inspect failing GitHub Actions workflow logs",
];

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEpochTime(epochSec: number | null | undefined): string {
  if (!epochSec) return "Never";
  return new Date(epochSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusBadgeTone(status: LiveSessionState["status"]): string {
  switch (status) {
    case "guiding":
    case "observing":
    case "listening":
      return "bg-emerald-500/15 border-emerald-400/40 text-emerald-300";
    case "waiting_settle":
      return "bg-amber-500/15 border-amber-400/40 text-amber-300";
    case "paused":
      return "bg-indigo-500/15 border-indigo-400/40 text-indigo-300";
    case "completed":
      return "bg-sky-500/15 border-sky-400/40 text-sky-300";
    case "idle":
    default:
      return "bg-white/5 border-white/15 text-zinc-400";
  }
}

interface LatencySegmentMeta {
  key: keyof Pick<
    LatencyBreakdown,
    "capture_ms" | "grounding_ms" | "memory_ms" | "llm_ms"
  >;
  label: string;
  color: string;
  barClass: string;
  textClass: string;
}

const LATENCY_SEGMENTS: readonly LatencySegmentMeta[] = [
  {
    key: "capture_ms",
    label: "Capture",
    color: "#38BDF8",
    barClass: "bg-sky-400",
    textClass: "text-sky-300",
  },
  {
    key: "grounding_ms",
    label: "Grounding (UIA+OCR+SoM)",
    color: "#22C55E",
    barClass: "bg-emerald-400",
    textClass: "text-emerald-300",
  },
  {
    key: "memory_ms",
    label: "KG Memory",
    color: "#F59E0B",
    barClass: "bg-amber-400",
    textClass: "text-amber-300",
  },
  {
    key: "llm_ms",
    label: "Brain Inference",
    color: "#818CF8",
    barClass: "bg-indigo-400",
    textClass: "text-indigo-300",
  },
];

export const OverviewTab: React.FC<OverviewTabProps> = ({
  settings,
  liveSession,
  screenDayStatus,
  todaySummary,
  latencyStats,
  kgNodeCount,
  sessionGraphCount,
  onLiveSessionChange,
  onToggleScreenDay,
  onRefreshTelemetry,
  onJumpToTab,
}) => {
  const [goalInput, setGoalInput] = useState(liveSession.goal || "");
  const [followUpInput, setFollowUpInput] = useState("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [capturingFrame, setCapturingFrame] = useState(false);
  const [dayFeedback, setDayFeedback] = useState<string | null>(null);

  const isSessionActive =
    liveSession.status !== "idle" && liveSession.status !== "completed";
  const isPaused = liveSession.status === "paused";

  const handleStartSession = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const goal = goalInput.trim();
    if (!goal || sessionBusy) return;
    setSessionBusy(true);
    setSessionError(null);
    try {
      const next = await startLiveSession(goal);
      onLiveSessionChange(next);
    } catch (err) {
      setSessionError(
        err instanceof Error ? err.message : "Failed to start live session",
      );
    } finally {
      setSessionBusy(false);
    }
  };

  const handleSendFollowUp = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = followUpInput.trim();
    if (!msg || sessionBusy) return;
    setSessionBusy(true);
    setSessionError(null);
    setFollowUpInput("");
    try {
      const next = await sendLiveMessage(msg, liveSession.session_id);
      onLiveSessionChange(next);
    } catch (err) {
      setSessionError(
        err instanceof Error ? err.message : "Failed to advance live step",
      );
    } finally {
      setSessionBusy(false);
    }
  };

  const handleTogglePause = async () => {
    if (sessionBusy) return;
    setSessionBusy(true);
    setSessionError(null);
    try {
      const next = await pauseLiveSession(!isPaused, liveSession.session_id);
      onLiveSessionChange(next);
    } catch (err) {
      setSessionError(
        err instanceof Error ? err.message : "Failed to toggle pause",
      );
    } finally {
      setSessionBusy(false);
    }
  };

  const handleEndSession = async () => {
    if (sessionBusy) return;
    setSessionBusy(true);
    setSessionError(null);
    try {
      const next = await endLiveSession(liveSession.session_id);
      onLiveSessionChange(next);
      void onRefreshTelemetry();
    } catch (err) {
      setSessionError(
        err instanceof Error ? err.message : "Failed to end live session",
      );
    } finally {
      setSessionBusy(false);
    }
  };

  const handleCaptureNow = async () => {
    setCapturingFrame(true);
    setDayFeedback(null);
    try {
      const frame = await screendayCaptureNow();
      setDayFeedback(
        frame
          ? `Captured ${frame.active_app} (${formatBytes(frame.file_bytes)})`
          : "Capture skipped (private window or inactive).",
      );
      await onRefreshTelemetry();
    } catch (err) {
      setDayFeedback(
        err instanceof Error ? err.message : "Unable to capture frame now.",
      );
    } finally {
      setCapturingFrame(false);
    }
  };

  const avg = latencyStats.average;
  const recentSamples = latencyStats.recent.slice(-12);
  const maxTotal = Math.max(
    1,
    ...recentSamples.map((s) => Math.max(1, s.total_ms)),
  );
  const avgSum = avg
    ? Math.max(
        1,
        avg.capture_ms + avg.grounding_ms + avg.memory_ms + avg.llm_ms,
      )
    : 1;

  return (
    <div className="space-y-5" data-testid="panel-overview">
      {/* Top 2 Hero Control Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Live Session Control Card */}
        <section className="lg:col-span-7 rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 flex flex-col justify-between gap-4 shadow-lg">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-sky-400/15 border border-sky-400/30 flex items-center justify-center text-sky-300">
                  <ZapIcon className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-[14px] font-semibold text-zinc-100">
                    Live Copilot Session
                  </h2>
                  <p className="text-[11.5px] text-zinc-400">
                    Reactive 1-step Set-of-Mark guidance with automatic click progression
                  </p>
                </div>
              </div>
              <span
                data-testid="live-session-status-badge"
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border uppercase tracking-wide ${statusBadgeTone(
                  liveSession.status,
                )}`}
              >
                {liveSession.status.replace("_", " ")}
              </span>
            </div>

            {!isSessionActive ? (
              <form onSubmit={handleStartSession} className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    aria-label="Live Session Goal"
                    data-testid="live-goal-input"
                    value={goalInput}
                    onChange={(e) => setGoalInput(e.target.value)}
                    placeholder="What should we accomplish together on screen?"
                    className="flex-1 rounded-xl bg-[#090B10] border border-white/15 px-3.5 py-2 text-[13px] text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-sky-400"
                  />
                  <button
                    type="submit"
                    data-testid="start-live-session-btn"
                    disabled={!goalInput.trim() || sessionBusy}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-400 text-slate-950 font-semibold text-[12.5px] hover:bg-sky-300 disabled:opacity-40 transition-colors shrink-0"
                  >
                    <PlayIcon className="w-3.5 h-3.5" />
                    {sessionBusy ? "Starting…" : "Start Live"}
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-zinc-500 mr-1">Try:</span>
                  {SAMPLE_GOALS.map((sample) => (
                    <button
                      key={sample}
                      type="button"
                      onClick={() => setGoalInput(sample)}
                      className="px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.07] text-[11px] text-zinc-300 transition-colors"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </form>
            ) : (
              <div className="space-y-3">
                <div className="rounded-xl bg-[#090B10]/90 border border-white/10 p-3 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>
                      Goal: <strong className="text-zinc-200">{liveSession.goal}</strong>
                    </span>
                    <span className="font-mono text-sky-300">
                      Turn {liveSession.turn_count}
                    </span>
                  </div>
                  {liveSession.current_step ? (
                    <p className="text-[12.5px] text-sky-200 font-medium">
                      Next Step: {liveSession.current_step.instruction_line}
                    </p>
                  ) : (
                    <p className="text-[12px] text-zinc-400">
                      Observing your screen for the next interaction…
                    </p>
                  )}
                </div>

                <form onSubmit={handleSendFollowUp} className="flex items-center gap-2">
                  <input
                    type="text"
                    aria-label="Live Follow-up Message"
                    data-testid="live-followup-input"
                    value={followUpInput}
                    onChange={(e) => setFollowUpInput(e.target.value)}
                    placeholder="Steer or ask a follow-up mid-session…"
                    className="flex-1 rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12.5px] text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-sky-400"
                  />
                  <button
                    type="submit"
                    disabled={!followUpInput.trim() || sessionBusy}
                    className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-zinc-100 text-[12px] font-medium disabled:opacity-40"
                  >
                    Send
                  </button>
                  <button
                    type="button"
                    data-testid="pause-live-session-btn"
                    onClick={() => void handleTogglePause()}
                    disabled={sessionBusy}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-indigo-500/20 border border-indigo-400/35 text-indigo-200 text-[12px] font-medium hover:bg-indigo-500/30"
                  >
                    <PauseIcon className="w-3.5 h-3.5" />
                    {isPaused ? "Resume" : "Pause"}
                  </button>
                  <button
                    type="button"
                    data-testid="end-live-session-btn"
                    onClick={() => void handleEndSession()}
                    disabled={sessionBusy}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-rose-500/20 border border-rose-400/40 text-rose-200 text-[12px] font-medium hover:bg-rose-500/30"
                  >
                    <StopIcon className="w-3.5 h-3.5" />
                    Stop
                  </button>
                </form>
              </div>
            )}

            {sessionError && (
              <p className="text-[11.5px] text-rose-300" role="alert">
                {sessionError}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-white/[0.07] text-[11.5px] text-zinc-400">
            <span>
              Routing via <strong className="text-zinc-200">{formatBrainPillLabel(settings)}</strong>
            </span>
            <button
              type="button"
              onClick={() => onJumpToTab("brains")}
              className="text-sky-300 hover:text-sky-200 font-medium"
            >
              Configure Brains →
            </button>
          </div>
        </section>

        {/* Screen Day Toggle Card */}
        <section className="lg:col-span-5 rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 flex flex-col justify-between gap-4 shadow-lg">
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div
                  className={`w-8 h-8 rounded-xl border flex items-center justify-center ${
                    screenDayStatus.enabled
                      ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-300"
                      : "bg-white/5 border-white/10 text-zinc-400"
                  }`}
                >
                  <EyeIcon className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-[14px] font-semibold text-zinc-100">
                    Record My Day (Screen Day)
                  </h2>
                  <p className="text-[11.5px] text-zinc-400">
                    Local compressed diary · {screenDayStatus.interval_sec}s cadence · Privacy Shield{" "}
                    {settings.screenday_skip_private ? "ON" : "OFF"}
                  </p>
                </div>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={screenDayStatus.enabled}
                data-testid="overview-screenday-toggle"
                onClick={() => void onToggleScreenDay(!screenDayStatus.enabled)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors ${
                  screenDayStatus.enabled
                    ? "bg-emerald-500 border-emerald-400"
                    : "bg-zinc-800 border-white/15"
                }`}
                aria-label="Toggle Record My Day"
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                    screenDayStatus.enabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-xl bg-[#090B10]/90 border border-white/[0.07] px-3 py-2">
                <div className="text-[10.5px] uppercase tracking-wider text-zinc-500">
                  Active Project
                </div>
                <div className="text-[12.5px] font-medium text-zinc-100 truncate mt-0.5">
                  {screenDayStatus.current_project || "Detecting…"}
                </div>
              </div>
              <div className="rounded-xl bg-[#090B10]/90 border border-white/[0.07] px-3 py-2">
                <div className="text-[10.5px] uppercase tracking-wider text-zinc-500">
                  Active Meeting
                </div>
                <div className="text-[12.5px] font-medium text-zinc-100 truncate mt-0.5">
                  {screenDayStatus.current_meeting || "None detected"}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between text-[11.5px] text-zinc-400">
              <span>
                Last frame: <strong className="text-zinc-200">{formatEpochTime(screenDayStatus.last_captured_at)}</strong>
              </span>
              <span className="font-mono text-zinc-300">
                {screenDayStatus.today_frames} frames · {formatBytes(screenDayStatus.today_bytes)}
              </span>
            </div>

            {dayFeedback && (
              <p className="text-[11.5px] text-sky-300">{dayFeedback}</p>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 pt-3 border-t border-white/[0.07]">
            <button
              type="button"
              data-testid="screenday-capture-now-btn"
              onClick={() => void handleCaptureNow()}
              disabled={capturingFrame}
              className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-[12px] text-zinc-200 font-medium disabled:opacity-40"
            >
              {capturingFrame ? "Capturing…" : "Capture Frame Now"}
            </button>
            <button
              type="button"
              onClick={() => onJumpToTab("diary")}
              className="text-[12px] text-sky-300 hover:text-sky-200 font-medium"
            >
              Open Visual Diary →
            </button>
          </div>
        </section>
      </div>

      {/* Today's Summary Stat Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl bg-[#11141D]/80 border border-white/[0.08] p-3.5">
          <div className="text-[11px] text-zinc-400">Today&apos;s Frames</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl font-bold tabular-nums text-zinc-100">
              {todaySummary?.frame_count ?? screenDayStatus.today_frames}
            </span>
            <span className="text-[11px] font-mono text-zinc-500">
              {formatBytes(todaySummary?.total_bytes ?? screenDayStatus.today_bytes)}
            </span>
          </div>
        </div>
        <div className="rounded-xl bg-[#11141D]/80 border border-white/[0.08] p-3.5">
          <div className="text-[11px] text-zinc-400">Projects Tracked</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl font-bold tabular-nums text-sky-300">
              {todaySummary?.projects.length ?? (screenDayStatus.current_project ? 1 : 0)}
            </span>
            <span className="text-[11px] text-zinc-500 truncate max-w-[110px]">
              {todaySummary?.projects[0] || screenDayStatus.current_project || "—"}
            </span>
          </div>
        </div>
        <div className="rounded-xl bg-[#11141D]/80 border border-white/[0.08] p-3.5">
          <div className="text-[11px] text-zinc-400">Meetings Indexed</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl font-bold tabular-nums text-indigo-300">
              {todaySummary?.meetings.length ?? (screenDayStatus.current_meeting ? 1 : 0)}
            </span>
            <span className="text-[11px] text-zinc-500">OCR context</span>
          </div>
        </div>
        <div className="rounded-xl bg-[#11141D]/80 border border-white/[0.08] p-3.5">
          <div className="text-[11px] text-zinc-400">Knowledge Graph</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl font-bold tabular-nums text-emerald-300">
              {kgNodeCount}
            </span>
            <span className="text-[11px] text-zinc-500">
              {sessionGraphCount} .graph.md
            </span>
          </div>
        </div>
      </section>

      {/* Latency Breakdown Telemetry Chart */}
      <section
        data-testid="latency-telemetry-card"
        className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/15 border border-indigo-400/30 flex items-center justify-center text-indigo-300">
              <ClockIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-[14px] font-semibold text-zinc-100">
                Real-Time Pipeline Latency Breakdown
              </h2>
              <p className="text-[11.5px] text-zinc-400">
                {latencyStats.count > 0
                  ? `Averaged across ${latencyStats.count} recent guidance turns`
                  : "Waiting for guidance turns to record live pipeline timings"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {avg && (
              <div className="px-3 py-1 rounded-full bg-sky-400/10 border border-sky-400/30 text-[12px] font-mono text-sky-300">
                Avg Total: {avg.total_ms} ms
              </div>
            )}
            <button
              type="button"
              data-testid="refresh-telemetry-btn"
              onClick={() => void onRefreshTelemetry()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 text-[12px] text-zinc-300"
            >
              <RefreshIcon className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>

        {/* 4 Stage Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {LATENCY_SEGMENTS.map((seg) => {
            const val = avg ? avg[seg.key] : 0;
            const share = avg ? Math.round((val / avgSum) * 100) : 0;
            return (
              <div
                key={seg.key}
                className="rounded-xl bg-[#090B10]/85 border border-white/[0.07] p-3 space-y-1.5"
              >
                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="flex items-center gap-1.5 text-zinc-300">
                    <span className={`w-2 h-2 rounded-full ${seg.barClass}`} />
                    {seg.label}
                  </span>
                  <span className="font-mono text-zinc-500">{share}%</span>
                </div>
                <div className={`text-lg font-bold font-mono tabular-nums ${seg.textClass}`}>
                  {avg ? `${val} ms` : "—"}
                </div>
              </div>
            );
          })}
        </div>

        {/* Stacked Distribution Bar + Per-Turn History Bars */}
        {avg ? (
          <div className="space-y-3">
            <div className="w-full h-3 rounded-full bg-[#090B10] overflow-hidden flex border border-white/[0.06]">
              {LATENCY_SEGMENTS.map((seg) => {
                const pct = Math.max(2, (avg[seg.key] / avgSum) * 100);
                return (
                  <div
                    key={seg.key}
                    style={{ width: `${pct}%` }}
                    title={`${seg.label}: ${avg[seg.key]} ms`}
                    className={`${seg.barClass} h-full transition-all`}
                  />
                );
              })}
            </div>

            {recentSamples.length > 0 && (
              <div className="pt-1">
                <div className="flex items-center justify-between text-[11px] text-zinc-500 mb-2">
                  <span>Recent Turns ({recentSamples.length})</span>
                  <span>Peak: {maxTotal} ms</span>
                </div>
                <div className="h-20 flex items-end gap-1.5 px-2 py-2 rounded-xl bg-[#090B10]/80 border border-white/[0.06]">
                  {recentSamples.map((sample, idx) => {
                    const heightPct = Math.max(
                      10,
                      Math.round((sample.total_ms / maxTotal) * 100),
                    );
                    const sum = Math.max(
                      1,
                      sample.capture_ms +
                        sample.grounding_ms +
                        sample.memory_ms +
                        sample.llm_ms,
                    );
                    return (
                      <div
                        key={idx}
                        className="flex-1 h-full flex flex-col justify-end group relative"
                        title={`Turn ${idx + 1}: ${sample.total_ms}ms (cap ${sample.capture_ms} / gnd ${sample.grounding_ms} / mem ${sample.memory_ms} / llm ${sample.llm_ms})`}
                      >
                        <div
                          style={{ height: `${heightPct}%` }}
                          className="w-full rounded-t-md overflow-hidden flex flex-col-reverse bg-white/5"
                        >
                          {LATENCY_SEGMENTS.map((seg) => {
                            const segPct = (sample[seg.key] / sum) * 100;
                            return (
                              <div
                                key={seg.key}
                                style={{ height: `${segPct}%` }}
                                className={seg.barClass}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl bg-[#090B10]/60 border border-dashed border-white/10 px-4 py-3 text-[12px] text-zinc-400">
            Zero-alloc pipeline targets: <span className="font-mono text-sky-300">&lt;15ms</span> in-memory capture →{" "}
            <span className="font-mono text-emerald-300">&lt;45ms</span> UIA+WinRT OCR+SoM →{" "}
            <span className="font-mono text-amber-300">&lt;3ms</span> KG memory →{" "}
            <span className="font-mono text-indigo-300">Fast Brain</span>. Start a Live Session or ask via <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-zinc-200 font-mono text-[11px]">Ctrl+Space</kbd> to see live numbers.
          </div>
        )}
      </section>

      {/* Quick-Jump Cards */}
      <section className="grid grid-cols-1 md:grid-cols-5 gap-3">
        {(
          [
            {
              tab: "diary" as const,
              title: "Visual Diary",
              desc: "Scrub frames, projects & meetings",
              icon: DiaryIcon,
              tone: "text-emerald-300",
            },
            {
              tab: "graph" as const,
              title: "Knowledge Graph",
              desc: "Inspect learned UI paths & .graph.md",
              icon: GraphIcon,
              tone: "text-sky-300",
            },
            {
              tab: "companions" as const,
              title: "Companions & Voice",
              desc: "Mochi, Byte, Sora, Flow + tiny-voca",
              icon: CompanionIcon,
              tone: "text-pink-300",
            },
            {
              tab: "brains" as const,
              title: "Brains & Agents",
              desc: "CLIs, OpenRouter, Ollama & routing",
              icon: BrainIcon,
              tone: "text-indigo-300",
            },
            {
              tab: "privacy" as const,
              title: "Privacy & System",
              desc: "Shield, hotkeys & Pro account",
              icon: ShieldIcon,
              tone: "text-amber-300",
            },
          ] as const
        ).map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.tab}
              type="button"
              onClick={() => onJumpToTab(card.tab)}
              className="text-left rounded-xl bg-[#11141D]/75 hover:bg-[#161B26] border border-white/[0.08] hover:border-sky-400/35 p-3.5 transition-all group"
            >
              <div className={`mb-2 ${card.tone}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="text-[12.5px] font-semibold text-zinc-100 group-hover:text-sky-200">
                {card.title}
              </div>
              <div className="text-[11px] text-zinc-400 mt-0.5 leading-snug">
                {card.desc}
              </div>
            </button>
          );
        })}
      </section>
    </div>
  );
};
