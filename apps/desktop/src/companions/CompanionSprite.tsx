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
  accentColor: string;
}> = ({ emotion, actionKind, facing, accentColor }) => {
  const isTyping = emotion === "typing" || actionKind === "type";
  const isPointing = emotion === "pointing" || actionKind === "click";
  const dir = facing === "left" ? -1 : 1;

  return (
    <g pointerEvents="none">
      {/* Bonk bump, orbiting stars, and anime sweat drop */}
      {emotion === "bonk" && (
        <g data-testid="companion-fx-bonk">
          <ellipse cx="32" cy="13" rx="5" ry="3.5" fill="#FB7185" stroke="#0F172A" strokeWidth="1.5" />
          <g className="gl-anim-orbit">
            <polygon points="18,12 19.5,15 22.5,15.5 20,17.5 20.8,20.5 18,19 15.2,20.5 16,17.5 13.5,15.5 16.5,15" fill="#FDE047" />
            <polygon points="46,10 47,12.5 49.5,13 47.5,14.5 48,17 46,15.8 44,17 44.5,14.5 42.5,13 45,12.5" fill="#FACC15" />
            <circle cx="32" cy="6" r="2.2" fill="#FDE047" />
          </g>
          {/* Anime sweat drop */}
          <path
            d="M49 23 C51 26, 52 29, 49 30.5 C46 29, 47 26, 49 23 Z"
            fill="#38BDF8"
            stroke="#0F172A"
            strokeWidth="1"
          />
        </g>
      )}

      {/* Celebratory sparkles & confetti */}
      {emotion === "celebrate" && (
        <g data-testid="companion-fx-celebrate" className="gl-anim-sparkle">
          <path d="M12 12 L14 7 L16 12 L21 14 L16 16 L14 21 L12 16 L7 14 Z" fill="#FDE047" />
          <path d="M51 9 L52.5 5.5 L54 9 L57.5 10.5 L54 12 L52.5 15.5 L51 12 L47.5 10.5 Z" fill="#38BDF8" />
          <rect x="8" y="28" width="4" height="4" rx="1" fill="#F472B6" transform="rotate(20 10 30)" />
          <rect x="52" y="26" width="4" height="4" rx="1" fill="#34D399" transform="rotate(-18 54 28)" />
          <circle cx="32" cy="6" r="2.2" fill="#FDE047" />
        </g>
      )}

      {/* Anime ? mark for curious / peeking */}
      {(emotion === "curious" || emotion === "peeking") && (
        <g data-testid="companion-fx-curious" transform="translate(46, 5)">
          <rect x="0" y="0" width="13" height="16" rx="6.5" fill="#0F172A" fillOpacity="0.88" stroke={accentColor} strokeWidth="1.4" />
          <text x="6.5" y="12" textAnchor="middle" fontSize="11" fontWeight="800" fill="#FDE047">
            {emotion === "peeking" ? "!" : "?"}
          </text>
        </g>
      )}

      {/* Thinking dots */}
      {emotion === "thinking" && (
        <g data-testid="companion-fx-thinking">
          <circle cx="48" cy="17" r="2.2" fill="#E2E8F0" />
          <rect x="40" y="4" width="21" height="11" rx="5.5" fill="#0F172A" stroke="#38BDF8" strokeWidth="1.3" />
          <circle cx="46" cy="9.5" r="1.4" fill="#38BDF8" />
          <circle cx="50.5" cy="9.5" r="1.4" fill="#A78BFA" />
          <circle cx="55" cy="9.5" r="1.4" fill="#38BDF8" />
        </g>
      )}

      {/* Mini holographic keyboard when typing */}
      {isTyping && (
        <g data-testid="companion-fx-typing" transform="translate(13, 51)">
          <rect
            x="0"
            y="0"
            width="38"
            height="11"
            rx="3"
            fill="#0B1220"
            fillOpacity="0.92"
            stroke="#38BDF8"
            strokeWidth="1.4"
          />
          <rect x="4" y="3" width="5" height="2" rx="0.6" fill="#38BDF8" />
          <rect x="11" y="3" width="5" height="2" rx="0.6" fill="#22D3EE" />
          <rect x="18" y="3" width="5" height="2" rx="0.6" fill="#A78BFA" />
          <rect x="25" y="3" width="5" height="2" rx="0.6" fill="#38BDF8" />
          <rect x="31" y="3" width="4" height="2" rx="0.6" fill="#FDE047" />
          <rect x="6" y="6.8" width="26" height="2" rx="0.8" fill="#38BDF8" fillOpacity="0.8" />
        </g>
      )}

      {/* Pointing cursor pulse & anime exclamation */}
      {isPointing && (
        <g
          data-testid="companion-fx-pointing"
          transform={`translate(${dir > 0 ? 52 : 4}, 34)`}
        >
          <circle cx="4" cy="4" r="5.5" fill="none" stroke="#38BDF8" strokeWidth="1.5" strokeOpacity="0.7" />
          <circle cx="4" cy="4" r="2.2" fill="#38BDF8" />
        </g>
      )}
    </g>
  );
};

const MochiCatSvg: React.FC<{
  emotion: CompanionEmotion;
  facing: "left" | "right";
}> = ({ emotion, facing }) => {
  const eyeOffset = facing === "left" ? -1.5 : 1.5;
  const peekShiftY = emotion === "peeking" ? 6 : 0;

  return (
    <g transform={`translate(0, ${peekShiftY})`}>
      {/* Swishing pixel tail */}
      <g className="gl-anim-tail">
        <path
          d="M46 47 L52 47 L52 42 L55 42 L55 32 L50 32 L50 41 L46 41 Z"
          fill="#FDBA74"
          stroke="#0F172A"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </g>

      {/* Body */}
      <rect x="19" y="37" width="26" height="19" rx="7" fill="#FFF7ED" stroke="#0F172A" strokeWidth="2" />
      {/* Calico belly patch */}
      <rect x="25" y="42" width="14" height="11" rx="5" fill="#FDE68A" fillOpacity="0.55" />

      {/* Collar & golden bell */}
      <rect x="21" y="36" width="22" height="4" rx="2" fill="#F472B6" stroke="#0F172A" strokeWidth="1.4" />
      <circle cx="32" cy="40.5" r="2.8" fill="#FACC15" stroke="#0F172A" strokeWidth="1.2" />

      {/* Head & Ears */}
      <polygon points="17,22 20,10 28,18" fill="#FFF7ED" stroke="#0F172A" strokeWidth="2" strokeLinejoin="round" />
      <polygon points="47,22 44,10 36,18" fill="#FDBA74" stroke="#0F172A" strokeWidth="2" strokeLinejoin="round" />
      <polygon points="19.5,19 21,13 25,18" fill="#F472B6" />
      <polygon points="44.5,19 43,13 39,18" fill="#F472B6" />

      <rect x="16" y="16" width="32" height="22" rx="9" fill="#FFF7ED" stroke="#0F172A" strokeWidth="2" />
      {/* Calico ear-spot */}
      <path d="M36 17 C43 17, 47 20, 47 25 L40 25 C38 22, 36 20, 36 17 Z" fill="#FDBA74" />

      {/* Rosy cheeks */}
      <rect x="19" y="29" width="4" height="2.5" rx="1" fill="#F472B6" fillOpacity="0.7" />
      <rect x="41" y="29" width="4" height="2.5" rx="1" fill="#F472B6" fillOpacity="0.7" />

      {/* Eyes */}
      {emotion === "bonk" ? (
        <g stroke="#0F172A" strokeWidth="2" strokeLinecap="round">
          <path d="M22 24 L26 27 M26 24 L22 27" />
          <path d="M38 24 L42 27 M42 24 L38 27" />
        </g>
      ) : emotion === "celebrate" ? (
        <g fill="none" stroke="#0F172A" strokeWidth="2" strokeLinecap="round">
          <path d="M21 26 Q24 22 27 26" />
          <path d="M37 26 Q40 22 43 26" />
        </g>
      ) : (
        <g>
          <rect x={22.5 + eyeOffset * 0.5} y="23" width="4" height="5" rx="1.8" fill="#0F172A" />
          <rect x={37.5 + eyeOffset * 0.5} y="23" width="4" height="5" rx="1.8" fill="#0F172A" />
          <circle cx={23.7 + eyeOffset} cy="24.4" r="1.1" fill="#FFFFFF" />
          <circle cx={38.7 + eyeOffset} cy="24.4" r="1.1" fill="#FFFFFF" />
        </g>
      )}

      {/* Nose & mouth */}
      <polygon points="31,28.5 33,28.5 32,30" fill="#FB7185" />
      <path d="M29.5 31 Q32 33 34.5 31" fill="none" stroke="#0F172A" strokeWidth="1.5" strokeLinecap="round" />

      {/* Paws (pointing or resting) */}
      {emotion === "pointing" ? (
        <ellipse
          cx={facing === "right" ? 50 : 14}
          cy="41"
          rx="5"
          ry="3.5"
          fill="#FFF7ED"
          stroke="#0F172A"
          strokeWidth="1.8"
        />
      ) : (
        <g>
          <ellipse cx="24" cy="55" rx="4" ry="2.5" fill="#FFF7ED" stroke="#0F172A" strokeWidth="1.6" />
          <ellipse cx="40" cy="55" rx="4" ry="2.5" fill="#FFF7ED" stroke="#0F172A" strokeWidth="1.6" />
        </g>
      )}
    </g>
  );
};

const ByteHackerSvg: React.FC<{
  emotion: CompanionEmotion;
  facing: "left" | "right";
}> = ({ emotion, facing }) => {
  const visorOffset = facing === "left" ? -1.5 : 1.5;
  const peekShiftY = emotion === "peeking" ? 6 : 0;

  return (
    <g transform={`translate(0, ${peekShiftY})`}>
      {/* Antenna */}
      <line x1="32" y1="8" x2="32" y2="15" stroke="#38BDF8" strokeWidth="2" />
      <circle cx="32" cy="7" r="2.6" fill="#22D3EE" stroke="#0F172A" strokeWidth="1.2" />

      {/* Hoodie body */}
      <path
        d="M17 42 C17 36, 47 36, 47 42 L49 56 L15 56 Z"
        fill="#1E293B"
        stroke="#0F172A"
        strokeWidth="2"
      />
      {/* Cyan hoodie zip */}
      <line x1="32" y1="39" x2="32" y2="55" stroke="#38BDF8" strokeWidth="1.6" />

      {/* Head / Hood */}
      <rect x="16" y="14" width="32" height="24" rx="8" fill="#334155" stroke="#0F172A" strokeWidth="2" />
      <rect x="19" y="17" width="26" height="18" rx="6" fill="#0F172A" />

      {/* Holo Visor Glasses */}
      <rect
        x={20 + visorOffset * 0.4}
        y="21"
        width="24"
        height="8.5"
        rx="3"
        fill="#082F49"
        stroke="#38BDF8"
        strokeWidth="1.8"
      />
      {emotion === "bonk" ? (
        <g stroke="#FACC15" strokeWidth="1.8" strokeLinecap="round">
          <path d="M24 23.5 L28 27 M28 23.5 L24 27" />
          <path d="M36 23.5 L40 27 M40 23.5 L36 27" />
        </g>
      ) : (
        <g>
          {/* Glowing pixel visor eyes */}
          <rect x={24 + visorOffset} y="23.5" width="4.5" height="3.5" rx="1" fill="#38BDF8" />
          <rect x={35.5 + visorOffset} y="23.5" width="4.5" height="3.5" rx="1" fill="#22D3EE" />
          {/* Visor scan sheen */}
          <line x1="22" y1="22.5" x2="27" y2="22.5" stroke="#BAE6FD" strokeWidth="1" strokeOpacity="0.65" />
        </g>
      )}

      {/* Smirk / expression */}
      <path
        d={emotion === "celebrate" ? "M28 31 Q32 34.5 36 31" : "M28 32 Q32 33.5 36 31.5"}
        fill="none"
        stroke="#38BDF8"
        strokeWidth="1.6"
        strokeLinecap="round"
      />

      {/* Stylus pointer hand when pointing */}
      {emotion === "pointing" && (
        <line
          x1={facing === "right" ? 45 : 19}
          y1="44"
          x2={facing === "right" ? 54 : 10}
          y2="38"
          stroke="#38BDF8"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      )}
    </g>
  );
};

const SoraAnimeSvg: React.FC<{
  emotion: CompanionEmotion;
  facing: "left" | "right";
}> = ({ emotion, facing }) => {
  const eyeShift = facing === "left" ? -1.4 : 1.4;
  const peekShiftY = emotion === "peeking" ? 5 : 0;

  return (
    <g transform={`translate(0, ${peekShiftY})`}>
      {/* Floating chibi spirit cloak */}
      <path
        d="M21 37 C17 44, 15 53, 19 56 L45 56 C49 53, 47 44, 43 37 Z"
        fill="#7C3AED"
        stroke="#0F172A"
        strokeWidth="2"
      />
      <path d="M25 38 L32 45 L39 38 Z" fill="#FDE047" />

      {/* Back hair silhouette */}
      <ellipse cx="32" cy="24" rx="17" ry="15" fill="#6D28D9" stroke="#0F172A" strokeWidth="2" />

      {/* Face */}
      <ellipse cx="32" cy="26" rx="13" ry="11.5" fill="#FFF1F2" stroke="#0F172A" strokeWidth="1.8" />

      {/* Bangs */}
      <path
        d="M19 23 C22 14, 42 14, 45 23 C41 19, 36 22, 32 18 C28 22, 23 19, 19 23 Z"
        fill="#8B5CF6"
        stroke="#0F172A"
        strokeWidth="1.6"
      />

      {/* Star Crest */}
      <polygon
        points="32,10 33.8,13.5 37.6,14 34.8,16.5 35.5,20.2 32,18.4 28.5,20.2 29.2,16.5 26.4,14 30.2,13.5"
        fill="#FDE047"
        stroke="#0F172A"
        strokeWidth="1.2"
      />

      {/* Expressive Anime Eyes */}
      {emotion === "bonk" ? (
        <g stroke="#0F172A" strokeWidth="2" strokeLinecap="round">
          <path d="M23 24 L27 27 L23 29" fill="none" />
          <path d="M41 24 L37 27 L41 29" fill="none" />
        </g>
      ) : emotion === "celebrate" ? (
        <g fill="none" stroke="#4C1D95" strokeWidth="2.1" strokeLinecap="round">
          <path d="M22.5 27 Q25.5 22.5 28.5 27" />
          <path d="M35.5 27 Q38.5 22.5 41.5 27" />
        </g>
      ) : (
        <g>
          <ellipse cx={25.5 + eyeShift * 0.4} cy="26.5" rx="2.7" ry="3.4" fill="#4C1D95" />
          <ellipse cx={38.5 + eyeShift * 0.4} cy="26.5" rx="2.7" ry="3.4" fill="#4C1D95" />
          <circle cx={24.8 + eyeShift * 0.7} cy="25.2" r="1.2" fill="#FFFFFF" />
          <circle cx={37.8 + eyeShift * 0.7} cy="25.2" r="1.2" fill="#FFFFFF" />
          <circle cx={26.3 + eyeShift * 0.7} cy="28" r="0.6" fill="#C4B5FD" />
          <circle cx={39.3 + eyeShift * 0.7} cy="28" r="0.6" fill="#C4B5FD" />
        </g>
      )}

      {/* Cheeks & chibi mouth */}
      <ellipse cx="21.5" cy="30.5" rx="2.2" ry="1.2" fill="#F472B6" fillOpacity="0.6" />
      <ellipse cx="42.5" cy="30.5" rx="2.2" ry="1.2" fill="#F472B6" fillOpacity="0.6" />
      <path
        d={emotion === "celebrate" ? "M29.5 32 Q32 35.5 34.5 32" : "M30 32.5 Q32 34 34 32.5"}
        fill="none"
        stroke="#0F172A"
        strokeWidth="1.5"
        strokeLinecap="round"
      />

      {/* Pointing star wand */}
      {emotion === "pointing" && (
        <g>
          <line
            x1={facing === "right" ? 44 : 20}
            y1="44"
            x2={facing === "right" ? 54 : 10}
            y2="37"
            stroke="#FDE047"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <circle cx={facing === "right" ? 54 : 10} cy="37" r="2.6" fill="#FDE047" />
        </g>
      )}
    </g>
  );
};

const FlowOrbSvg: React.FC<{
  emotion: CompanionEmotion;
  facing: "left" | "right";
}> = ({ emotion, facing }) => {
  const shift = facing === "left" ? -2.2 : 2.2;
  const ringColor = emotion === "bonk" ? "#FB7185" : emotion === "celebrate" ? "#FDE047" : "#2DD4BF";

  return (
    <g>
      {/* Outer luminous ring */}
      <circle
        cx="32"
        cy="32"
        r="21"
        fill="none"
        stroke={ringColor}
        strokeWidth="1.8"
        strokeDasharray="8 5"
        strokeOpacity="0.75"
      />
      {/* Glass sphere body */}
      <circle
        cx="32"
        cy="32"
        r="16"
        fill="url(#gl-flow-grad)"
        stroke="#38BDF8"
        strokeWidth="2"
      />
      {/* Inner geometric core tracking facing direction */}
      <circle
        cx={32 + shift}
        cy={emotion === "peeking" ? 30 : 32}
        r={emotion === "celebrate" ? 6.5 : 5.2}
        fill={ringColor}
      />
      <circle
        cx={30 + shift * 0.7}
        cy="29.5"
        r="2.1"
        fill="#FFFFFF"
        fillOpacity="0.85"
      />
      {/* Orbiting satellite dot */}
      <circle
        cx={facing === "right" ? 51 : 13}
        cy="24"
        r="3"
        fill="#38BDF8"
        stroke="#0F172A"
        strokeWidth="1.2"
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
        shapeRendering={
          resolvedId === "pixel_cat" || resolvedId === "tech_nerd"
            ? "crispEdges"
            : "geometricPrecision"
        }
      >
        <defs>
          <radialGradient id="gl-flow-grad" cx="40%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#164E63" />
            <stop offset="100%" stopColor="#090D16" />
          </radialGradient>
        </defs>

        {/* Ground shadow */}
        <ellipse
          cx="32"
          cy="58"
          rx={effectiveEmotion === "jumping" ? 10 : 15}
          ry="3"
          fill="#000000"
          fillOpacity="0.32"
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
          accentColor={persona.accentColor}
        />
      </svg>
    </div>
  );
};
