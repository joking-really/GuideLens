import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  copyToClipboard,
  historyGet,
  historyList,
  screendayGenerateSummary,
  screendayGetDay,
  screendayListDays,
  toAssetUrl,
} from "../lib/ipc";
import {
  BRAIN_LABELS,
  type HistoryDetail,
  type HistorySession,
  type ScreenDayDetailDto,
  type ScreenDayFrameDto,
  type ScreenDayStatusDto,
  type ScreenDaySummaryDto,
} from "../types";
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  DiaryIcon,
  EyeIcon,
  FolderIcon,
  RefreshIcon,
  ZapIcon,
} from "./HubIcons";

export interface ScreenDayTabProps {
  screenDayStatus: ScreenDayStatusDto;
  onToggleScreenDay: (enabled: boolean) => Promise<void> | void;
  focusHistorySeq?: number;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(epochSec: number): string {
  if (!epochSec) return "--:--";
  return new Date(epochSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTimeRange(startSec: number, endSec: number): string {
  if (!startSec) return "Recorded session";
  if (!endSec || endSec <= startSec) return formatTime(startSec);
  return `${formatTime(startSec)} – ${formatTime(endSec)}`;
}

export const ScreenDayTab: React.FC<ScreenDayTabProps> = ({
  screenDayStatus,
  onToggleScreenDay,
  focusHistorySeq = 0,
}) => {
  const [days, setDays] = useState<ScreenDaySummaryDto[]>([]);
  const [selectedDayKey, setSelectedDayKey] = useState<string>(
    screenDayStatus.today_key,
  );
  const [dayDetail, setDayDetail] = useState<ScreenDayDetailDto | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0);
  const [generatingWrapUp, setGeneratingWrapUp] = useState(false);
  const [wrapUpFeedback, setWrapUpFeedback] = useState<string | null>(null);
  const [copiedFolder, setCopiedFolder] = useState(false);
  const [modalContent, setModalContent] = useState<{
    title: string;
    body: string;
  } | null>(null);

  // Legacy Guided Session History (SQLite)
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [selectedHistory, setSelectedHistory] = useState<HistoryDetail | null>(
    null,
  );
  const [copiedStepCmd, setCopiedStepCmd] = useState<number | null>(null);
  const historySectionRef = useRef<HTMLElement | null>(null);

  const loadDaysAndDetail = useCallback(
    async (preferredDay?: string) => {
      setLoadingDay(true);
      try {
        const [listedDays, historyRows] = await Promise.all([
          screendayListDays(30),
          historyList(50),
        ]);
        setDays(listedDays);
        setSessions(historyRows);

        const targetDay =
          preferredDay ||
          (listedDays.length > 0
            ? listedDays[0].day_key
            : screenDayStatus.today_key);
        setSelectedDayKey(targetDay);

        const detail = await screendayGetDay(targetDay);
        setDayDetail(detail);
        setSelectedFrameIndex(
          detail && detail.frames.length > 0 ? detail.frames.length - 1 : 0,
        );
      } catch {
        // Ignore preview/browser errors
      } finally {
        setLoadingDay(false);
      }
    },
    [screenDayStatus.today_key],
  );

  useEffect(() => {
    void loadDaysAndDetail();
  }, [loadDaysAndDetail]);

  useEffect(() => {
    if (focusHistorySeq > 0) {
      historySectionRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [focusHistorySeq]);

  const handleSelectDay = async (dayKey: string) => {
    setSelectedDayKey(dayKey);
    setLoadingDay(true);
    setWrapUpFeedback(null);
    try {
      const detail = await screendayGetDay(dayKey);
      setDayDetail(detail);
      setSelectedFrameIndex(
        detail && detail.frames.length > 0 ? detail.frames.length - 1 : 0,
      );
    } finally {
      setLoadingDay(false);
    }
  };

  const handleGenerateWrapUp = async () => {
    const key = selectedDayKey || screenDayStatus.today_key;
    setGeneratingWrapUp(true);
    setWrapUpFeedback(null);
    try {
      const updated = await screendayGenerateSummary(key);
      if (updated) {
        setDayDetail(updated);
        setWrapUpFeedback("Nightly diary & .graph.md wrap-up generated.");
      } else {
        setWrapUpFeedback("No frames captured for this date yet.");
      }
    } catch (err) {
      setWrapUpFeedback(
        err instanceof Error ? err.message : "Failed to generate summary.",
      );
    } finally {
      setGeneratingWrapUp(false);
    }
  };

  const handleSelectHistorySession = async (sessionId: string) => {
    try {
      const detail = await historyGet(sessionId);
      setSelectedHistory(detail);
    } catch {
      // Ignore error
    }
  };

  const frames: ScreenDayFrameDto[] = dayDetail?.frames ?? [];
  const clampedFrameIdx =
    frames.length > 0
      ? Math.min(Math.max(0, selectedFrameIndex), frames.length - 1)
      : 0;
  const activeFrame = frames[clampedFrameIdx] ?? null;
  const activeFrameUrl = activeFrame
    ? toAssetUrl(activeFrame.image_path)
    : null;

  const summary = useMemo<ScreenDaySummaryDto | null>(() => {
    if (dayDetail?.summary) return dayDetail.summary;
    return days.find((d) => d.day_key === selectedDayKey) ?? null;
  }, [dayDetail, days, selectedDayKey]);

  const dayOptions = useMemo(() => {
    const keys = new Set(days.map((d) => d.day_key));
    if (screenDayStatus.today_key && !keys.has(screenDayStatus.today_key)) {
      return [screenDayStatus.today_key, ...days.map((d) => d.day_key)];
    }
    return days.map((d) => d.day_key);
  }, [days, screenDayStatus.today_key]);

  return (
    <div className="space-y-5" data-testid="panel-diary">
      <div className="space-y-5" data-testid="panel-history">
        {/* Top Action & Date Toolbar */}
        <section className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <DiaryIcon className="w-4 h-4 text-emerald-300" />
              <label
                htmlFor="screenday-date-select"
                className="text-[12.5px] font-semibold text-zinc-100"
              >
                Diary Date
              </label>
            </div>
            <select
              id="screenday-date-select"
              data-testid="screenday-date-select"
              value={selectedDayKey}
              onChange={(e) => void handleSelectDay(e.target.value)}
              className="rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12.5px] font-mono text-zinc-100 focus:outline-none focus:border-sky-400"
            >
              {dayOptions.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>

            {summary?.folder_path && (
              <button
                type="button"
                data-testid="copy-day-folder-btn"
                onClick={async () => {
                  await copyToClipboard(summary.folder_path);
                  setCopiedFolder(true);
                  window.setTimeout(() => setCopiedFolder(false), 1800);
                }}
                title={summary.folder_path}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 text-[11.5px] text-zinc-300"
              >
                {copiedFolder ? (
                  <CheckIcon className="w-3.5 h-3.5 text-emerald-300" />
                ) : (
                  <FolderIcon className="w-3.5 h-3.5 text-sky-300" />
                )}
                <span className="font-mono max-w-[200px] truncate">
                  {copiedFolder ? "Path Copied!" : summary.folder_path}
                </span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void onToggleScreenDay(!screenDayStatus.enabled)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[12px] font-medium transition-colors ${
                screenDayStatus.enabled
                  ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-300"
                  : "bg-white/[0.05] border-white/10 text-zinc-300 hover:bg-white/[0.09]"
              }`}
            >
              <EyeIcon className="w-3.5 h-3.5" />
              {screenDayStatus.enabled ? "Recording Live" : "Screen Day Off"}
            </button>

            {dayDetail?.day_graph_md && (
              <button
                type="button"
                data-testid="open-day-graph-modal-btn"
                onClick={() =>
                  setModalContent({
                    title: `${selectedDayKey} · day-graph.md`,
                    body: dayDetail.day_graph_md || "",
                  })
                }
                className="px-3 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 text-[12px] text-zinc-200 font-medium"
              >
                View .graph.md
              </button>
            )}

            <button
              type="button"
              data-testid="generate-nightly-wrapup-btn"
              onClick={() => void handleGenerateWrapUp()}
              disabled={generatingWrapUp}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-sky-400 hover:bg-sky-300 text-slate-950 font-semibold text-[12px] disabled:opacity-40"
            >
              <ZapIcon className="w-3.5 h-3.5" />
              {generatingWrapUp
                ? "Generating Wrap-Up…"
                : "Generate Nightly Wrap-Up"}
            </button>

            <button
              type="button"
              onClick={() => void loadDaysAndDetail(selectedDayKey)}
              aria-label="Refresh Screen Day"
              className="p-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 text-zinc-300"
            >
              <RefreshIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </section>

        {wrapUpFeedback && (
          <div className="rounded-xl bg-sky-400/10 border border-sky-400/30 px-4 py-2 text-[12px] text-sky-200">
            {wrapUpFeedback}
          </div>
        )}

        {/* Compressed Visual Timeline Scrub Strip */}
        <section className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold text-zinc-100">
                Visual Timeline Scrub
              </h2>
              <p className="text-[11.5px] text-zinc-400">
                {frames.length > 0
                  ? `${frames.length} compressed frames (${formatBytes(
                      summary?.total_bytes ?? 0,
                    )}) · Scrub or click any frame`
                  : loadingDay
                    ? "Loading visual diary frames…"
                    : "No frames captured for this day yet. Enable Screen Day to begin your visual diary."}
              </p>
            </div>
            {activeFrame && (
              <span className="font-mono text-[11.5px] px-2.5 py-1 rounded-full bg-white/[0.06] border border-white/10 text-sky-300">
                {clampedFrameIdx + 1} / {frames.length} ·{" "}
                {formatTime(activeFrame.captured_at)}
              </span>
            )}
          </div>

          {frames.length > 0 && activeFrame ? (
            <div className="space-y-4">
              {/* Main Selected Frame Stage */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-7 rounded-xl bg-[#090B10] border border-white/10 overflow-hidden aspect-video flex items-center justify-center">
                  {activeFrameUrl ? (
                    <img
                      src={activeFrameUrl}
                      alt={`${activeFrame.active_app} — ${activeFrame.window_title}`}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="text-[12px] text-zinc-500">
                      Preview unavailable
                    </div>
                  )}
                </div>

                <div className="lg:col-span-5 rounded-xl bg-[#090B10]/90 border border-white/[0.08] p-4 flex flex-col justify-between gap-3">
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between text-[11.5px]">
                      <span className="font-mono text-sky-300">
                        {activeFrame.active_app}
                      </span>
                      <span className="text-zinc-500">
                        {formatBytes(activeFrame.file_bytes)}
                      </span>
                    </div>
                    <h3 className="text-[13px] font-semibold text-zinc-100 leading-snug break-words">
                      {activeFrame.window_title || "Untitled Window"}
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {activeFrame.project_name && (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-400/30 text-[11px] text-emerald-300">
                          Project: {activeFrame.project_name}
                        </span>
                      )}
                      {activeFrame.meeting_name && (
                        <span className="px-2 py-0.5 rounded-md bg-indigo-500/15 border border-indigo-400/30 text-[11px] text-indigo-300">
                          Meeting: {activeFrame.meeting_name}
                        </span>
                      )}
                    </div>
                    <div className="pt-1">
                      <div className="text-[11px] font-medium text-zinc-400 mb-1">
                        On-Screen OCR Context
                      </div>
                      <p className="text-[11.5px] text-zinc-300 bg-white/[0.03] border border-white/[0.06] rounded-lg p-2.5 max-h-28 overflow-y-auto leading-relaxed">
                        {activeFrame.ocr_excerpt ||
                          "No readable OCR text indexed for this frame."}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Scrub Slider */}
              <div className="space-y-2">
                <input
                  type="range"
                  aria-label="Timeline Scrub Slider"
                  data-testid="screenday-scrub-slider"
                  min={0}
                  max={Math.max(0, frames.length - 1)}
                  value={clampedFrameIdx}
                  onChange={(e) =>
                    setSelectedFrameIndex(Number(e.target.value))
                  }
                  className="w-full accent-sky-400 cursor-pointer"
                />

                {/* Thumbnail Strip */}
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  {frames.map((frame, idx) => {
                    const thumbUrl = toAssetUrl(frame.image_path);
                    const selected = idx === clampedFrameIdx;
                    return (
                      <button
                        key={frame.id || idx}
                        type="button"
                        onClick={() => setSelectedFrameIndex(idx)}
                        className={`shrink-0 w-28 rounded-lg overflow-hidden border text-left transition-all ${
                          selected
                            ? "border-sky-400 ring-2 ring-sky-400/40"
                            : "border-white/10 opacity-75 hover:opacity-100"
                        }`}
                      >
                        <div className="h-14 bg-[#090B10] flex items-center justify-center overflow-hidden">
                          {thumbUrl ? (
                            <img
                              src={thumbUrl}
                              alt={frame.active_app}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <span className="text-[10px] text-zinc-500">
                              Frame
                            </span>
                          )}
                        </div>
                        <div className="px-1.5 py-1 bg-[#090B10] flex items-center justify-between text-[10px] text-zinc-400">
                          <span className="truncate">{frame.active_app}</span>
                          <span className="font-mono shrink-0 ml-1">
                            {formatTime(frame.captured_at)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-[#090B10]/70 border border-dashed border-white/10 p-6 text-center text-[12.5px] text-zinc-400">
              No screenshots recorded for {selectedDayKey}. Turn on{" "}
              <strong className="text-zinc-200">Record My Day</strong> in
              Overview or click Capture Frame Now.
            </div>
          )}
        </section>

        {/* Projects Worked On & Meetings Attended */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Projects Worked On */}
          <section
            data-testid="screenday-projects-section"
            className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[13.5px] font-semibold text-zinc-100">
                Projects Worked On
              </h2>
              <span className="text-[11px] font-mono text-zinc-400">
                {dayDetail?.project_groups.length ?? 0} projects
              </span>
            </div>

            {dayDetail && dayDetail.project_groups.length > 0 ? (
              <div className="space-y-2">
                {dayDetail.project_groups.map((proj) => (
                  <div
                    key={proj.name}
                    className="rounded-xl bg-[#090B10]/90 border border-white/[0.07] p-3 flex items-start justify-between gap-3"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="text-[13px] font-semibold text-emerald-300 truncate">
                        {proj.name}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {proj.apps.map((app) => (
                          <span
                            key={app}
                            className="px-2 py-0.5 rounded bg-white/[0.05] text-[10.5px] font-mono text-zinc-300"
                          >
                            {app}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span className="shrink-0 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[11px] font-mono">
                      {proj.frame_count} frames
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-zinc-500 py-3">
                No project activity detected for {selectedDayKey}.
              </p>
            )}
          </section>

          {/* Meetings Attended (with OCR Screen Topics) */}
          <section
            data-testid="screenday-meetings-section"
            className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[13.5px] font-semibold text-zinc-100">
                Meetings Attended &amp; Screen Topics
              </h2>
              <span className="text-[11px] font-mono text-zinc-400">
                {dayDetail?.meeting_groups.length ?? 0} meetings
              </span>
            </div>

            {dayDetail && dayDetail.meeting_groups.length > 0 ? (
              <div className="space-y-2.5">
                {dayDetail.meeting_groups.map((mtg, idx) => (
                  <div
                    key={`${mtg.name}-${idx}`}
                    className="rounded-xl bg-[#090B10]/90 border border-indigo-400/20 p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-indigo-300 truncate">
                        {mtg.name}
                      </span>
                      <span className="text-[11px] font-mono text-zinc-400 shrink-0">
                        {formatTimeRange(mtg.started_at, mtg.ended_at)} (
                        {mtg.frame_count})
                      </span>
                    </div>
                    {mtg.screen_topics.length > 0 ? (
                      <div className="space-y-1">
                        <div className="text-[10.5px] uppercase tracking-wider text-zinc-500">
                          OCR Topics Captured On Screen
                        </div>
                        <ul className="space-y-1">
                          {mtg.screen_topics.map((topic, tIdx) => (
                            <li
                              key={tIdx}
                              className="text-[11.5px] text-zinc-300 bg-white/[0.03] rounded px-2 py-1 border border-white/[0.05]"
                            >
                              {topic}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="text-[11px] text-zinc-500">
                        No screen-shared text extracted during this call.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-zinc-500 py-3">
                Zoom, Teams, Google Meet, Slack Huddles &amp; Discord calls
                appear here with what was shown on screen.
              </p>
            )}
          </section>
        </div>

        {/* AI Nightly Wrap-Up / Day Diary Markdown */}
        {(summary?.summary_md || dayDetail?.day_diary_md) && (
          <section className="rounded-2xl bg-[#11141D]/90 border border-sky-400/25 p-5 space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-[13.5px] font-semibold text-sky-200">
                Nightly Wrap-Up &amp; Daily Digest
              </h2>
              <button
                type="button"
                onClick={() =>
                  void copyToClipboard(
                    summary?.summary_md || dayDetail?.day_diary_md || "",
                  )
                }
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-[11.5px] text-zinc-200"
              >
                <CopyIcon className="w-3.5 h-3.5" />
                Copy Markdown
              </button>
            </div>
            <pre className="whitespace-pre-wrap font-sans text-[12.5px] text-zinc-200 bg-[#090B10]/85 border border-white/[0.08] rounded-xl p-3.5 max-h-64 overflow-y-auto leading-relaxed">
              {summary?.summary_md || dayDetail?.day_diary_md}
            </pre>
          </section>
        )}

        {/* Guided Sessions History (SQLite) */}
        <section
          ref={historySectionRef}
          className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[13.5px] font-semibold text-zinc-100">
                Guided Sessions History (SQLite)
              </h2>
              <p className="text-[11.5px] text-zinc-400">
                Step-by-step replay of past Ask &amp; Live Guidance sessions
              </p>
            </div>
            <span className="text-[11px] font-mono text-zinc-400">
              {sessions.length} sessions
            </span>
          </div>

          {sessions.length === 0 ? (
            <p className="text-[12.5px] text-zinc-500 py-4 text-center">
              No guided sessions recorded in local SQLite yet.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <ul
                aria-label="Session History List"
                data-testid="history-session-list"
                className="space-y-2 max-h-72 overflow-y-auto pr-1"
              >
                {sessions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => void handleSelectHistorySession(s.id)}
                      data-testid={`history-item-${s.id}`}
                      className={`w-full text-left rounded-xl p-3 border transition-colors ${
                        selectedHistory?.session.id === s.id
                          ? "bg-sky-400/15 border-sky-400"
                          : "bg-[#090B10]/80 border-white/10 hover:bg-white/[0.06]"
                      }`}
                    >
                      <div className="flex items-center justify-between text-[11.5px] text-zinc-400">
                        <span className="font-mono text-sky-300">
                          {s.active_app}
                        </span>
                        <span>{BRAIN_LABELS[s.brain_used] ?? s.brain_used}</span>
                      </div>
                      <div className="text-[13px] font-medium text-zinc-100 mt-1 truncate">
                        {s.user_query}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>

              <div
                data-testid="history-session-detail"
                className="rounded-xl bg-[#090B10]/85 border border-white/10 p-3.5 space-y-2.5"
              >
                {selectedHistory ? (
                  <>
                    <h3 className="text-[13px] font-semibold text-zinc-100">
                      {selectedHistory.session.user_query}
                    </h3>
                    <ol className="space-y-2 text-[12.5px]">
                      {selectedHistory.steps.map((st) => (
                        <li
                          key={st.step_number}
                          className="rounded-lg bg-[#11141D] p-2.5 space-y-1.5 border border-white/10"
                        >
                          <div>
                            <span className="text-sky-300 font-semibold mr-1.5">
                              Step {st.step_number}:
                            </span>
                            <span className="text-zinc-100">
                              {st.instruction_line}
                            </span>
                          </div>
                          {st.terminal_command && (
                            <div className="flex items-center justify-between gap-2 bg-black px-2.5 py-1.5 rounded border border-white/10">
                              <code className="gl-mono text-zinc-100 truncate">
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
                                    ? "bg-emerald-500/20 text-emerald-300"
                                    : "bg-white/10 text-zinc-100"
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
                  <p className="text-[12.5px] text-zinc-500">
                    Select a session on the left to inspect its steps.
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

        {/* .graph.md Preview Modal */}
        {modalContent && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={modalContent.title}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <div className="w-full max-w-3xl rounded-2xl bg-[#11141D] border border-white/15 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
              <header className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <span className="font-mono text-[12.5px] text-sky-300">
                  {modalContent.title}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void copyToClipboard(modalContent.body)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-[11.5px] text-zinc-100"
                  >
                    <CopyIcon className="w-3.5 h-3.5" />
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => setModalContent(null)}
                    aria-label="Close Preview"
                    className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300"
                  >
                    <CloseIcon className="w-4 h-4" />
                  </button>
                </div>
              </header>
              <pre className="p-4 overflow-auto text-[12px] gl-mono text-zinc-200 leading-relaxed whitespace-pre-wrap">
                {modalContent.body}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
