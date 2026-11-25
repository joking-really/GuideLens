import React from "react";
import type { CompanionId } from "../types";
import "./companionAnimations.css";
import { getCompanionPersona } from "./personas";

export type CompanionEmotion =
  | "idle"
  | "peeking"
  | "walking"
  | "jumping"
  | "pointing"
  | "typing"
  | "bonk"
  | "curious"
  | "thinking"
  | "celebrate";

export interface CompanionSpriteProps {
  companionId: CompanionId;
  emotion?: CompanionEmotion;
  actionKind?: string | null;
  facing?: "left" | "right";
  size?: number;
  className?: string;
}

const VALID_EMOTIONS: ReadonlySet<CompanionEmotion> = new Set([
  "idle",
  "peeking",
  "walking",
  "jumping",
  "pointing",
  "typing",
  "bonk",
  "curious",
  "thinking",
  "celebrate",
]);

export function normalizeCompanionEmotion(
  raw: string | null | undefined,
  actionKind?: string | null,
): CompanionEmotion {
  const lower = raw?.trim().toLowerCase();
  if (lower === "happy") return "celebrate";
  if (lower && VALID_EMOTIONS.has(lower as CompanionEmotion)) {
    return lower as CompanionEmotion;
  }
  const act = actionKind?.trim().toLowerCase();
  if (act === "type") return "typing";
  if (act === "bonk") return "bonk";
  if (act === "click" || act === "shortcut") return "pointing";
  return "idle";
}

function resolveMotionClass(emotion: CompanionEmotion): string {
  switch (emotion) {
    case "walking":
      return "gl-anim-walk";
    case "celebrate":
      return "gl-anim-celebrate";
    case "bonk":
      return "gl-anim-bonk";
    case "jumping":
      return "";
    default:
      return "gl-anim-float";
  }
}

const ReactionOverlay: React.FC<{
  emotion: CompanionEmotion;
  actionKind?: string | null;
  facing: "left" | "right";
}> = ({ emotion, actionKind, facing }) => {
  const isTyping = emotion === "typing" || actionKind === "type";
  const isPointing = emotion === "pointing" || actionKind === "click";
  const dir = facing === "left" ? -1 : 1;

  return (
    <g pointerEvents="none">
      {/* Subtle monochrome bonk ripple & alert glyph */}
      {emotion === "bonk" && (
        <g data-testid="companion-fx-bonk">
          <circle
            cx="49"
            cy="12"
            r="6.5"
            fill="#111215"
            fillOpacity="0.92"
            stroke="#E4E4E7"
            strokeWidth="1.2"
          />
          <text
            x="49"
            y="15.5"
            textAnchor="middle"
            fontSize="10"
            fontWeight="700"
            fill="#F4F4F5"
          >
            !
          </text>
          <circle
            cx="32"
            cy="10"
            r="3"
            fill="none"
            stroke="#A1A1AA"
            strokeWidth="1.2"
            strokeOpacity="0.7"
          />
        </g>
      )}

      {/* Clean monochrome sparkle glyphs */}
      {emotion === "celebrate" && (
        <g data-testid="companion-fx-celebrate" className="gl-anim-sparkle">
          <path
            d="M14 13 L15.2 9.5 L16.4 13 L20 14.2 L16.4 15.4 L15.2 19 L14 15.4 L10.4 14.2 Z"
            fill="#F4F4F5"
          />
          <path
            d="M50 11 L51 8.5 L52 11 L54.5 12 L52 13 L51 15.5 L50 13 L47.5 12 Z"
            fill="#D4D4D8"
          />
          <circle cx="32" cy="7.5" r="1.4" fill="#A1A1AA" />
        </g>
      )}

      {/* Monochrome ? / ! glyph for curious / peeking */}
      {(emotion === "curious" || emotion === "peeking") && (
        <g data-testid="companion-fx-curious" transform="translate(45, 6)">
          <rect
            x="0"
            y="0"
            width="13"
            height="15"
            rx="6.5"
            fill="#111215"
            fillOpacity="0.92"
            stroke="#FFFFFF"
            strokeOpacity="0.22"
            strokeWidth="1.1"
          />
          <text
            x="6.5"
            y="11"
            textAnchor="middle"
            fontSize="10"
            fontWeight="700"
            fill="#F4F4F5"
          >
            {emotion === "peeking" ? "!" : "?"}
          </text>
        </g>
      )}

      {/* Quiet monochrome thinking dots */}
      {emotion === "thinking" && (
        <g data-testid="companion-fx-thinking">
          <rect
            x="40"
            y="5"
            width="20"
            height="11"
            rx="5.5"
            fill="#111215"
            fillOpacity="0.92"
            stroke="#FFFFFF"
            strokeOpacity="0.2"
            strokeWidth="1.1"
          />
          <circle cx="45.5" cy="10.5" r="1.3" fill="#F4F4F5" />
          <circle cx="50" cy="10.5" r="1.3" fill="#A1A1AA" />
          <circle cx="54.5" cy="10.5" r="1.3" fill="#71717A" />
        </g>
      )}

      {/* Minimal matte obsidian typing indicator */}
      {isTyping && (
        <g data-testid="companion-fx-typing" transform="translate(15, 51)">
          <rect
            x="0"
            y="0"
            width="34"
            height="10"
            rx="4"
            fill="#111215"
            fillOpacity="0.94"
            stroke="#FFFFFF"
            strokeOpacity="0.2"
            strokeWidth="1.1"
          />
          <rect x="4.5" y="3" width="4.5" height="1.6" rx="0.8" fill="#F4F4F5" />
          <rect x="11" y="3" width="4.5" height="1.6" rx="0.8" fill="#A1A1AA" />
          <rect x="17.5" y="3" width="4.5" height="1.6" rx="0.8" fill="#A1A1AA" />
          <rect x="24" y="3" width="5.5" height="1.6" rx="0.8" fill="#E4E4E7" />
          <rect x="8" y="6.3" width="18" height="1.5" rx="0.75" fill="#71717A" />
        </g>
      )}

      {/* Subtle alabaster pointer ring & dot */}
      {isPointing && (
        <g
          data-testid="companion-fx-pointing"
          transform={`translate(${dir > 0 ? 52 : 4}, 34)`}
        >
          <circle
            cx="4"
            cy="4"
            r="5"
            fill="none"
            stroke="#F4F4F5"
            strokeWidth="1.2"
            strokeOpacity="0.55"
          />
          <circle cx="4" cy="4" r="2" fill="#F4F4F5" />
        </g>
      )}
    </g>
  );
};

/** Mochi: smooth rounded minimal ivory/graphite cat with calm blinking eyes and subtle ear tilt */
const MochiCatSvg: React.FC<{
  emotion: CompanionEmotion;
  facing: "left" | "right";
}> = ({ emotion, facing }) => {
  const eyeOffset = facing === "left" ? -1.4 : 1.4;
  const peekShiftY = emotion === "peeking" ? 4 : 0;
  const earTilt = emotion === "curious" ? -4 : 0;

  return (
    <g transform={`translate(0, ${peekShiftY})`}>
      {/* Minimal curved tail */}
      <g className="gl-anim-tail">
        <path
          d="M44 47 C50 47, 52 41, 49 36"
          fill="none"
          stroke="#D4D4D8"
          strokeWidth="3.2"
          strokeLinecap="round"
        />
        <path
          d="M44 47 C50 47, 52 41, 49 36"
          fill="none"
          stroke="#27272A"
          strokeWidth="1"
          strokeLinecap="round"
          strokeOpacity="0.4"
        />
      </g>

      {/* Smooth rounded body */}
      <rect
        x="20"
        y="36"
        width="24"
        height="19"
        rx="9.5"
        fill="#F4F4F5"
        stroke="#27272A"
        strokeWidth="1.5"
      />
      {/* Subtle graphite chest shadow */}
      <ellipse cx="32" cy="46" rx="6.5" ry="5.5" fill="#E4E4E7" />

      {/* Head + gently tilted ears */}
      <g transform={`rotate(${earTilt} 32 26)`}>
        <path
          d="M19 23 L20.5 11.5 C21 10.5, 22.2 10.5, 23 11.4 L28 17.5 Z"
          fill="#F4F4F5"
          stroke="#27272A"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M45 23 L43.5 11.5 C43 10.5, 41.8 10.5, 41 11.4 L36 17.5 Z"
          fill="#E4E4E7"
          stroke="#27272A"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M21 20 L21.8 14 L25.4 18.2 Z" fill="#3F3F46" />
        <path d="M43 20 L42.2 14 L38.6 18.2 Z" fill="#3F3F46" />

        <rect
          x="16.5"
          y="16"
          width="31"
          height="22"
          rx="11"
          fill="#F4F4F5"
          stroke="#27272A"
          strokeWidth="1.5"
        />
        {/* Subtle graphite ear-crown accent */}
        <path
          d="M36 16.5 C42 16.8, 46.5 20, 47 24.5 L41 24.5 C39 21.5, 37 19, 36 16.5 Z"
          fill="#D4D4D8"
        />

        {/* Eyes */}
        {emotion === "bonk" ? (
          <g stroke="#18181B" strokeWidth="1.7" strokeLinecap="round">
            <path d="M23 25.5 L26.5 28 M26.5 25.5 L23 28" />
            <path d="M37.5 25.5 L41 28 M41 25.5 L37.5 28" />
          </g>
        ) : emotion === "celebrate" ? (
          <g fill="none" stroke="#18181B" strokeWidth="1.7" strokeLinecap="round">
            <path d="M22.5 27.5 Q25 24 27.5 27.5" />
            <path d="M36.5 27.5 Q39 24 41.5 27.5" />
          </g>
        ) : (
          <g className="gl-anim-blink">
            <circle cx={25 + eyeOffset * 0.6} cy="26.5" r="2.2" fill="#18181B" />
            <circle cx={39 + eyeOffset * 0.6} cy="26.5" r="2.2" fill="#18181B" />
            <circle cx={24.4 + eyeOffset * 0.8} cy="25.8" r="0.7" fill="#FFFFFF" />
            <circle cx={38.4 + eyeOffset * 0.8} cy="25.8" r="0.7" fill="#FFFFFF" />
          </g>
        )}

        {/* Minimal nose & mouth */}
        <circle cx="32" cy="29.5" r="0.9" fill="#52525B" />
        <path
          d="M30 31.4 Q32 32.8 34 31.4"
          fill="none"
          stroke="#27272A"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </g>

      {/* Resting / pointing paws */}
      {emotion === "pointing" ? (
        <ellipse
          cx={facing === "right" ? 48 : 16}
          cy="41"
          rx="4"
          ry="2.8"
          fill="#F4F4F5"
          stroke="#27272A"
          strokeWidth="1.4"
        />
      ) : (
        <g>
          <ellipse cx="25" cy="54.5" rx="3.4" ry="2" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.2" />
          <ellipse cx="39" cy="54.5" rx="3.4" ry="2" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.2" />
        </g>
      )}
    </g>
  );
};

/** Byte: sleek matte-obsidian rounded bot with dark glass visor and minimal alabaster dot eyes */
const ByteHackerSvg: React.FC<{
  emotion: CompanionEmotion;
  facing: "left" | "right";
}> = ({ emotion, facing }) => {
  const visorOffset = facing === "left" ? -1.4 : 1.4;
  const peekShiftY = emotion === "peeking" ? 4 : 0;

  return (
    <g transform={`translate(0, ${peekShiftY})`}>
      {/* Minimal antenna */}
      <line x1="32" y1="9" x2="32" y2="15" stroke="#71717A" strokeWidth="1.5" />
      <circle cx="32" cy="8.5" r="2" fill="#F4F4F5" stroke="#18181B" strokeWidth="1" />

      {/* Matte-obsidian rounded chassis */}
      <rect
        x="19"
        y="37"
        width="26"
        height="18"
        rx="8.5"
        fill="#18181B"
        stroke="#52525B"
        strokeWidth="1.3"
      />
      <line x1="27" y1="45" x2="37" y2="45" stroke="#3F3F46" strokeWidth="1.4" strokeLinecap="round" />

      {/* Head */}
      <rect
        x="16.5"
        y="15"
        width="31"
        height="22"
        rx="9.5"
        fill="#18181B"
        stroke="#52525B"
        strokeWidth="1.4"
      />

      {/* Dark glass visor */}
      <rect
        x={20 + visorOffset * 0.3}
        y="20.5"
        width="24"
        height="10.5"
        rx="5.2"
        fill="#09090B"
        stroke="#71717A"
        strokeOpacity="0.65"
        strokeWidth="1.1"
      />

      {/* Alabaster dot eyes */}
      {emotion === "bonk" ? (
        <g stroke="#E4E4E7" strokeWidth="1.6" strokeLinecap="round">
          <path d="M24.5 24.5 L27.5 27.5 M27.5 24.5 L24.5 27.5" />
          <path d="M36.5 24.5 L39.5 27.5 M39.5 24.5 L36.5 27.5" />
        </g>
      ) : emotion === "celebrate" ? (
        <g fill="none" stroke="#F4F4F5" strokeWidth="1.7" strokeLinecap="round">
          <path d="M23.5 26.5 Q26 23.5 28.5 26.5" />
          <path d="M35.5 26.5 Q38 23.5 40.5 26.5" />
        </g>
      ) : (
        <g className="gl-anim-blink">
          <circle cx={26 + visorOffset} cy="25.8" r="2" fill="#F4F4F5" />
          <circle cx={38 + visorOffset} cy="25.8" r="2" fill="#F4F4F5" />
        </g>
      )}

      {/* Subtle pointer indicator */}
      {emotion === "pointing" && (
        <line
          x1={facing === "right" ? 45 : 19}
          y1="44"
          x2={facing === "right" ? 52 : 12}
          y2="38"
          stroke="#E4E4E7"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
    </g>
  );
};

/** Sora: minimal serene floating sprite silhouette with delicate ring halo */
const SoraAnimeSvg: React.FC<{
  emotion: CompanionEmotion;
  facing: "left" | "right";
}> = ({ emotion, facing }) => {
  const eyeShift = facing === "left" ? -1.3 : 1.3;
  const peekShiftY = emotion === "peeking" ? 4 : 0;

  return (
    <g transform={`translate(0, ${peekShiftY})`}>
      {/* Delicate ring halo */}
      <ellipse
        cx="32"
        cy="11.5"
        rx="10.5"
        ry="2.6"
        fill="none"
        stroke="#F4F4F5"
        strokeWidth="1.3"
        strokeOpacity="0.8"
      />

      {/* Serene floating cloak silhouette */}
      <path
        d="M22 36 C19 43, 18 51, 21.5 54.5 L42.5 54.5 C46 51, 45 43, 42 36 Z"
        fill="url(#gl-sora-grad)"
        stroke="#3F3F46"
        strokeWidth="1.4"
      />

      {/* Soft alabaster head */}
      <circle
        cx="32"
        cy="26"
        r="11.5"
        fill="#F4F4F5"
        stroke="#27272A"
        strokeWidth="1.4"
      />
      {/* Minimal curved crown frame */}
      <path
        d="M20.8 24.5 C22 16, 42 16, 43.2 24.5 C39.5 20.5, 35.5 22, 32 19.5 C28.5 22, 24.5 20.5, 20.8 24.5 Z"
        fill="#27272A"
      />

      {/* Calm eyes */}
      {emotion === "bonk" ? (
        <g stroke="#18181B" strokeWidth="1.6" strokeLinecap="round" fill="none">
          <path d="M24 25.5 L27 27.5 L24 29.5" />
          <path d="M40 25.5 L37 27.5 L40 29.5" />
        </g>
      ) : emotion === "celebrate" ? (
        <g fill="none" stroke="#18181B" strokeWidth="1.7" strokeLinecap="round">
          <path d="M23.5 27.8 Q26 24.2 28.5 27.8" />
          <path d="M35.5 27.8 Q38 24.2 40.5 27.8" />
        </g>
      ) : (
        <g className="gl-anim-blink">
          <ellipse cx={26.5 + eyeShift * 0.5} cy="27.2" rx="1.7" ry="2.2" fill="#18181B" />
          <ellipse cx={37.5 + eyeShift * 0.5} cy="27.2" rx="1.7" ry="2.2" fill="#18181B" />
        </g>
      )}

      {/* Subtle pointer */}
      {emotion === "pointing" && (
        <line
          x1={facing === "right" ? 44 : 20}
          y1="43"
          x2={facing === "right" ? 52 : 12}
          y2="37"
          stroke="#E4E4E7"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
    </g>
  );
};

/** Flow: minimal frosted concentric ring & tracking dot */
const FlowOrbSvg: React.FC<{
  emotion: CompanionEmotion;
  facing: "left" | "right";
}> = ({ emotion, facing }) => {
  const shift = facing === "left" ? -2.2 : 2.2;

  return (
    <g>
      {/* Outer delicate ring */}
      <circle
        cx="32"
        cy="32"
        r="20.5"
        fill="none"
        stroke="#A1A1AA"
        strokeWidth="1.2"
        strokeOpacity="0.45"
      />
      {/* Frosted obsidian core */}
      <circle
        cx="32"
        cy="32"
        r="15"
        fill="url(#gl-flow-grad)"
        stroke="#F4F4F5"
        strokeOpacity="0.65"
        strokeWidth="1.4"
      />
      {/* Inner concentric ring */}
      <circle
        cx="32"
        cy="32"
        r="9.5"
        fill="none"
        stroke="#E4E4E7"
        strokeOpacity="0.25"
        strokeWidth="1"
      />
      {/* Tracking alabaster dot */}
      <circle
        cx={32 + shift}
        cy={emotion === "peeking" ? 30.5 : 32}
        r={emotion === "celebrate" ? 4.4 : 3.5}
        fill="#F4F4F5"
      />
      {/* Quiet orbital index dot */}
      <circle
        cx={facing === "right" ? 50.5 : 13.5}
        cy="24"
        r="2"
        fill="#E4E4E7"
        stroke="#18181B"
        strokeWidth="1"
      />
    </g>
  );
};

export const CompanionSprite: React.FC<CompanionSpriteProps> = ({
  companionId,
  emotion = "idle",
  actionKind = null,
  facing = "right",
  size = 64,
  className = "",
}) => {
  if (companionId === "none") {
    return null;
  }

  const persona = getCompanionPersona(companionId);
  const resolvedId = persona.id === "none" ? "pixel_cat" : persona.id;
  const effectiveEmotion =
    emotion === "idle" && actionKind
      ? normalizeCompanionEmotion(undefined, actionKind)
      : emotion;
  const motionClass = resolveMotionClass(effectiveEmotion);

  return (
    <div
      data-testid="companion-sprite"
      data-companion={resolvedId}
      data-emotion={effectiveEmotion}
      data-facing={facing}
      style={{ width: size, height: size }}
      className={`relative inline-flex items-center justify-center select-none pointer-events-none ${motionClass} ${className}`}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        aria-label={`${persona.name} (${effectiveEmotion})`}
        shapeRendering="geometricPrecision"
      >
        <defs>
          <radialGradient id="gl-flow-grad" cx="38%" cy="32%" r="68%">
            <stop offset="0%" stopColor="#27272A" />
            <stop offset="100%" stopColor="#09090B" />
          </radialGradient>
          <linearGradient id="gl-sora-grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#E4E4E7" />
            <stop offset="100%" stopColor="#A1A1AA" />
          </linearGradient>
        </defs>

        {/* Quiet breathing shadow */}
        <ellipse
          cx="32"
          cy="58"
          rx={effectiveEmotion === "jumping" ? 10 : 13}
          ry="2.4"
          fill="#000000"
          fillOpacity="0.28"
        />

        {resolvedId === "pixel_cat" && (
          <MochiCatSvg emotion={effectiveEmotion} facing={facing} />
        )}
        {resolvedId === "tech_nerd" && (
          <ByteHackerSvg emotion={effectiveEmotion} facing={facing} />
        )}
        {resolvedId === "anime_guide" && (
          <SoraAnimeSvg emotion={effectiveEmotion} facing={facing} />
        )}
        {resolvedId === "minimal_orb" && (
          <FlowOrbSvg emotion={effectiveEmotion} facing={facing} />
        )}

        <ReactionOverlay
          emotion={effectiveEmotion}
          actionKind={actionKind}
          facing={facing}
        />
      </svg>
    </div>
  );
};
