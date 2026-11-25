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
  | "celebrate"
  | "dance"
  | "play"
  | "sleep";

export interface CompanionSpriteProps {
  companionId: CompanionId;
  emotion?: CompanionEmotion;
  actionKind?: string | null;
  facing?: "left" | "right";
  gazeX?: number;
  gazeY?: number;
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
  "dance",
  "play",
  "sleep",
]);

function clampGaze(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(-1, Math.min(1, value));
}

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
    case "dance":
      return "gl-anim-dance";
    case "play":
      return "gl-anim-play";
    case "sleep":
      return "gl-anim-sleep";
    case "bonk":
      return "gl-anim-bonk";
    case "jumping":
      return "";
    default:
      return "gl-anim-float";
  }
}

function resolveHeadClass(emotion: CompanionEmotion): string {
  switch (emotion) {
    case "bonk":
      return "gl-head-bonk";
    case "curious":
    case "peeking":
      return "gl-head-curious";
    case "dance":
    case "celebrate":
      return "gl-head-dance";
    case "play":
      return "gl-head-play";
    default:
      return "";
  }
}

interface PersonaSvgProps {
  emotion: CompanionEmotion;
  facing: "left" | "right";
  gazeX: number;
  gazeY: number;
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
      {/* Subtle monochrome bonk impact arc & alert glyph */}
      {emotion === "bonk" && (
        <g data-testid="companion-fx-bonk">
          <g className="gl-anim-bonk-arc">
            <path
              d="M23 11 Q32 5 41 11"
              fill="none"
              stroke="#E4E4E7"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeOpacity="0.85"
            />
            <path
              d="M26 8 L24 5 M32 7 L32 3.5 M38 8 L40 5"
              stroke="#A1A1AA"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </g>
          <circle
            cx="50"
            cy="12"
            r="6"
            fill="#111215"
            fillOpacity="0.9"
            stroke="#E4E4E7"
            strokeWidth="1.1"
          />
          <text
            x="50"
            y="15.5"
            textAnchor="middle"
            fontSize="9.5"
            fontWeight="700"
            fill="#F4F4F5"
          >
            !
          </text>
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

      {/* Rhythm / motion arcs for dance */}
      {emotion === "dance" && (
        <g data-testid="companion-fx-dance" className="gl-anim-sparkle">
          <path
            d="M12 18 Q10 13 14 10"
            fill="none"
            stroke="#E4E4E7"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <path
            d="M52 18 Q54 13 50 10"
            fill="none"
            stroke="#E4E4E7"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <circle cx="49" cy="9" r="1.5" fill="#F4F4F5" />
          <line x1="50.5" y1="9" x2="50.5" y2="4.5" stroke="#F4F4F5" strokeWidth="1.2" strokeLinecap="round" />
          <line x1="50.5" y1="4.5" x2="53.5" y2="5.5" stroke="#F4F4F5" strokeWidth="1.2" strokeLinecap="round" />
        </g>
      )}

      {/* Playful pounce motion lines */}
      {emotion === "play" && (
        <g data-testid="companion-fx-play" className="gl-anim-sparkle">
          <path
            d="M11 24 Q14 20 17 22"
            fill="none"
            stroke="#D4D4D8"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <circle cx="51" cy="21" r="1.4" fill="#F4F4F5" />
          <circle cx="48" cy="16" r="1" fill="#A1A1AA" />
        </g>
      )}

      {/* Quiet floating Zs for sleep */}
      {emotion === "sleep" && (
        <g data-testid="companion-fx-sleep" className="gl-anim-sleep-z">
          <text x="44" y="16" fontSize="8" fontWeight="600" fill="#D4D4D8">
            z
          </text>
          <text x="50" y="10" fontSize="6.5" fontWeight="600" fill="#A1A1AA">
            z
          </text>
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

/** Mochi: articulated minimal ivory/graphite cat with independent ears, tail, head, paws, and cursor-tracking pupils */
const MochiCatSvg: React.FC<PersonaSvgProps> = ({
  emotion,
  facing,
  gazeX,
  gazeY,
}) => {
  const pupilDx = gazeX * 1.8;
  const pupilDy = gazeY * 1.3;
  const peekShiftY = emotion === "peeking" ? 5 : 0;
  const headClass = resolveHeadClass(emotion);
  const isFastTail =
    emotion === "dance" || emotion === "play" || emotion === "celebrate";
  const isStepping = emotion === "walking" || emotion === "play";
  const isWaving = emotion === "dance" || emotion === "celebrate";
  const isBonk = emotion === "bonk";
  const isPeeking = emotion === "peeking";

  return (
    <g transform={`translate(0, ${peekShiftY})`}>
      {/* Articulated curved tail */}
      <g
        data-part="tail"
        className={isFastTail ? "gl-anim-tail-fast" : "gl-anim-tail"}
      >
        <path
          d="M44 47 C51 47, 53 40, 49 35"
          fill="none"
          stroke="#D4D4D8"
          strokeWidth="3.2"
          strokeLinecap="round"
        />
        <path
          d="M44 47 C51 47, 53 40, 49 35"
          fill="none"
          stroke="#27272A"
          strokeWidth="1"
          strokeLinecap="round"
          strokeOpacity="0.4"
        />
      </g>

      {/* Rounded torso */}
      <g data-part="body">
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
        <ellipse cx="32" cy="46" rx="6.5" ry="5.5" fill="#E4E4E7" />
      </g>

      {/* Articulated Head + Asymmetric Twitching / Flattening Ears */}
      <g data-part="head" className={headClass}>
        <g data-part="ears">
          <g
            className={isBonk ? "" : "gl-anim-ear-left"}
            transform={isBonk ? "rotate(-22 21 21)" : undefined}
          >
            <path
              d="M19 23 L20.5 11.5 C21 10.5, 22.2 10.5, 23 11.4 L28 17.5 Z"
              fill="#F4F4F5"
              stroke="#27272A"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path d="M21 20 L21.8 14 L25.4 18.2 Z" fill="#3F3F46" />
          </g>
          <g
            className={isBonk ? "" : "gl-anim-ear-right"}
            transform={isBonk ? "rotate(22 43 21)" : undefined}
          >
            <path
              d="M45 23 L43.5 11.5 C43 10.5, 41.8 10.5, 41 11.4 L36 17.5 Z"
              fill="#E4E4E7"
              stroke="#27272A"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path d="M43 20 L42.2 14 L38.6 18.2 Z" fill="#3F3F46" />
          </g>
        </g>

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
        <path
          d="M36 16.5 C42 16.8, 46.5 20, 47 24.5 L41 24.5 C39 21.5, 37 19, 36 16.5 Z"
          fill="#D4D4D8"
        />

        {/* Eyes & Live Cursor-Tracking Pupils */}
        {emotion === "bonk" ? (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            stroke="#18181B"
            strokeWidth="1.7"
            strokeLinecap="round"
          >
            <path d="M23 25.5 L26.5 28 M26.5 25.5 L23 28" />
            <path d="M37.5 25.5 L41 28 M41 25.5 L37.5 28" />
          </g>
        ) : emotion === "celebrate" || emotion === "dance" ? (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            fill="none"
            stroke="#18181B"
            strokeWidth="1.7"
            strokeLinecap="round"
          >
            <path d="M22.5 27.5 Q25 24 27.5 27.5" />
            <path d="M36.5 27.5 Q39 24 41.5 27.5" />
          </g>
        ) : emotion === "sleep" ? (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            fill="none"
            stroke="#18181B"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M22.5 27 Q25 29 27.5 27" />
            <path d="M36.5 27 Q39 29 41.5 27" />
          </g>
        ) : (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            className="gl-anim-blink"
          >
            <circle cx="25" cy="26.5" r="2.7" fill="#FFFFFF" stroke="#27272A" strokeWidth="0.9" />
            <circle cx="39" cy="26.5" r="2.7" fill="#FFFFFF" stroke="#27272A" strokeWidth="0.9" />
            <circle cx={25 + pupilDx * 0.7} cy={26.5 + pupilDy * 0.7} r="1.65" fill="#18181B" />
            <circle cx={39 + pupilDx * 0.7} cy={26.5 + pupilDy * 0.7} r="1.65" fill="#18181B" />
            <circle cx={24.5 + pupilDx * 0.8} cy={25.9 + pupilDy * 0.8} r="0.55" fill="#FFFFFF" />
            <circle cx={38.5 + pupilDx * 0.8} cy={25.9 + pupilDy * 0.8} r="0.55" fill="#FFFFFF" />
          </g>
        )}

        <circle cx="32" cy="29.8" r="0.9" fill="#52525B" />
        <path
          d="M30 31.6 Q32 33 34 31.6"
          fill="none"
          stroke="#27272A"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </g>

      {/* Articulated Paws & Legs */}
      {isPeeking ? (
        <g data-testid="companion-peeking-paws" className="gl-anim-paw-peek">
          <line x1="12" y1="53" x2="52" y2="53" stroke="#A1A1AA" strokeOpacity="0.45" strokeWidth="1.2" strokeLinecap="round" />
          <ellipse data-part="paws-left" cx="23.5" cy="52" rx="3.8" ry="2.4" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.3" />
          <ellipse data-part="paws-right" cx="40.5" cy="52" rx="3.8" ry="2.4" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.3" />
        </g>
      ) : isBonk ? (
        <g>
          {/* Paws clutch temples while head bangs */}
          <ellipse data-part="paws-left" cx="17" cy="27" rx="3.1" ry="2.4" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.3" />
          <ellipse data-part="paws-right" cx="47" cy="27" rx="3.1" ry="2.4" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.3" />
          <ellipse cx="25" cy="54.5" rx="3.3" ry="2" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.2" />
          <ellipse cx="39" cy="54.5" rx="3.3" ry="2" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.2" />
        </g>
      ) : emotion === "pointing" ? (
        <g>
          <ellipse
            data-part="paws-right"
            cx={facing === "right" ? 49 : 15}
            cy="40"
            rx="4.1"
            ry="2.6"
            fill="#F4F4F5"
            stroke="#27272A"
            strokeWidth="1.4"
          />
          <ellipse data-part="paws-left" cx="25" cy="54.5" rx="3.4" ry="2" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.2" />
          <ellipse cx="39" cy="54.5" rx="3.4" ry="2" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.2" />
        </g>
      ) : (
        <g>
          <ellipse
            data-part="paws-left"
            cx="24.5"
            cy={isWaving ? "48" : "54.5"}
            rx="3.4"
            ry="2.1"
            fill="#F4F4F5"
            stroke="#27272A"
            strokeWidth="1.2"
            className={
              isWaving
                ? "gl-anim-paw-wave-left"
                : isStepping
                  ? "gl-anim-paw-step-left"
                  : undefined
            }
          />
          <ellipse
            data-part="paws-right"
            cx="39.5"
            cy={isWaving ? "48" : "54.5"}
            rx="3.4"
            ry="2.1"
            fill="#F4F4F5"
            stroke="#27272A"
            strokeWidth="1.2"
            className={
              isWaving
                ? "gl-anim-paw-wave-right"
                : isStepping
                  ? "gl-anim-paw-step-right"
                  : undefined
            }
          />
        </g>
      )}
    </g>
  );
};

/** Byte: articulated matte-obsidian bot with swaying antenna, dark glass visor, tracking eye dots, and articulated arms/feet */
const ByteHackerSvg: React.FC<PersonaSvgProps> = ({
  emotion,
  facing,
  gazeX,
  gazeY,
}) => {
  const pupilDx = gazeX * 2.2;
  const pupilDy = gazeY * 1.3;
  const peekShiftY = emotion === "peeking" ? 5 : 0;
  const headClass = resolveHeadClass(emotion);
  const isStepping = emotion === "walking" || emotion === "play";
  const isWaving = emotion === "dance" || emotion === "celebrate";
  const isBonk = emotion === "bonk";
  const isPeeking = emotion === "peeking";

  return (
    <g transform={`translate(0, ${peekShiftY})`}>
      {/* Chassis body */}
      <g data-part="body">
        <rect
          x="19"
          y="37"
          width="26"
          height="17"
          rx="8"
          fill="#18181B"
          stroke="#52525B"
          strokeWidth="1.3"
        />
        <line x1="27" y1="45" x2="37" y2="45" stroke="#52525B" strokeWidth="1.4" strokeLinecap="round" />
      </g>

      {/* Articulated Head + Antenna + Visor */}
      <g data-part="head" className={headClass}>
        <g data-part="antenna" className="gl-anim-antenna">
          <line x1="32" y1="9" x2="32" y2="15" stroke="#71717A" strokeWidth="1.5" />
          <circle cx="32" cy="8" r="2.1" fill="#F4F4F5" stroke="#18181B" strokeWidth="1" />
        </g>

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

        <rect
          x={20 + gazeX * 0.5}
          y={20.5 + gazeY * 0.3}
          width="24"
          height="10.5"
          rx="5.2"
          fill="#09090B"
          stroke="#71717A"
          strokeOpacity="0.7"
          strokeWidth="1.1"
        />

        {emotion === "bonk" ? (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            stroke="#E4E4E7"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <path d="M24.5 24.5 L27.5 27.5 M27.5 24.5 L24.5 27.5" />
            <path d="M36.5 24.5 L39.5 27.5 M39.5 24.5 L36.5 27.5" />
          </g>
        ) : emotion === "celebrate" || emotion === "dance" ? (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            fill="none"
            stroke="#F4F4F5"
            strokeWidth="1.7"
            strokeLinecap="round"
          >
            <path d="M23.5 26.5 Q26 23.5 28.5 26.5" />
            <path d="M35.5 26.5 Q38 23.5 40.5 26.5" />
          </g>
        ) : emotion === "sleep" ? (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            stroke="#A1A1AA"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <line x1="23.5" y1="26" x2="28" y2="26" />
            <line x1="36" y1="26" x2="40.5" y2="26" />
          </g>
        ) : (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            className="gl-anim-blink"
          >
            <circle cx={26 + pupilDx} cy={25.8 + pupilDy} r="2" fill="#F4F4F5" />
            <circle cx={38 + pupilDx} cy={25.8 + pupilDy} r="2" fill="#F4F4F5" />
          </g>
        )}
      </g>

      {/* Articulated Arms / Feet */}
      {isPeeking ? (
        <g data-testid="companion-peeking-paws" className="gl-anim-paw-peek">
          <line x1="12" y1="53" x2="52" y2="53" stroke="#A1A1AA" strokeOpacity="0.45" strokeWidth="1.2" strokeLinecap="round" />
          <rect data-part="paws-left" x="20" y="50" width="7" height="4" rx="2" fill="#27272A" stroke="#71717A" strokeWidth="1.1" />
          <rect data-part="paws-right" x="37" y="50" width="7" height="4" rx="2" fill="#27272A" stroke="#71717A" strokeWidth="1.1" />
        </g>
      ) : isBonk ? (
        <g>
          <rect data-part="paws-left" x="13" y="24" width="5" height="5" rx="2" fill="#27272A" stroke="#71717A" strokeWidth="1.1" />
          <rect data-part="paws-right" x="46" y="24" width="5" height="5" rx="2" fill="#27272A" stroke="#71717A" strokeWidth="1.1" />
          <rect x="22" y="53" width="6" height="3.2" rx="1.6" fill="#27272A" stroke="#52525B" strokeWidth="1.1" />
          <rect x="36" y="53" width="6" height="3.2" rx="1.6" fill="#27272A" stroke="#52525B" strokeWidth="1.1" />
        </g>
      ) : (
        <g>
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
          <rect
            data-part="paws-left"
            x="21.5"
            y={isWaving ? "45" : "53"}
            width="6.5"
            height="3.4"
            rx="1.7"
            fill="#27272A"
            stroke="#71717A"
            strokeWidth="1.1"
            className={
              isWaving
                ? "gl-anim-paw-wave-left"
                : isStepping
                  ? "gl-anim-paw-step-left"
                  : undefined
            }
          />
          <rect
            data-part="paws-right"
            x="36"
            y={isWaving ? "45" : "53"}
            width="6.5"
            height="3.4"
            rx="1.7"
            fill="#27272A"
            stroke="#71717A"
            strokeWidth="1.1"
            className={
              isWaving
                ? "gl-anim-paw-wave-right"
                : isStepping
                  ? "gl-anim-paw-step-right"
                  : undefined
            }
          />
        </g>
      )}
    </g>
  );
};

/** Sora: articulated floating sprite with independent halo, cloak, head, hands, and tracking eyes */
const SoraAnimeSvg: React.FC<PersonaSvgProps> = ({
  emotion,
  facing,
  gazeX,
  gazeY,
}) => {
  const pupilDx = gazeX * 1.5;
  const pupilDy = gazeY * 1.1;
  const peekShiftY = emotion === "peeking" ? 5 : 0;
  const headClass = resolveHeadClass(emotion);
  const isStepping = emotion === "walking" || emotion === "play";
  const isWaving = emotion === "dance" || emotion === "celebrate";
  const isBonk = emotion === "bonk";
  const isPeeking = emotion === "peeking";

  return (
    <g transform={`translate(0, ${peekShiftY})`}>
      {/* Floating cloak silhouette */}
      <g data-part="body">
        <path
          d="M22 36 C19 43, 18 51, 21.5 54.5 L42.5 54.5 C46 51, 45 43, 42 36 Z"
          fill="url(#gl-sora-grad)"
          stroke="#3F3F46"
          strokeWidth="1.4"
        />
      </g>

      {/* Articulated Head + Independent Halo */}
      <g data-part="head" className={headClass}>
        <g data-part="halo" className="gl-anim-halo">
          <ellipse
            cx="32"
            cy="11.5"
            rx="10.5"
            ry="2.6"
            fill="none"
            stroke="#F4F4F5"
            strokeWidth="1.35"
            strokeOpacity="0.85"
          />
        </g>

        <circle
          cx="32"
          cy="26"
          r="11.5"
          fill="#F4F4F5"
          stroke="#27272A"
          strokeWidth="1.4"
        />
        <path
          d="M20.8 24.5 C22 16, 42 16, 43.2 24.5 C39.5 20.5, 35.5 22, 32 19.5 C28.5 22, 24.5 20.5, 20.8 24.5 Z"
          fill="#27272A"
        />

        {emotion === "bonk" ? (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            stroke="#18181B"
            strokeWidth="1.6"
            strokeLinecap="round"
            fill="none"
          >
            <path d="M24 25.5 L27 27.5 L24 29.5" />
            <path d="M40 25.5 L37 27.5 L40 29.5" />
          </g>
        ) : emotion === "celebrate" || emotion === "dance" ? (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            fill="none"
            stroke="#18181B"
            strokeWidth="1.7"
            strokeLinecap="round"
          >
            <path d="M23.5 27.8 Q26 24.2 28.5 27.8" />
            <path d="M35.5 27.8 Q38 24.2 40.5 27.8" />
          </g>
        ) : emotion === "sleep" ? (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            fill="none"
            stroke="#18181B"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M24 27.8 Q26.5 29.5 29 27.8" />
            <path d="M35 27.8 Q37.5 29.5 40 27.8" />
          </g>
        ) : (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            className="gl-anim-blink"
          >
            <ellipse cx="26.5" cy="27.2" rx="2.1" ry="2.6" fill="#FFFFFF" stroke="#27272A" strokeWidth="0.8" />
            <ellipse cx="37.5" cy="27.2" rx="2.1" ry="2.6" fill="#FFFFFF" stroke="#27272A" strokeWidth="0.8" />
            <circle cx={26.5 + pupilDx * 0.7} cy={27.2 + pupilDy * 0.7} r="1.4" fill="#18181B" />
            <circle cx={37.5 + pupilDx * 0.7} cy={27.2 + pupilDy * 0.7} r="1.4" fill="#18181B" />
          </g>
        )}
      </g>

      {/* Articulated Sprite Sleeves / Hands */}
      {isPeeking ? (
        <g data-testid="companion-peeking-paws" className="gl-anim-paw-peek">
          <line x1="12" y1="53" x2="52" y2="53" stroke="#A1A1AA" strokeOpacity="0.45" strokeWidth="1.2" strokeLinecap="round" />
          <circle data-part="paws-left" cx="23.5" cy="52" r="2.6" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.2" />
          <circle data-part="paws-right" cx="40.5" cy="52" r="2.6" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.2" />
        </g>
      ) : isBonk ? (
        <g>
          <circle data-part="paws-left" cx="19" cy="26" r="2.6" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.2" />
          <circle data-part="paws-right" cx="45" cy="26" r="2.6" fill="#F4F4F5" stroke="#27272A" strokeWidth="1.2" />
        </g>
      ) : (
        <g>
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
          <circle
            data-part="paws-left"
            cx="19"
            cy={isWaving ? "43" : "46"}
            r="2.4"
            fill="#F4F4F5"
            stroke="#27272A"
            strokeWidth="1.2"
            className={
              isWaving
                ? "gl-anim-paw-wave-left"
                : isStepping
                  ? "gl-anim-paw-step-left"
                  : undefined
            }
          />
          <circle
            data-part="paws-right"
            cx="45"
            cy={isWaving ? "43" : "46"}
            r="2.4"
            fill="#F4F4F5"
            stroke="#27272A"
            strokeWidth="1.2"
            className={
              isWaving
                ? "gl-anim-paw-wave-right"
                : isStepping
                  ? "gl-anim-paw-step-right"
                  : undefined
            }
          />
        </g>
      )}
    </g>
  );
};

/** Flow: articulated concentric orb with rotating orbital ring, stabilizer nodes, and live tracking iris */
const FlowOrbSvg: React.FC<PersonaSvgProps> = ({
  emotion,
  gazeX,
  gazeY,
}) => {
  const pupilDx = gazeX * 3.2;
  const pupilDy = gazeY * 2.4;
  const headClass = resolveHeadClass(emotion);
  const isFastOrbit =
    emotion === "dance" || emotion === "play" || emotion === "celebrate";
  const isStepping = emotion === "walking" || emotion === "play";
  const isWaving = emotion === "dance" || emotion === "celebrate";
  const isPeeking = emotion === "peeking";

  return (
    <g transform={isPeeking ? "translate(0, 5)" : undefined}>
      {/* Rotating outer orbital ring & satellite */}
      <g
        data-part="orbit"
        className={isFastOrbit ? "gl-anim-orbit-fast" : "gl-anim-orbit"}
      >
        <circle
          cx="32"
          cy="32"
          r="20.5"
          fill="none"
          stroke="#A1A1AA"
          strokeWidth="1.2"
          strokeOpacity="0.45"
          strokeDasharray="18 6"
        />
        <circle
          cx="50.5"
          cy="24"
          r="2.2"
          fill="#E4E4E7"
          stroke="#18181B"
          strokeWidth="1"
        />
      </g>

      {/* Core shell */}
      <g data-part="body">
        <circle
          cx="32"
          cy="32"
          r="15"
          fill="url(#gl-flow-grad)"
          stroke="#F4F4F5"
          strokeOpacity="0.7"
          strokeWidth="1.4"
        />
        <circle
          cx="32"
          cy="32"
          r="9.5"
          fill="none"
          stroke="#E4E4E7"
          strokeOpacity="0.25"
          strokeWidth="1"
        />
      </g>

      {/* Articulated Tracking Iris */}
      <g data-part="head" className={headClass}>
        {emotion === "bonk" ? (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            stroke="#F4F4F5"
            strokeWidth="1.7"
            strokeLinecap="round"
          >
            <path d="M27.5 28.5 L36.5 35.5 M36.5 28.5 L27.5 35.5" />
          </g>
        ) : emotion === "sleep" ? (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            stroke="#A1A1AA"
            strokeWidth="1.6"
            strokeLinecap="round"
            fill="none"
          >
            <path d="M27 32.5 Q32 35.5 37 32.5" />
          </g>
        ) : (
          <g
            data-part="pupils"
            data-gaze-x={gazeX.toFixed(2)}
            data-gaze-y={gazeY.toFixed(2)}
            className="gl-anim-blink"
          >
            <circle
              cx={32 + pupilDx}
              cy={32 + pupilDy}
              r={emotion === "celebrate" || emotion === "dance" ? 4.4 : 3.6}
              fill="#F4F4F5"
            />
            <circle
              cx={32 + pupilDx * 1.1}
              cy={32 + pupilDy * 1.1}
              r="1.1"
              fill="#18181B"
            />
          </g>
        )}
      </g>

      {/* Stabilizer nodes (act as peeking/waving/stepping paws) */}
      {isPeeking ? (
        <g data-testid="companion-peeking-paws" className="gl-anim-paw-peek">
          <line x1="12" y1="53" x2="52" y2="53" stroke="#A1A1AA" strokeOpacity="0.45" strokeWidth="1.2" strokeLinecap="round" />
          <circle data-part="paws-left" cx="23" cy="52" r="2.5" fill="#E4E4E7" stroke="#18181B" strokeWidth="1.1" />
          <circle data-part="paws-right" cx="41" cy="52" r="2.5" fill="#E4E4E7" stroke="#18181B" strokeWidth="1.1" />
        </g>
      ) : (
        <g>
          <circle
            data-part="paws-left"
            cx="15"
            cy={isWaving ? "36" : "45"}
            r="2.2"
            fill="#E4E4E7"
            stroke="#18181B"
            strokeWidth="1"
            className={
              isWaving
                ? "gl-anim-paw-wave-left"
                : isStepping
                  ? "gl-anim-paw-step-left"
                  : undefined
            }
          />
          <circle
            data-part="paws-right"
            cx="49"
            cy={isWaving ? "36" : "45"}
            r="2.2"
            fill="#E4E4E7"
            stroke="#18181B"
            strokeWidth="1"
            className={
              isWaving
                ? "gl-anim-paw-wave-right"
                : isStepping
                  ? "gl-anim-paw-step-right"
                  : undefined
            }
          />
        </g>
      )}
    </g>
  );
};

export const CompanionSprite: React.FC<CompanionSpriteProps> = ({
  companionId,
  emotion = "idle",
  actionKind = null,
  facing = "right",
  gazeX,
  gazeY,
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
  const resolvedGazeX = clampGaze(gazeX, facing === "left" ? -0.55 : 0.55);
  const resolvedGazeY = clampGaze(gazeY, 0);

  return (
    <div
      data-testid="companion-sprite"
      data-companion={resolvedId}
      data-emotion={effectiveEmotion}
      data-facing={facing}
      data-gaze-x={resolvedGazeX.toFixed(2)}
      data-gaze-y={resolvedGazeY.toFixed(2)}
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
          rx={
            effectiveEmotion === "jumping" || effectiveEmotion === "play"
              ? 10
              : 13
          }
          ry="2.4"
          fill="#000000"
          fillOpacity="0.28"
        />

        {resolvedId === "pixel_cat" && (
          <MochiCatSvg
            emotion={effectiveEmotion}
            facing={facing}
            gazeX={resolvedGazeX}
            gazeY={resolvedGazeY}
          />
        )}
        {resolvedId === "tech_nerd" && (
          <ByteHackerSvg
            emotion={effectiveEmotion}
            facing={facing}
            gazeX={resolvedGazeX}
            gazeY={resolvedGazeY}
          />
        )}
        {resolvedId === "anime_guide" && (
          <SoraAnimeSvg
            emotion={effectiveEmotion}
            facing={facing}
            gazeX={resolvedGazeX}
            gazeY={resolvedGazeY}
          />
        )}
        {resolvedId === "minimal_orb" && (
          <FlowOrbSvg
            emotion={effectiveEmotion}
            facing={facing}
            gazeX={resolvedGazeX}
            gazeY={resolvedGazeY}
          />
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
