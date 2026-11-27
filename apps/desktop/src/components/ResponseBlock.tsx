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
  sessionId?: string | null;
  resolutionTier?: string | null;
  tokensSaved?: number | null;
  playbookId?: string | null;
  feedbackSubmitted?: "worked" | "wrong" | null;
  onReAskAi?: () => void;
  onFeedback?: (worked: boolean) => void;
  onReplaySpeech?: () => void;
  onStopSpeech?: () => void;
  onOpenVoiceStudio?: () => void;
  onToggleMagnify: (next: boolean) => void;
  onNextStep: () => void;
  onClose: () => void;
  onFallback: (brain: BrainKind) => void;
}

function formatTokensSaved(tokensSaved?: number | null): string {
  const val = tokensSaved ?? 1400;
  if (val >= 1000) {
    return `~${(val / 1000).toFixed(1)}k tokens saved`;
  }
  return `~${val} tokens saved`;
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
  sessionId = null,
  resolutionTier = null,
  tokensSaved = null,
  feedbackSubmitted = null,
  onReAskAi,
  onFeedback,
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
    ? "w-full border-t-2 border-[#FACC15] bg-transparent px-4 py-2.5 text-[#F4F4F5] gl-glass-text transition-colors"
    : "w-full border-t border-white/[0.14] bg-transparent px-4 py-2.5 text-[#F4F4F5] gl-glass-text transition-colors";

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
        className={containerClass}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 text-[13px] text-[#F4F4F5] min-w-0">
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
            className="text-[11.5px] text-white/85 hover:text-white px-2 py-0.5 rounded-lg bg-black/25 hover:bg-black/40 border border-white/[0.18] shrink-0 transition-colors"
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
        className={containerClass}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13px] font-medium text-[#F4F4F5] leading-snug">
            {headline}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close error message"
            className="text-[11.5px] text-white/90 hover:text-white px-2.5 py-0.5 rounded-lg bg-black/25 hover:bg-black/40 border border-white/[0.18] shrink-0 transition-colors"
          >
            Close (Esc)
          </button>
        </div>

        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {fallbacks.map((fb) => (
            <button
              key={fb}
              type="button"
              onClick={() => onFallback(fb)}
              data-testid={`fallback-btn-${fb}`}
              className="px-3 py-1 rounded-lg text-[12px] font-medium bg-black/30 text-[#F4F4F5] border border-white/[0.20] hover:bg-black/45 transition-colors"
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

  const isTier0 = resolutionTier === "tier0_playbook";
  const isTier1 = resolutionTier === "tier1_text_graph";

  return (
    <section
      role="region"
      aria-live="polite"
      aria-label="Step guidance response"
      data-testid="response-block"
      className={containerClass}
    >
      {(resolutionTier || onFeedback) && (
        <div className="mb-1.5 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            {isTier0 && (
              <span
                data-testid="resolution-tier-badge"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-950/75 border border-emerald-400/45 text-[10.5px] font-medium text-emerald-200"
              >
                Learned · 0 tokens
              </span>
            )}
            {isTier1 && (
              <span
                data-testid="resolution-tier-badge"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-950/75 border border-sky-400/45 text-[10.5px] font-medium text-sky-200"
              >
                Graph · {formatTokensSaved(tokensSaved)}
              </span>
            )}
            {resolutionTier === "tier2_vision" && (
              <span
                data-testid="resolution-tier-badge"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-black/30 border border-white/[0.18] text-[10.5px] font-medium text-[#F4F4F5]"
              >
                Vision · AI grounded
              </span>
            )}
            {isTier0 && onReAskAi && (
              <button
                type="button"
                onClick={onReAskAi}
                data-testid="reask-ai-btn"
                className="px-2 py-0.5 rounded-md bg-black/25 hover:bg-black/40 border border-white/[0.18] text-[10.5px] font-medium text-[#F4F4F5] transition-colors"
              >
                Re-ask AI
              </button>
            )}
          </div>

          {onFeedback && (sessionId || resolutionTier) && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onFeedback(true)}
                data-testid="feedback-worked-btn"
                aria-pressed={feedbackSubmitted === "worked"}
                disabled={feedbackSubmitted !== null}
                className={`px-2 py-0.5 rounded-md border text-[10.5px] font-medium transition-colors ${
                  feedbackSubmitted === "worked"
                    ? "bg-emerald-950/80 border-emerald-400/50 text-emerald-100"
                    : "bg-black/25 hover:bg-black/40 border-white/[0.18] text-[#F4F4F5] disabled:opacity-65"
                }`}
              >
                👍 {feedbackSubmitted === "worked" ? "Saved" : "Worked"}
              </button>
              <button
                type="button"
                onClick={() => onFeedback(false)}
                data-testid="feedback-wrong-btn"
                aria-pressed={feedbackSubmitted === "wrong"}
                disabled={feedbackSubmitted !== null}
                className={`px-2 py-0.5 rounded-md border text-[10.5px] font-medium transition-colors ${
                  feedbackSubmitted === "wrong"
                    ? "bg-amber-950/80 border-amber-400/50 text-amber-100"
                    : "bg-black/25 hover:bg-black/40 border-white/[0.18] text-white/85 hover:text-white disabled:opacity-65"
                }`}
              >
                👎 {feedbackSubmitted === "wrong" ? "Flagged" : "Wrong"}
              </button>
            </div>
          )}
        </div>
      )}

      {isTerminal && step.terminal_command ? (
        <div data-testid="terminal-variant" className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 rounded-xl bg-black/45 border border-white/[0.16] px-3 py-2">
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
                  ? "bg-white text-[#0A0B0D] border-white [text-shadow:none]"
                  : "bg-black/35 text-[#F4F4F5] border-white/[0.20] hover:bg-black/50"
              }`}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p
            data-testid="terminal-explanation"
            className="text-[12.5px] text-white/90 leading-snug"
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
                  className="px-2 py-0.5 rounded-md bg-black/30 border border-white/[0.18] text-[10.5px] font-medium uppercase tracking-wide text-white/90"
                >
                  {step.action_kind}
                </span>
              )}
              {step.shortcut && (
                <kbd
                  data-testid="step-shortcut"
                  className="gl-mono shrink-0 px-2 py-0.5 rounded-md bg-black/35 border border-white/[0.20] text-[11px] text-white"
                >
                  {step.shortcut}
                </kbd>
              )}
            </div>
          </div>

          {safeSpokenWhisper && (
            <p
              data-testid="spoken-whisper"
              className="text-[11.5px] text-white/90 italic leading-snug"
            >
              “{safeSpokenWhisper}”
            </p>
          )}
        </div>
      )}

      {!isTerminal && mode === "guide" && !hasHighlightBox && (
        <div
          data-testid="low-confidence-notice"
          className="mt-1 text-[11.5px] text-white/80"
        >
          Text-only guidance (target control not visually locked)
        </div>
      )}

      <div className="mt-2 pt-2 border-t border-white/[0.12] flex items-center justify-between gap-2 text-[11.5px]">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => onToggleMagnify(!magnify)}
            aria-label="Toggle Magnifier"
            aria-pressed={magnify}
            data-testid="magnify-toggle-btn"
            className={`px-2.5 py-0.5 rounded-lg border transition-colors ${
              magnify
                ? "bg-black/45 text-white border-white/30 font-medium"
                : "bg-black/25 text-white/90 border-white/[0.18] hover:text-white hover:bg-black/40"
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
                className="flex items-center gap-1 px-2.5 py-0.5 rounded-lg border bg-black/45 text-white border-white/30 hover:bg-black/55 font-medium transition-colors"
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
                    ? "bg-black/30 text-white border-white/[0.20] hover:bg-black/45"
                    : "bg-black/25 text-white/85 border-white/[0.18] hover:text-white hover:bg-black/40"
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
            className="px-2 py-0.5 rounded-md bg-black/30 border border-white/[0.18] text-white/90 font-medium text-[11px] tabular-nums"
          >
            {liveTurnLabel ?? `Step ${displayStepNum}/${displayTotal}`}
          </span>

          {step.goal_complete && (
            <span
              data-testid="goal-complete-badge"
              className="px-2 py-0.5 rounded-md bg-black/35 border border-white/25 text-white font-medium text-[11px]"
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
              className="px-2 py-0.5 rounded-lg bg-black/25 text-white/90 border border-white/[0.18] hover:text-white hover:bg-black/40 transition-colors"
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
              className="px-2.5 py-0.5 rounded-lg bg-white text-[#0A0B0D] hover:bg-zinc-100 font-medium transition-colors [text-shadow:none]"
            >
              Next →
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close overlay (Escape)"
            data-testid="close-response-btn"
            className="px-2.5 py-0.5 rounded-lg bg-black/25 text-white/90 border border-white/[0.18] hover:text-white hover:bg-black/40 transition-colors"
          >
            {displayStepNum >= displayTotal ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </section>
  );
};
