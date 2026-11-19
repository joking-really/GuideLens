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
  onToggleMagnify,
  onNextStep,
  onClose,
  onFallback,
}) => {
  const [copied, setCopied] = useState(false);

  if (!loading && !error && !step) {
    return null;
  }

  const handleCopyCommand = async (cmd: string) => {
    await copyToClipboard(cmd);
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  const containerClass = highContrast ? "gl-glass-bar-hc" : "gl-glass-bar";

  if (loading) {
    const statusText =
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
        className={`${containerClass} mt-1.5 w-[480px] rounded-xl px-3.5 py-2.5 text-[#F4F4F5] shadow-2xl`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 text-[13px] text-[#F4F4F5]">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full bg-[#38BDF8] animate-ping"
              aria-hidden="true"
            />
            <span>{statusText}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel request"
            className="text-[12px] text-[#A1A1AA] hover:text-[#F4F4F5] px-1.5 py-0.5 rounded hover:bg-white/5"
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
        className={`${containerClass} mt-1.5 w-[480px] rounded-xl px-3.5 py-3 text-[#F4F4F5] shadow-2xl`}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13.5px] font-medium text-[#F4F4F5] leading-snug">
            {headline}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close error message"
            className="text-[12px] text-[#A1A1AA] hover:text-[#F4F4F5] px-1.5 py-0.5 rounded hover:bg-white/5 shrink-0"
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
              className="px-2.5 py-1 rounded-md text-[12px] font-medium bg-[#38BDF8]/15 text-[#38BDF8] border border-[#38BDF8]/40 hover:bg-[#38BDF8]/25 transition-colors"
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
  const hasHighlightBox = isValidHighlightTarget(step);
  const displayStepNum = stepIndex + 1;
  const displayTotal = Math.max(totalSteps, displayStepNum);

  return (
    <section
      role="region"
      aria-live="polite"
      aria-label="Step guidance response"
      data-testid="response-block"
      className={`${containerClass} mt-1.5 w-[480px] rounded-xl px-3.5 py-3 text-[#F4F4F5] shadow-2xl transition-all`}
    >
      {isTerminal && step.terminal_command ? (
        <div data-testid="terminal-variant" className="space-y-2">
          <div className="flex items-center justify-between gap-2 rounded-lg bg-[#09090B] border border-white/10 px-3 py-2">
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
              className={`shrink-0 px-2.5 py-1 rounded text-[12px] font-medium border transition-colors ${
                copied
                  ? "bg-[#22C55E]/20 text-[#22C55E] border-[#22C55E]"
                  : "bg-white/5 text-[#F4F4F5] border-white/15 hover:bg-white/10"
              }`}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p
            data-testid="terminal-explanation"
            className="text-[13px] text-[#A1A1AA] leading-snug"
          >
            {safeExplanation}
          </p>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-2">
          <p
            data-testid="instruction-line"
            className="text-[13.5px] font-semibold text-[#F4F4F5] leading-snug"
          >
            {safeInstruction}
          </p>
          {step.shortcut && (
            <kbd
              data-testid="step-shortcut"
              className="gl-mono shrink-0 px-1.5 py-0.5 rounded bg-white/10 border border-white/15 text-[11.5px] text-[#38BDF8]"
            >
              {step.shortcut}
            </kbd>
          )}
        </div>
      )}

      {!isTerminal && mode === "guide" && !hasHighlightBox && (
        <div
          data-testid="low-confidence-notice"
          className="mt-1 text-[11.5px] text-[#A1A1AA]"
        >
          Text-only guidance (target control not visually locked)
        </div>
      )}

      <div className="mt-2.5 pt-2 border-t border-white/10 flex items-center justify-between gap-2 text-[12px]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onToggleMagnify(!magnify)}
            aria-label="Toggle Magnifier"
            aria-pressed={magnify}
            data-testid="magnify-toggle-btn"
            className={`px-2 py-0.5 rounded border transition-colors ${
              magnify
                ? "bg-[#38BDF8]/20 text-[#38BDF8] border-[#38BDF8]/50 font-medium"
                : "bg-white/5 text-[#A1A1AA] border-white/10 hover:text-[#F4F4F5]"
            }`}
          >
            Magnify {magnify ? "On" : "Off"}
          </button>

          <span
            aria-label={`Step ${displayStepNum} of ${displayTotal}`}
            data-testid="step-counter"
            className="px-2 py-0.5 rounded-full bg-[#38BDF8] text-[#0F172A] font-semibold text-[11.5px]"
          >
            Step {displayStepNum}/{displayTotal}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {displayStepNum < displayTotal && (
            <button
              type="button"
              onClick={onNextStep}
              aria-label="Next step (Tab or Enter)"
              data-testid="next-step-btn"
              className="px-2.5 py-0.5 rounded bg-[#38BDF8]/15 text-[#38BDF8] border border-[#38BDF8]/40 hover:bg-[#38BDF8]/25 font-medium transition-colors"
            >
              Next →
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close overlay (Escape)"
            data-testid="close-response-btn"
            className="px-2 py-0.5 rounded bg-white/5 text-[#A1A1AA] border border-white/10 hover:text-[#F4F4F5] hover:bg-white/10 transition-colors"
          >
            {displayStepNum >= displayTotal ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </section>
  );
};
