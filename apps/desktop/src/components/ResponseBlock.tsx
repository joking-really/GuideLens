import React, { useState } from "react";
import { copyToClipboard } from "../lib/ipc";
import { isValidHighlightTarget } from "../lib/overlayGeometry";
import {
  type AskError,
  BRAIN_LABELS,
  type BrainKind,
  type BrainStatusPayload,
  clampInstruction,
  type ResolvedStep,
  type StepMode,
} from "../types";

export interface ResponseBlockProps {
  loading: boolean;
  brainStatus: BrainStatusPayload | null;
  error: AskError | null;
  mode: StepMode;
  step: ResolvedStep | null;
  stepIndex: number;
  totalSteps: number;
  magnify: boolean;
  highContrast: boolean;
  ttsEnabled?: boolean;
  isSpeaking?: boolean;
  liveTurnLabel?: string | null;
  liveStatusText?: string | null;
  onReplaySpeech?: () => void;
  onStopSpeech?: () => void;
  onOpenVoiceStudio?: () => void;
  onToggleMagnify: (next: boolean) => void;
  onNextStep: () => void;
  onClose: () => void;
  onFallback: (brain: BrainKind) => void;
}

export const ResponseBlock: React.FC<ResponseBlockProps> = ({
  loading,
  brainStatus,
  error,
  mode,
  step,
  stepIndex,
  totalSteps,
  magnify,
  highContrast,
  ttsEnabled,
  isSpeaking = false,
  liveTurnLabel = null,
  liveStatusText = null,
  onReplaySpeech,
  onStopSpeech,
  onOpenVoiceStudio,
  onToggleMagnify,
  onNextStep,
  onClose,
  onFallback,
}) => {
  const [copied, setCopied] = useState(false);

  if (!loading && !error && !step && !liveStatusText) {
    return null;
  }

  const handleCopyCommand = async (cmd: string) => {
    await copyToClipboard(cmd);
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  const containerClass = highContrast
    ? "bg-[#09090B]/95 backdrop-blur-2xl border-2 border-[#FACC15]"
    : "bg-[#111215]/95 backdrop-blur-2xl border border-white/[0.09]";

  if (loading || (liveStatusText && !step && !error)) {
    const statusText =
      liveStatusText ||
      brainStatus?.message ||
      (brainStatus?.state === "capturing"
        ? "Capturing active window..."
        : brainStatus?.state === "locating"
          ? "Snapping to UI Automation tree..."
          : "Analyzing screen...");

    return (
      <section
        role="status"
        aria-live="polite"
        aria-label="Assistant loading status"
        data-testid="response-loading"
        className={`${containerClass} mt-2 w-[620px] max-w-[96vw] rounded-2xl px-4 py-2.5 text-[#F4F4F5] shadow-2xl`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 text-[13px] text-[#E4E4E7] min-w-0">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-[#F4F4F5] animate-pulse shrink-0"
              aria-hidden="true"
            />
            <span className="truncate">{statusText}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel request"
            className="text-[11.5px] text-[#A1A1AA] hover:text-[#F4F4F5] px-2 py-0.5 rounded-lg hover:bg-white/[0.06] shrink-0 transition-colors"
          >
            Esc
          </button>
        </div>
      </section>
    );
  }

  if (error) {
    const mentionsGroq =
      error.brain === "groq_pro" ||
      error.message.toLowerCase().includes("groq");
    const isGroqTimeout =
      mentionsGroq &&
      (error.code === "timeout" ||
        error.message.toLowerCase().includes("timed out") ||
        error.message.toLowerCase().includes("timeout"));

    const headline = isGroqTimeout
      ? "Groq timed out — use Local?"
      : error.code === "rate_limited" || error.code === "quota"
        ? `${error.message} — switch brain?`
        : error.message;

    const rawFallbacks: BrainKind[] =
      error.fallbacks && error.fallbacks.length > 0
        ? error.fallbacks
        : ["local_vlm", "agent_cli"];
    const filteredFallbacks = rawFallbacks.filter((fb) => fb !== error.brain);
    const fallbacks =
      filteredFallbacks.length > 0 ? filteredFallbacks : rawFallbacks;

    return (
      <section
        role="alert"
        aria-label="Brain error and fallback options"
        data-testid="response-error"
        className={`${containerClass} mt-2 w-[620px] max-w-[96vw] rounded-2xl px-4 py-3 text-[#F4F4F5] shadow-2xl`}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13px] font-medium text-[#F4F4F5] leading-snug">
            {headline}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close error message"
            className="text-[11.5px] text-[#A1A1AA] hover:text-[#F4F4F5] px-2 py-0.5 rounded-lg hover:bg-white/[0.06] shrink-0 transition-colors"
          >
            Close (Esc)
          </button>
        </div>

        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          {fallbacks.map((fb) => (
            <button
              key={fb}
              type="button"
              onClick={() => onFallback(fb)}
              data-testid={`fallback-btn-${fb}`}
              className="px-3 py-1 rounded-lg text-[12px] font-medium bg-white/[0.05] text-[#E4E4E7] border border-white/[0.10] hover:bg-white/[0.10] transition-colors"
            >
              Use {BRAIN_LABELS[fb] ?? fb}
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (!step) {
    return null;
  }

  const isTerminal =
    mode === "terminal" || Boolean(step.terminal_command?.trim());
  const safeInstruction = clampInstruction(step.instruction_line);
  const safeExplanation = clampInstruction(
    step.explanation || step.instruction_line,
  );
  const safeSpokenWhisper =
    step.spoken_text &&
    clampInstruction(step.spoken_text).toLowerCase() !==
      safeInstruction.toLowerCase()
      ? clampInstruction(step.spoken_text)
      : null;
  const hasHighlightBox = isValidHighlightTarget(step);
  const displayStepNum = stepIndex + 1;
  const displayTotal = Math.max(totalSteps, displayStepNum);

  return (
    <section
      role="region"
      aria-live="polite"
      aria-label="Step guidance response"
      data-testid="response-block"
      className={`${containerClass} mt-2 w-[620px] max-w-[96vw] rounded-2xl px-4 py-3 text-[#F4F4F5] shadow-2xl transition-all`}
    >
      {isTerminal && step.terminal_command ? (
        <div data-testid="terminal-variant" className="space-y-2">
          <div className="flex items-center justify-between gap-2 rounded-xl bg-[#0A0B0D] border border-white/[0.08] px-3 py-2">
            <code
              data-testid="terminal-command-text"
              className="gl-mono text-[#F4F4F5] truncate select-all"
            >
              {step.terminal_command}
            </code>
            <button
              type="button"
              onClick={() => handleCopyCommand(step.terminal_command!)}
              aria-label={copied ? "Command copied" : "Copy terminal command"}
              data-testid="copy-command-btn"
              className={`shrink-0 px-2.5 py-1 rounded-lg text-[11.5px] font-medium border transition-colors ${
                copied
                  ? "bg-[#F4F4F5] text-[#0A0B0D] border-[#F4F4F5]"
                  : "bg-white/[0.05] text-[#E4E4E7] border-white/[0.10] hover:bg-white/[0.10]"
              }`}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p
            data-testid="terminal-explanation"
            className="text-[12.5px] text-[#A1A1AA] leading-snug"
          >
            {safeExplanation}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-start justify-between gap-2">
            <p
              data-testid="instruction-line"
              className="text-[13.5px] font-semibold text-[#F4F4F5] leading-snug"
            >
              {safeInstruction}
            </p>
            <div className="flex items-center gap-1.5 shrink-0">
              {step.action_kind && (
                <span
                  data-testid="step-action-kind"
                  className="px-2 py-0.5 rounded-md bg-white/[0.06] border border-white/[0.08] text-[10.5px] font-medium uppercase tracking-wide text-[#A1A1AA]"
                >
                  {step.action_kind}
                </span>
              )}
              {step.shortcut && (
                <kbd
                  data-testid="step-shortcut"
                  className="gl-mono shrink-0 px-2 py-0.5 rounded-md bg-white/[0.07] border border-white/[0.12] text-[11px] text-[#E4E4E7]"
                >
                  {step.shortcut}
                </kbd>
              )}
            </div>
          </div>

          {safeSpokenWhisper && (
            <p
              data-testid="spoken-whisper"
              className="text-[11.5px] text-[#A1A1AA] italic leading-snug"
            >
              “{safeSpokenWhisper}”
            </p>
          )}
        </div>
      )}

      {!isTerminal && mode === "guide" && !hasHighlightBox && (
        <div
          data-testid="low-confidence-notice"
          className="mt-1 text-[11.5px] text-[#71717A]"
        >
          Text-only guidance (target control not visually locked)
        </div>
      )}

      <div className="mt-2.5 pt-2 border-t border-white/[0.07] flex items-center justify-between gap-2 text-[11.5px]">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => onToggleMagnify(!magnify)}
            aria-label="Toggle Magnifier"
            aria-pressed={magnify}
            data-testid="magnify-toggle-btn"
            className={`px-2.5 py-0.5 rounded-lg border transition-colors ${
              magnify
                ? "bg-white/[0.12] text-[#F4F4F5] border-white/20 font-medium"
                : "bg-white/[0.04] text-[#A1A1AA] border-white/[0.08] hover:text-[#F4F4F5]"
            }`}
          >
            Magnify {magnify ? "On" : "Off"}
          </button>

          {(onReplaySpeech ||
            onStopSpeech ||
            isSpeaking ||
            ttsEnabled !== undefined) &&
            (isSpeaking ? (
              <button
                type="button"
                onClick={() => onStopSpeech?.()}
                aria-label="Stop speaking"
                title="Stop spoken guidance"
                data-testid="stop-speech-btn"
                className="flex items-center gap-1 px-2.5 py-0.5 rounded-lg border bg-white/[0.12] text-[#F4F4F5] border-white/20 hover:bg-white/[0.16] font-medium transition-colors"
              >
                <span
                  className="w-1.5 h-1.5 rounded-sm bg-current"
                  aria-hidden="true"
                />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onReplaySpeech?.()}
                aria-label="Speak step aloud"
                title="Speak or replay this step"
                data-testid="replay-speech-btn"
                className={`flex items-center gap-1 px-2.5 py-0.5 rounded-lg border transition-colors ${
                  ttsEnabled
                    ? "bg-white/[0.08] text-[#E4E4E7] border-white/[0.14] hover:bg-white/[0.12]"
                    : "bg-white/[0.04] text-[#A1A1AA] border-white/[0.08] hover:text-[#F4F4F5]"
                }`}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
                <span>Speak</span>
              </button>
            ))}

          <span
            aria-label={`Step ${displayStepNum} of ${displayTotal}`}
            data-testid="step-counter"
            className="px-2 py-0.5 rounded-md bg-white/[0.06] border border-white/[0.08] text-[#A1A1AA] font-medium text-[11px] tabular-nums"
          >
            {liveTurnLabel ?? `Step ${displayStepNum}/${displayTotal}`}
          </span>

          {step.goal_complete && (
            <span
              data-testid="goal-complete-badge"
              className="px-2 py-0.5 rounded-md bg-white/[0.10] border border-white/15 text-[#F4F4F5] font-medium text-[11px]"
            >
              Goal Complete
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {onOpenVoiceStudio && (
            <button
              type="button"
              onClick={onOpenVoiceStudio}
              aria-label="Open Voice Studio"
              title="Open Voice Studio"
              data-testid="response-voice-studio-btn"
              className="px-2 py-0.5 rounded-lg bg-white/[0.04] text-[#A1A1AA] border border-white/[0.08] hover:text-[#F4F4F5] hover:bg-white/[0.08] transition-colors"
            >
              Voice
            </button>
          )}
          {displayStepNum < displayTotal && (
            <button
              type="button"
              onClick={onNextStep}
              aria-label="Next step (Tab or Enter)"
              data-testid="next-step-btn"
              className="px-2.5 py-0.5 rounded-lg bg-[#F4F4F5] text-[#0A0B0D] hover:bg-white font-medium transition-colors"
            >
              Next →
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close overlay (Escape)"
            data-testid="close-response-btn"
            className="px-2.5 py-0.5 rounded-lg bg-white/[0.04] text-[#A1A1AA] border border-white/[0.08] hover:text-[#F4F4F5] hover:bg-white/[0.08] transition-colors"
          >
            {displayStepNum >= displayTotal ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </section>
  );
};
