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
  ChevronDownIcon,
  CloseIcon,
  CopyIcon,
  FolderIcon,
  RefreshIcon,
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

  // Guided Session History (collapsible drawer)
  const [historyOpen, setHistoryOpen] = useState(focusHistorySeq > 0);
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
      setHistoryOpen(true);
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
        setWrapUpFeedback("Daily summary & .graph.md updated.");
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
    <div className="space-y-4" data-testid="panel-diary">
      <div className="space-y-4" data-testid="panel-history">
        {/* Date Selector & Toolbar */}
        <section className="rounded-xl bg-[#111317] border border-white/[0.07] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <select
              id="screenday-date-select"
              aria-label="Diary Date"
              data-testid="screenday-date-select"
              value={selectedDayKey}
              onChange={(e) => void handleSelectDay(e.target.value)}
              className="rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] font-mono text-[#F4F4F5] focus:outline-none focus:border-white/25"
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
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[11.5px] text-[#8E929B] hover:text-[#F4F4F5] transition-colors"
              >
                {copiedFolder ? (
                  <CheckIcon className="w-3.5 h-3.5 text-[#F4F4F5]" />
                ) : (
                  <FolderIcon className="w-3.5 h-3.5 text-[#8E929B]" />
                )}
                <span className="font-mono max-w-[180px] truncate">
                  {copiedFolder ? "Copied" : summary.folder_path}
                </span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void onToggleScreenDay(!screenDayStatus.enabled)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[12px] text-[#E4E4E7] font-medium transition-colors"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  screenDayStatus.enabled ? "bg-emerald-400" : "bg-[#5C606A]"
                }`}
              />
              {screenDayStatus.enabled ? "Live" : "Paused"}
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
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[12px] text-[#E4E4E7] font-medium transition-colors"
              >
                View .graph.md
              </button>
            )}

            <button
              type="button"
              data-testid="generate-nightly-wrapup-btn"
              onClick={() => void handleGenerateWrapUp()}
              disabled={generatingWrapUp}
              className="px-3.5 py-1.5 rounded-lg bg-[#F4F4F5] hover:bg-white text-[#0A0B0D] font-medium text-[12px] disabled:opacity-40 transition-colors"
            >
              {generatingWrapUp ? "Generating…" : "Generate Summary"}
            </button>

            <button
              type="button"
              onClick={() => void loadDaysAndDetail(selectedDayKey)}
              aria-label="Refresh Screen Day"
              className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#8E929B] hover:text-[#F4F4F5] transition-colors"
            >
              <RefreshIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </section>

        {wrapUpFeedback && (
          <div className="rounded-lg bg-[#111317] border border-white/[0.07] px-3.5 py-2 text-[12px] text-[#8E929B]">
            {wrapUpFeedback}
          </div>
        )}

        {/* Quiet Monochrome Screenshot Frame Viewer & Scrubber */}
        <section className="rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                Visual Timeline
              </h2>
              <p className="text-[12px] text-[#8E929B]">
                {frames.length > 0
                  ? `${frames.length} frames · ${formatBytes(summary?.total_bytes ?? 0)}`
                  : loadingDay
                    ? "Loading frames…"
                    : "No frames captured for this day."}
              </p>
            </div>
            {activeFrame && (
              <span className="font-mono text-[11.5px] text-[#8E929B]">
                {clampedFrameIdx + 1} / {frames.length} ·{" "}
                {formatTime(activeFrame.captured_at)}
              </span>
            )}
          </div>

          {frames.length > 0 && activeFrame ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-7 rounded-lg bg-[#0A0B0D] border border-white/[0.07] overflow-hidden aspect-video flex items-center justify-center">
                  {activeFrameUrl ? (
                    <img
                      src={activeFrameUrl}
                      alt={`${activeFrame.active_app} — ${activeFrame.window_title}`}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="text-[12px] text-[#5C606A]">
                      Preview unavailable
                    </div>
                  )}
                </div>

                <div className="lg:col-span-5 rounded-lg bg-[#0A0B0D] border border-white/[0.07] p-4 flex flex-col justify-between gap-3">
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between text-[11.5px]">
                      <span className="font-mono text-[#F4F4F5]">
                        {activeFrame.active_app}
                      </span>
                      <span className="font-mono text-[#5C606A]">
                        {formatBytes(activeFrame.file_bytes)}
                      </span>
                    </div>
                    <h3 className="text-[13px] font-medium text-[#F4F4F5] leading-snug break-words">
                      {activeFrame.window_title || "Untitled Window"}
                    </h3>
                    {(activeFrame.project_name || activeFrame.meeting_name) && (
                      <div className="flex flex-wrap gap-1.5">
                        {activeFrame.project_name && (
                          <span className="px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.07] text-[11px] text-[#E4E4E7]">
                            {activeFrame.project_name}
                          </span>
                        )}
                        {activeFrame.meeting_name && (
                          <span className="px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.07] text-[11px] text-[#8E929B]">
                            {activeFrame.meeting_name}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="pt-1">
                      <div className="text-[11px] text-[#5C606A] mb-1">
                        OCR Context
                      </div>
                      <p className="text-[11.5px] text-[#8E929B] bg-[#111317] border border-white/[0.06] rounded-md p-2.5 max-h-28 overflow-y-auto leading-relaxed">
                        {activeFrame.ocr_excerpt ||
                          "No readable OCR text indexed for this frame."}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Hairline Scrubber */}
              <div className="space-y-2.5 pt-1">
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
                  className="w-full h-1 accent-[#F4F4F5] cursor-pointer"
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
                            ? "border-[#F4F4F5]"
                            : "border-white/[0.07] opacity-65 hover:opacity-100"
                        }`}
                      >
                        <div className="h-14 bg-[#0A0B0D] flex items-center justify-center overflow-hidden">
                          {thumbUrl ? (
                            <img
                              src={thumbUrl}
                              alt={frame.active_app}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <span className="text-[10px] text-[#5C606A]">
                              Frame
                            </span>
                          )}
                        </div>
                        <div className="px-1.5 py-1 bg-[#0A0B0D] flex items-center justify-between text-[10px] text-[#8E929B]">
                          <span className="truncate">{frame.active_app}</span>
                          <span className="font-mono shrink-0 ml-1 text-[#5C606A]">
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
            <div className="rounded-lg bg-[#0A0B0D] border border-white/[0.07] p-6 text-center text-[12.5px] text-[#8E929B]">
              No screenshots recorded for {selectedDayKey}. Enable Screen Day or
              capture a frame from Overview.
            </div>
          )}
        </section>

        {/* Tidy 2-Column Projects & Meetings Lists */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section
            data-testid="screenday-projects-section"
            className="rounded-xl bg-[#111317] border border-white/[0.07] p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-[#F4F4F5]">
                Projects
              </h2>
              <span className="text-[11px] font-mono text-[#5C606A]">
                {dayDetail?.project_groups.length ?? 0}
              </span>
            </div>

            {dayDetail && dayDetail.project_groups.length > 0 ? (
              <div className="divide-y divide-white/[0.06]">
                {dayDetail.project_groups.map((proj) => (
                  <div
                    key={proj.name}
                    className="py-2.5 first:pt-0 last:pb-0 flex items-start justify-between gap-3"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="text-[13px] font-medium text-[#F4F4F5] truncate">
                        {proj.name}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {proj.apps.map((app) => (
                          <span
                            key={app}
                            className="px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.06] text-[10.5px] font-mono text-[#8E929B]"
                          >
                            {app}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] font-mono text-[#5C606A]">
                      {proj.frame_count} frames
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-[#5C606A] py-2">
                No project activity detected for {selectedDayKey}.
              </p>
            )}
          </section>

          <section
            data-testid="screenday-meetings-section"
            className="rounded-xl bg-[#111317] border border-white/[0.07] p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-[#F4F4F5]">
                Meetings
              </h2>
              <span className="text-[11px] font-mono text-[#5C606A]">
                {dayDetail?.meeting_groups.length ?? 0}
              </span>
            </div>

            {dayDetail && dayDetail.meeting_groups.length > 0 ? (
              <div className="divide-y divide-white/[0.06]">
                {dayDetail.meeting_groups.map((mtg, idx) => (
                  <div
                    key={`${mtg.name}-${idx}`}
                    className="py-2.5 first:pt-0 last:pb-0 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-[#F4F4F5] truncate">
                        {mtg.name}
                      </span>
                      <span className="text-[11px] font-mono text-[#5C606A] shrink-0">
                        {formatTimeRange(mtg.started_at, mtg.ended_at)} ·{" "}
                        {mtg.frame_count}
                      </span>
                    </div>
                    {mtg.screen_topics.length > 0 ? (
                      <ul className="space-y-1">
                        {mtg.screen_topics.map((topic, tIdx) => (
                          <li
                            key={tIdx}
                            className="text-[11.5px] text-[#8E929B] bg-[#0A0B0D] rounded px-2.5 py-1 border border-white/[0.06]"
                          >
                            {topic}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[11px] text-[#5C606A]">
                        No screen-shared text extracted.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-[#5C606A] py-2">
                Detected calls and screen-shared OCR topics appear here.
              </p>
            )}
          </section>
        </div>

        {/* Daily Summary Markdown */}
        {(summary?.summary_md || dayDetail?.day_diary_md) && (
          <section className="rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-[#F4F4F5]">
                Daily Summary
              </h2>
              <button
                type="button"
                onClick={() =>
                  void copyToClipboard(
                    summary?.summary_md || dayDetail?.day_diary_md || "",
                  )
                }
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[11.5px] text-[#E4E4E7]"
              >
                <CopyIcon className="w-3.5 h-3.5" />
                Copy
              </button>
            </div>
            <pre className="whitespace-pre-wrap font-sans text-[12.5px] text-[#8E929B] bg-[#0A0B0D] border border-white/[0.07] rounded-lg p-3.5 max-h-60 overflow-y-auto leading-relaxed">
              {summary?.summary_md || dayDetail?.day_diary_md}
            </pre>
          </section>
        )}

        {/* Collapsible Guided Session History */}
        <section
          ref={historySectionRef}
          className="rounded-xl bg-[#111317] border border-white/[0.07] overflow-hidden"
        >
          <button
            type="button"
            data-testid="toggle-guided-history-btn"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((prev) => !prev)}
            className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-[#17191E] transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-[13px] font-semibold text-[#F4F4F5]">
                Guided Session History
              </span>
              <span className="text-[11px] font-mono text-[#5C606A]">
                {sessions.length}
              </span>
            </div>
            <ChevronDownIcon
              className={`w-4 h-4 text-[#8E929B] transition-transform ${
                historyOpen ? "rotate-180" : ""
              }`}
            />
          </button>

          {historyOpen && (
            <div className="px-5 pb-5 pt-2 border-t border-white/[0.06]">
              {sessions.length === 0 ? (
                <p className="text-[12px] text-[#5C606A] py-3">
                  No guided sessions recorded yet.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                  <ul
                    aria-label="Session History List"
                    data-testid="history-session-list"
                    className="space-y-1.5 max-h-72 overflow-y-auto pr-1"
                  >
                    {sessions.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => void handleSelectHistorySession(s.id)}
                          data-testid={`history-item-${s.id}`}
                          className={`w-full text-left rounded-lg p-3 border transition-colors ${
                            selectedHistory?.session.id === s.id
                              ? "bg-[#17191E] border-white/25"
                              : "bg-[#0A0B0D] border-white/[0.07] hover:bg-white/[0.03]"
                          }`}
                        >
                          <div className="flex items-center justify-between text-[11px] text-[#8E929B]">
                            <span className="font-mono text-[#F4F4F5]">
                              {s.active_app}
                            </span>
                            <span>
                              {BRAIN_LABELS[s.brain_used] ?? s.brain_used}
                            </span>
                          </div>
                          <div className="text-[12.5px] font-medium text-[#F4F4F5] mt-1 truncate">
                            {s.user_query}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>

                  <div
                    data-testid="history-session-detail"
                    className="rounded-lg bg-[#0A0B0D] border border-white/[0.07] p-3.5 space-y-2.5"
                  >
                    {selectedHistory ? (
                      <>
                        <h3 className="text-[13px] font-semibold text-[#F4F4F5]">
                          {selectedHistory.session.user_query}
                        </h3>
                        <ol className="space-y-2 text-[12px]">
                          {selectedHistory.steps.map((st) => (
                            <li
                              key={st.step_number}
                              className="rounded-lg bg-[#111317] p-2.5 space-y-1.5 border border-white/[0.07]"
                            >
                              <div>
                                <span className="text-[#8E929B] font-mono mr-1.5">
                                  {st.step_number}.
                                </span>
                                <span className="text-[#F4F4F5]">
                                  {st.instruction_line}
                                </span>
                              </div>
                              {st.terminal_command && (
                                <div className="flex items-center justify-between gap-2 bg-[#0A0B0D] px-2.5 py-1.5 rounded border border-white/[0.07]">
                                  <code className="gl-mono text-[#F4F4F5] truncate">
                                    {st.terminal_command}
                                  </code>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      await copyToClipboard(
                                        st.terminal_command!,
                                      );
                                      setCopiedStepCmd(st.step_number);
                                      window.setTimeout(
                                        () => setCopiedStepCmd(null),
                                        2000,
                                      );
                                    }}
                                    className="px-2 py-0.5 rounded bg-white/[0.06] hover:bg-white/[0.1] text-[11px] text-[#E4E4E7]"
                                  >
                                    {copiedStepCmd === st.step_number
                                      ? "Copied"
                                      : "Copy"}
                                  </button>
                                </div>
                              )}
                            </li>
                          ))}
                        </ol>
                      </>
                    ) : (
                      <p className="text-[12px] text-[#5C606A]">
                        Select a session to inspect its steps.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* .graph.md Preview Modal */}
        {modalContent && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={modalContent.title}
            className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <div className="w-full max-w-3xl rounded-xl bg-[#111317] border border-white/[0.12] shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
              <header className="flex items-center justify-between px-4 py-3 border-b border-white/[0.07]">
                <span className="font-mono text-[12.5px] text-[#F4F4F5]">
                  {modalContent.title}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void copyToClipboard(modalContent.body)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[11.5px] text-[#E4E4E7]"
                  >
                    <CopyIcon className="w-3.5 h-3.5" />
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => setModalContent(null)}
                    aria-label="Close Preview"
                    className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-[#8E929B] hover:text-[#F4F4F5]"
                  >
                    <CloseIcon className="w-4 h-4" />
                  </button>
                </div>
              </header>
              <pre className="p-4 overflow-auto text-[12px] gl-mono text-[#E4E4E7] bg-[#0A0B0D] leading-relaxed whitespace-pre-wrap">
                {modalContent.body}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
