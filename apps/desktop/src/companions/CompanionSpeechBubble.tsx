import React from "react";
import { clampInstruction, type CompanionId } from "../types";
import { getCompanionPersona } from "./personas";

export interface CompanionSpeechBubbleProps {
  text: string | null | undefined;
  companionId?: CompanionId;
  shortcut?: string | null;
  actionKind?: string | null;
  stepLabel?: string | null;
  highContrast?: boolean;
  screendayRecording?: boolean;
  placement?: "left" | "right" | "above" | "below";
  className?: string;
}

function formatActionLabel(actionKind: string | null | undefined): string | null {
  const kind = actionKind?.trim().toLowerCase();
  if (!kind) return null;
  switch (kind) {
    case "click":
      return "Click";
    case "type":
      return "Type";
    case "shortcut":
      return "Shortcut";
    case "scroll":
      return "Scroll";
    case "bonk":
      return "App Check";
    default:
      return kind;
  }
}

export const CompanionSpeechBubble: React.FC<CompanionSpeechBubbleProps> = ({
  text,
  companionId = "pixel_cat",
  shortcut = null,
  actionKind = null,
  stepLabel = null,
  highContrast = false,
  screendayRecording = false,
  placement = "right",
  className = "",
}) => {
  const safeText = clampInstruction(text);
  if (!safeText && !shortcut && !screendayRecording) {
    return null;
  }

  const persona = getCompanionPersona(companionId);
  const actionLabel = formatActionLabel(actionKind);

  return (
    <div
      data-testid="companion-speech-bubble"
      data-placement={placement}
      style={{
        borderColor: highContrast ? "#FACC15" : "rgba(255, 255, 255, 0.10)",
      }}
      className={`pointer-events-none select-none max-w-[264px] rounded-2xl border px-3 py-2 shadow-[0_14px_36px_rgba(0,0,0,0.6)] backdrop-blur-2xl ${
        highContrast ? "bg-[#09090B]/95" : "bg-[#111215]/92"
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="text-[11px] font-semibold tracking-wide uppercase truncate"
            style={{ color: highContrast ? "#FACC15" : "#A1A1AA" }}
          >
            {persona.name}
          </span>
          {stepLabel && (
            <span className="text-[10.5px] font-medium text-[#71717A] tabular-nums">
              {stepLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {screendayRecording && (
            <span
              data-testid="companion-screenday-badge"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white/[0.06] border border-white/10 text-[9.5px] font-medium text-[#A1A1AA]"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#E4E4E7]" />
              Diary
            </span>
          )}
          {actionLabel && (
            <span
              data-testid="companion-action-badge"
              className="px-1.5 py-0.5 rounded-md bg-white/[0.06] border border-white/10 text-[10px] font-medium text-[#A1A1AA]"
            >
              {actionLabel}
            </span>
          )}
          {shortcut && (
            <kbd
              data-testid="companion-shortcut-badge"
              className="gl-mono px-1.5 py-0.5 rounded-md bg-white/[0.07] border border-white/12 text-[10px] font-medium text-[#E4E4E7]"
            >
              {shortcut}
            </kbd>
          )}
        </div>
      </div>

      {safeText && (
        <p className="text-[12px] font-medium leading-snug text-[#F4F4F5] break-words">
          {safeText}
        </p>
      )}
    </div>
  );
};
