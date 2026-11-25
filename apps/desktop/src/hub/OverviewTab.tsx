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
  type LatencyStats,
  type LiveSessionState,
  type ScreenDayStatusDto,
  type ScreenDaySummaryDto,
  type Settings,
} from "../types";

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

function isLiveRunning(status: LiveSessionState["status"]): boolean {
  return (
    status === "guiding" ||
    status === "observing" ||
    status === "listening" ||
    status === "waiting_settle"
  );
}

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
  const liveDotActive = isLiveRunning(liveSession.status);

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

  const avgMs = latencyStats.average?.total_ms;
  const framesToday = todaySummary?.frame_count ?? screenDayStatus.today_frames;
  const bytesToday = todaySummary?.total_bytes ?? screenDayStatus.today_bytes;

  return (
    <div className="space-y-4" data-testid="panel-overview">
      {/* 1. Live Session Control */}
      <section className="rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-[#F4F4F5]">
              Live Session
            </h2>
            <p className="text-[12px] text-[#8E929B] mt-0.5">
              Step-by-step on-screen guidance with automatic click progression
            </p>
          </div>
          <span
            data-testid="live-session-status-badge"
            className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[#8E929B] capitalize"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                liveDotActive
                  ? "bg-emerald-400"
                  : liveSession.status === "completed"
                    ? "bg-[#F4F4F5]"
                    : "bg-[#5C606A]"
              }`}
            />
            <span>{liveSession.status.replace("_", " ")}</span>
          </span>
        </div>

        {!isSessionActive ? (
          <form onSubmit={handleStartSession} className="space-y-3">
            <div className="flex items-center gap-2.5">
              <input
                type="text"
                aria-label="Live Session Goal"
                data-testid="live-goal-input"
                value={goalInput}
                onChange={(e) => setGoalInput(e.target.value)}
                placeholder="What would you like to accomplish on screen?"
                className="flex-1 rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3.5 py-2 text-[13px] text-[#F4F4F5] placeholder-[#5C606A] focus:outline-none focus:border-white/25"
              />
              <button
                type="submit"
                data-testid="start-live-session-btn"
                disabled={!goalInput.trim() || sessionBusy}
                className="px-4 py-2 rounded-lg bg-[#F4F4F5] hover:bg-white text-[#0A0B0D] font-medium text-[12.5px] disabled:opacity-40 transition-colors shrink-0"
              >
                {sessionBusy ? "Starting…" : "Start Session"}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {SAMPLE_GOALS.map((sample) => (
                <button
                  key={sample}
                  type="button"
                  onClick={() => setGoalInput(sample)}
                  className="px-2.5 py-1 rounded-md bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.07] text-[11.5px] text-[#8E929B] hover:text-[#F4F4F5] transition-colors"
                >
                  {sample}
                </button>
              ))}
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-[#0A0B0D] border border-white/[0.07] px-3.5 py-3 space-y-1">
              <div className="flex items-center justify-between text-[11.5px] text-[#8E929B]">
                <span className="truncate">
                  Goal: <span className="text-[#F4F4F5] font-medium">{liveSession.goal}</span>
                </span>
                <span className="font-mono text-[#5C606A] shrink-0 ml-3">
                  Turn {liveSession.turn_count}
                </span>
              </div>
              <p className="text-[13px] text-[#F4F4F5] font-medium">
                {liveSession.current_step
                  ? liveSession.current_step.instruction_line
                  : "Observing your screen for the next interaction…"}
              </p>
            </div>

            <form onSubmit={handleSendFollowUp} className="flex items-center gap-2">
              <input
                type="text"
                aria-label="Live Follow-up Message"
                data-testid="live-followup-input"
                value={followUpInput}
                onChange={(e) => setFollowUpInput(e.target.value)}
                placeholder="Steer or ask a follow-up…"
                className="flex-1 rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-[#F4F4F5] placeholder-[#5C606A] focus:outline-none focus:border-white/25"
              />
              <button
                type="submit"
                disabled={!followUpInput.trim() || sessionBusy}
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#E4E4E7] text-[12px] font-medium disabled:opacity-40 transition-colors"
              >
                Send
              </button>
              <button
                type="button"
                data-testid="pause-live-session-btn"
                onClick={() => void handleTogglePause()}
                disabled={sessionBusy}
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#E4E4E7] text-[12px] font-medium transition-colors"
              >
                {isPaused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                data-testid="end-live-session-btn"
                onClick={() => void handleEndSession()}
                disabled={sessionBusy}
                className="px-3 py-1.5 rounded-lg bg-[#F4F4F5] hover:bg-white text-[#0A0B0D] text-[12px] font-medium transition-colors"
              >
                End
              </button>
            </form>
          </div>
        )}

        {sessionError && (
          <p className="text-[12px] text-[#8E929B]" role="alert">
            {sessionError}
          </p>
        )}

        <div className="flex items-center justify-between pt-3 border-t border-white/[0.07] text-[11.5px] text-[#5C606A]">
          <span>
            Model routing:{" "}
            <span className="text-[#8E929B] font-medium">
              {formatBrainPillLabel(settings)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onJumpToTab("brains")}
            className="text-[#8E929B] hover:text-[#F4F4F5] transition-colors"
          >
            Models &amp; Agents →
          </button>
        </div>
      </section>

      {/* 2. Screen Day Row */}
      <section className="rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  screenDayStatus.enabled ? "bg-emerald-400" : "bg-[#5C606A]"
                }`}
              />
              <h2 className="text-[14px] font-semibold text-[#F4F4F5]">
                Screen Day
              </h2>
              <span className="text-[11.5px] text-[#5C606A]">
                {screenDayStatus.enabled ? "Recording" : "Paused"} · {screenDayStatus.interval_sec}s
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[#8E929B]">
              <span>
                Project:{" "}
                <span className="text-[#F4F4F5]">
                  {screenDayStatus.current_project || "Detecting…"}
                </span>
              </span>
              <span>
                Meeting:{" "}
                <span className="text-[#F4F4F5]">
                  {screenDayStatus.current_meeting || "None"}
                </span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              data-testid="screenday-capture-now-btn"
              onClick={() => void handleCaptureNow()}
              disabled={capturingFrame}
              className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#E4E4E7] text-[12px] font-medium disabled:opacity-40 transition-colors"
            >
              {capturingFrame ? "Capturing…" : "Capture Now"}
            </button>

            <button
              type="button"
              role="switch"
              aria-checked={screenDayStatus.enabled}
              data-testid="overview-screenday-toggle"
              onClick={() => void onToggleScreenDay(!screenDayStatus.enabled)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
                screenDayStatus.enabled
                  ? "bg-[#F4F4F5] border-[#F4F4F5]"
                  : "bg-white/[0.08] border-white/[0.12]"
              }`}
              aria-label="Toggle Record My Day"
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 mt-[1px] transform rounded-full transition ${
                  screenDayStatus.enabled
                    ? "translate-x-4 bg-[#0A0B0D]"
                    : "translate-x-0.5 bg-[#8E929B]"
                }`}
              />
            </button>
          </div>
        </div>

        {dayFeedback && (
          <p className="text-[11.5px] text-[#8E929B] pt-1">{dayFeedback}</p>
        )}
      </section>

      {/* 3. Clean 3-Column Metrics Row */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl bg-[#111317] border border-white/[0.07] px-4 py-3.5">
          <div className="text-[11.5px] text-[#8E929B]">Avg Response</div>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className="text-xl font-semibold tabular-nums text-[#F4F4F5]">
              {avgMs != null ? `${avgMs} ms` : "—"}
            </span>
            <span className="text-[11px] font-mono text-[#5C606A]">
              {latencyStats.count > 0 ? `${latencyStats.count} turns` : "No turns"}
            </span>
          </div>
        </div>

        <div className="rounded-xl bg-[#111317] border border-white/[0.07] px-4 py-3.5">
          <div className="text-[11.5px] text-[#8E929B]">Frames Today</div>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className="text-xl font-semibold tabular-nums text-[#F4F4F5]">
              {framesToday}
            </span>
            <span className="text-[11px] font-mono text-[#5C606A]">
              {formatBytes(bytesToday)}
            </span>
          </div>
        </div>

        <div className="rounded-xl bg-[#111317] border border-white/[0.07] px-4 py-3.5">
          <div className="text-[11.5px] text-[#8E929B]">Learned Paths</div>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className="text-xl font-semibold tabular-nums text-[#F4F4F5]">
              {kgNodeCount}
            </span>
            <span className="text-[11px] font-mono text-[#5C606A]">
              {sessionGraphCount} .graph.md
            </span>
          </div>
        </div>
      </section>
    </div>
  );
};
