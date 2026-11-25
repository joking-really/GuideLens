import type { Point2D, ViewportBounds } from "./companionPhysics";
import type { CompanionEmotion } from "./CompanionSprite";

export type ChoreographyActivity =
  | "idle"
  | "peeking"
  | "walking"
  | "play"
  | "dance"
  | "curious"
  | "sleep";

export interface ChoreographyState {
  activity: ChoreographyActivity;
  emotion: CompanionEmotion;
  x: number;
  y: number;
  facing: "left" | "right";
  phaseTick: number;
  cursorNear: boolean;
  gazeX: number;
  gazeY: number;
}

export interface ChoreographyInput {
  viewport: ViewportBounds;
  tick: number;
  cursor?: Point2D | null;
  companionSize?: number;
  activeApp?: string | null;
  idleSeconds?: number;
}

export const CURSOR_PROXIMITY_PX = 150;
export const CURSOR_PLAY_PROXIMITY_PX = 75;
export const IDLE_SLEEP_THRESHOLD_SEC = 180;

interface ChoreographyFrameSpec {
  dx: number;
  dy: number;
  facing: "left" | "right";
  activity: ChoreographyActivity;
  emotion: CompanionEmotion;
}

const CHOREOGRAPHY_CYCLE: readonly ChoreographyFrameSpec[] = [
  { dx: 0, dy: 0, facing: "left", activity: "idle", emotion: "idle" },
  { dx: 24, dy: 40, facing: "left", activity: "peeking", emotion: "peeking" },
  { dx: -14, dy: 0, facing: "left", activity: "walking", emotion: "walking" },
  { dx: -38, dy: -2, facing: "left", activity: "play", emotion: "play" },
  { dx: -16, dy: 0, facing: "right", activity: "walking", emotion: "walking" },
  { dx: -4, dy: -4, facing: "left", activity: "dance", emotion: "dance" },
  { dx: 0, dy: 0, facing: "left", activity: "idle", emotion: "idle" },
];

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function hashAppBias(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Computes normalized [-1, 1] eye gaze vector from `companionCenter` toward `cursor`
 * along with Euclidean pixel distance.
 */
export function computeCursorGaze(
  companionCenter: Point2D,
  cursor: Point2D | null | undefined,
  gazeSpanPx = 140,
): { gazeX: number; gazeY: number; distance: number } {
  if (!cursor || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) {
    return { gazeX: 0, gazeY: 0, distance: Infinity };
  }
  const dx = cursor.x - companionCenter.x;
  const dy = cursor.y - companionCenter.y;
  const distance = Math.hypot(dx, dy);
  const span = Math.max(24, gazeSpanPx);

  return {
    gazeX: clamp(dx / span, -1, 1),
    gazeY: clamp(dy / span, -1, 1),
    distance,
  };
}

/**
 * Pure idle choreography state machine:
 * - Cycles organically near the bottom-right resting zone & screen rim through
 *   idle -> peeking -> walking -> play -> walking -> dance.
 * - Immediately reacts with `curious` / `play` + live gaze when cursor comes within 150px.
 */
export function stepChoreography(
  input: ChoreographyInput,
  prevState?: ChoreographyState | null,
): ChoreographyState {
  const companionSize = input.companionSize ?? 64;
  const safeW = Math.max(companionSize + 24, input.viewport.w || 1920);
  const safeH = Math.max(companionSize + 64, input.viewport.h || 1080);

  const minX = 12;
  const maxX = Math.max(minX, safeW - companionSize - 8);
  const minY = 12;
  const maxY = Math.max(minY, safeH - companionSize - 8);

  const baseX = clamp(safeW - companionSize - 36, minX, maxX);
  const baseY = clamp(safeH - companionSize - 52, minY, maxY);

  const normalizedTick = Math.max(0, Math.floor(input.tick));
  const appBias = input.activeApp
    ? hashAppBias(input.activeApp.toLowerCase()) % CHOREOGRAPHY_CYCLE.length
    : 0;
  const frame =
    CHOREOGRAPHY_CYCLE[(normalizedTick + appBias) % CHOREOGRAPHY_CYCLE.length];

  const anchorX = Math.round(clamp(baseX + frame.dx, minX, maxX));
  const anchorY = Math.round(clamp(baseY + frame.dy, minY, maxY));

  const referenceX = prevState ? prevState.x : anchorX;
  const referenceY = prevState ? prevState.y : anchorY;
  const center: Point2D = {
    x: referenceX + companionSize / 2,
    y: referenceY + companionSize / 2,
  };

  const { gazeX, gazeY, distance } = computeCursorGaze(center, input.cursor);
  const cursorNear = distance < CURSOR_PROXIMITY_PX;

  if (cursorNear && input.cursor) {
    const isVeryClose = distance < CURSOR_PLAY_PROXIMITY_PX;
    const reactionEmotion: CompanionEmotion =
      isVeryClose || normalizedTick % 2 === 1 ? "play" : "curious";
    const facing: "left" | "right" =
      input.cursor.x >= center.x ? "right" : "left";

    return {
      activity: reactionEmotion,
      emotion: reactionEmotion,
      x: Math.round(referenceX),
      y: Math.round(referenceY),
      facing,
      phaseTick: normalizedTick,
      cursorNear: true,
      gazeX,
      gazeY,
    };
  }

  if ((input.idleSeconds ?? 0) >= IDLE_SLEEP_THRESHOLD_SEC) {
    return {
      activity: "sleep",
      emotion: "sleep",
      x: Math.round(baseX),
      y: Math.round(baseY),
      facing: "left",
      phaseTick: normalizedTick,
      cursorNear: false,
      gazeX: 0,
      gazeY: 0,
    };
  }

  return {
    activity: frame.activity,
    emotion: frame.emotion,
    x: anchorX,
    y: anchorY,
    facing: frame.facing,
    phaseTick: normalizedTick,
    cursorNear: false,
    gazeX: input.cursor ? gazeX : frame.facing === "left" ? -0.55 : 0.55,
    gazeY: input.cursor ? gazeY : 0,
  };
}
