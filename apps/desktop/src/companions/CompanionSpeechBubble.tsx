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
  placement?: "left" | "right" | "above";
  className?: string;
}

function formatActionBadge(actionKind: string | null | undefined): {
  label: string;
  toneClass: string;
} | null {
  const kind = actionKind?.trim().toLowerCase();
  if (!kind) return null;
  switch (kind) {
    case "click":
      return {
        label: "Click",
        toneClass: "bg-[#38BDF8]/18 text-[#38BDF8] border-[#38BDF8]/40",
      };
    case "type":
      return {
        label: "Type",
        toneClass: "bg-[#A78BFA]/18 text-[#C4B5FD] border-[#A78BFA]/40",
      };
    case "shortcut":
      return {
        label: "Shortcut",
        toneClass: "bg-amber-400/18 text-amber-300 border-amber-400/40",
      };
    case "scroll":
      return {
        label: "Scroll",
        toneClass: "bg-teal-400/18 text-teal-300 border-teal-400/40",
      };
    case "bonk":
      return {
        label: "App Check",
        toneClass: "bg-rose-500/20 text-rose-300 border-rose-500/45",
      };
    default:
      return {
        label: kind,
        toneClass: "bg-white/10 text-[#E4E4E7] border-white/20",
      };
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
  const actionBadge = formatActionBadge(actionKind);

  return (
    <div
      data-testid="companion-speech-bubble"
      data-placement={placement}
      style={{
        borderColor: highContrast ? "#FACC15" : `${persona.accentColor}55`,
      }}
      className={`pointer-events-none select-none max-w-[264px] rounded-2xl border px-3 py-2 shadow-[0_14px_36px_rgba(0,0,0,0.6)] backdrop-blur-2xl ${
        highContrast ? "bg-[#09090D]/95" : "bg-[#0B0E16]/90"
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: persona.accentColor }}
          />
          <span
            className="text-[11px] font-bold tracking-wide uppercase truncate"
            style={{ color: highContrast ? "#FACC15" : persona.accentColor }}
          >
            {persona.name}
          </span>
          {stepLabel && (
            <span className="text-[10.5px] font-semibold text-[#A1A1AA]">
              · {stepLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {screendayRecording && (
            <span
              data-testid="companion-screenday-badge"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-rose-500/15 border border-rose-500/35 text-[9.5px] font-semibold text-rose-300"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
              Diary
            </span>
          )}
          {actionBadge && (
            <span
              data-testid="companion-action-badge"
              className={`px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${actionBadge.toneClass}`}
            >
              {actionBadge.label}
            </span>
          )}
          {shortcut && (
            <kbd
              data-testid="companion-shortcut-badge"
              className="gl-mono px-1.5 py-0.5 rounded bg-white/10 border border-white/20 text-[10px] font-semibold text-[#38BDF8]"
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
