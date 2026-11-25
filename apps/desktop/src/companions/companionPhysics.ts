import type { RectPx } from "../types";

export interface Point2D {
  x: number;
  y: number;
}

export interface ViewportBounds {
  w: number;
  h: number;
}

export interface LandingSpot {
  x: number;
  y: number;
  facing: "left" | "right";
  anchor: "left" | "right" | "above" | "below";
}

export interface ParabolicFrame {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  grounded: boolean;
  progress: number;
}

export interface WanderWaypoint {
  x: number;
  y: number;
  facing: "left" | "right";
  mode: "peek_left" | "peek_right" | "taskbar_walk" | "corner_perch";
  emotion: "peeking" | "walking" | "curious" | "idle";
}

export interface BubblePlacement {
  x: number;
  y: number;
  side: "left" | "right" | "above" | "below";
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function rectsOverlap(a: RectPx, b: RectPx): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

/**
 * Anchors the companion neatly beside or above `targetRect` without clipping
 * outside the viewport or covering the center of the target element.
 */
export function computeLandingSpot(
  targetRect: RectPx,
  viewport: ViewportBounds,
  companionSize = 64,
  margin = 14,
): LandingSpot {
  const safeW = Math.max(companionSize + 16, viewport.w || 1920);
  const safeH = Math.max(companionSize + 16, viewport.h || 1080);
  const pad = 12;
  const maxX = Math.max(pad, safeW - companionSize - pad);
  const maxY = Math.max(pad, safeH - companionSize - pad);

  const targetCx = targetRect.x + targetRect.w / 2;
  const targetCy = targetRect.y + targetRect.h / 2;
  const alignedY = clamp(targetCy - companionSize * 0.6, pad, maxY);
  const alignedX = clamp(targetCx - companionSize / 2, pad, maxX);

  const isTinyTarget = targetRect.w < 24 || targetRect.h < 24;

  const leftCand: LandingSpot = {
    x: targetRect.x - companionSize - margin,
    y: alignedY,
    facing: "right",
    anchor: "left",
  };
  const rightCand: LandingSpot = {
    x: targetRect.x + targetRect.w + margin,
    y: alignedY,
    facing: "left",
    anchor: "right",
  };
  const aboveCand: LandingSpot = {
    x: alignedX,
    y: targetRect.y - companionSize - margin,
    facing: targetCx > safeW / 2 ? "left" : "right",
    anchor: "above",
  };
  const belowCand: LandingSpot = {
    x: alignedX,
    y: targetRect.y + targetRect.h + margin,
    facing: targetCx > safeW / 2 ? "left" : "right",
    anchor: "below",
  };

  const fitsCleanly = (cand: LandingSpot): boolean => {
    if (cand.x < pad || cand.x > maxX || cand.y < pad || cand.y > maxY) {
      return false;
    }
    const compBox: RectPx = {
      x: cand.x,
      y: cand.y,
      w: companionSize,
      h: companionSize,
    };
    return !rectsOverlap(compBox, targetRect);
  };

  // For tiny targets, the 2.5x magnifier lens favors the right side, so prefer left first.
  const order: LandingSpot[] = isTinyTarget
    ? [leftCand, aboveCand, rightCand, belowCand]
    : targetCx >= safeW * 0.52
      ? [leftCand, aboveCand, rightCand, belowCand]
      : [rightCand, leftCand, aboveCand, belowCand];

  for (const cand of order) {
    if (fitsCleanly(cand)) {
      return {
        ...cand,
        x: Math.round(cand.x),
        y: Math.round(cand.y),
      };
    }
  }

  // Fallback for full-screen / edge-hugging targets: pick side farthest from center without covering center.
  const fallbackX =
    targetCx > safeW / 2
      ? clamp(targetRect.x - companionSize - 8, pad, maxX)
      : clamp(targetRect.x + targetRect.w + 8, pad, maxX);
  let fallbackY = alignedY;

  const boxAtFallback: RectPx = {
    x: fallbackX,
    y: fallbackY,
    w: companionSize,
    h: companionSize,
  };
  if (
    targetCx >= boxAtFallback.x &&
    targetCx <= boxAtFallback.x + companionSize &&
    targetCy >= boxAtFallback.y &&
    targetCy <= boxAtFallback.y + companionSize
  ) {
    fallbackY =
      targetCy > safeH / 2
        ? clamp(targetCy - companionSize - 24, pad, maxY)
        : clamp(targetCy + 24, pad, maxY);
  }

  return {
    x: Math.round(fallbackX),
    y: Math.round(fallbackY),
    facing: fallbackX < targetCx ? "right" : "left",
    anchor: fallbackX < targetCx ? "left" : "right",
  };
}

/**
 * Computes one frame along a silky easeOutQuart glide from `start` to `end`
 * with a gentle <=16px arc lift, <=2deg lean, and subtle 1.03x settle.
 */
export function stepParabolicArc(
  start: Point2D,
  end: Point2D,
  progress: number,
  options: { arcHeight?: number } = {},
): ParabolicFrame {
  const t = Math.max(0, Math.min(1, progress));
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);
  const arcHeight =
    options.arcHeight ??
    (dist < 4 ? 0 : Math.min(16, Math.max(4, dist * 0.04)));

  // Silky easeOutQuart trajectory
  const eased = 1 - Math.pow(1 - t, 4);

  const baseX = start.x + dx * eased;
  const baseY = start.y + dy * eased;

  // Gentle arc lift peaking at mid-flight (max 16px)
  const arcLift = 4 * arcHeight * t * (1 - t);
  const y = baseY - arcLift;

  let scaleX = 1;
  let scaleY = 1;
  let rotationDeg = 0;

  if (t > 0 && t < 1) {
    // Subtle 1.03x settle cushion near landing, zero cartoony squash
    if (t >= 0.78) {
      const landT = (t - 0.78) / 0.22;
      const settle = Math.sin(landT * Math.PI);
      scaleX = 1 + 0.03 * settle;
      scaleY = 1 + 0.03 * settle;
    }

    const dir = Math.abs(dx) < 2 ? 0 : dx > 0 ? 1 : -1;
    rotationDeg = dir * Math.sin(t * Math.PI) * 2;
  }

  return {
    x: baseX,
    y,
    scaleX,
    scaleY,
    rotationDeg,
    grounded: t === 0 || t >= 1,
    progress: t,
  };
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

const CALM_PERCH_OFFSETS: ReadonlyArray<{
  dx: number;
  dy: number;
  emotion: WanderWaypoint["emotion"];
}> = [
  { dx: 0, dy: 0, emotion: "idle" },
  { dx: -16, dy: -4, emotion: "idle" },
  { dx: -32, dy: -2, emotion: "curious" },
  { dx: -18, dy: -8, emotion: "idle" },
  { dx: -6, dy: -3, emotion: "peeking" },
  { dx: -24, dy: 0, emotion: "idle" },
];

/**
 * Keeps the companion peacefully in a small bottom-right resting zone just above
 * the taskbar, drifting subtly ~24-36px with zero edge-to-edge teleporting.
 */
export function computeWanderWaypoint(
  viewport: ViewportBounds,
  tick: number,
  activeApp?: string | null,
  companionSize = 64,
): WanderWaypoint {
  const safeW = Math.max(companionSize + 16, viewport.w || 1920);
  const safeH = Math.max(companionSize + 64, viewport.h || 1080);
  const minX = 12;
  const maxX = Math.max(minX, safeW - companionSize - 12);
  const taskbarY = clamp(
    safeH - companionSize - 56,
    12,
    safeH - companionSize - 12,
  );
  const baseX = clamp(safeW - companionSize - 36, minX, maxX);

  const appBias = activeApp ? hashString(activeApp.toLowerCase()) % 3 : 0;
  const normalizedTick = Math.max(0, Math.floor(tick));
  const step =
    CALM_PERCH_OFFSETS[(normalizedTick + appBias) % CALM_PERCH_OFFSETS.length];

  return {
    x: Math.round(clamp(baseX + step.dx, minX, maxX)),
    y: Math.round(clamp(taskbarY + step.dy, 12, safeH - companionSize - 12)),
    facing: "left",
    mode: "corner_perch",
    emotion: step.emotion,
  };
}

/**
 * Places the companion speech bubble cleanly beside, above, or below the companion
 * without clipping outside the viewport or covering `targetRect` / its step badge.
 */
export function computeBubblePosition(
  companionPos: Point2D,
  companionSize: number,
  bubbleSize: { w: number; h: number },
  viewport: ViewportBounds,
  targetRect: RectPx | null = null,
): BubblePlacement {
  const safeW = Math.max(bubbleSize.w + 24, viewport.w || 1920);
  const safeH = Math.max(bubbleSize.h + 24, viewport.h || 1080);
  const pad = 12;
  const gap = 10;
  const maxX = Math.max(pad, safeW - bubbleSize.w - pad);
  const maxY = Math.max(pad, safeH - bubbleSize.h - pad);

  const rightX = companionPos.x + companionSize + gap;
  const leftX = companionPos.x - bubbleSize.w - gap;
  const verticalY = clamp(companionPos.y - 6, pad, maxY);
  const compCx = companionPos.x + companionSize / 2;
  const centeredX = clamp(compCx - bubbleSize.w / 2, pad, maxX);

  const companionBox: RectPx = {
    x: companionPos.x,
    y: companionPos.y,
    w: companionSize,
    h: companionSize,
  };

  // Pad targetRect to protect both the highlight box and its step badge.
  const protectedRect: RectPx | null = targetRect
    ? (() => {
        const badgeAbove = targetRect.y >= 34;
        const topPad = badgeAbove ? 30 : 6;
        const bottomPad = badgeAbove ? 6 : 30;
        return {
          x: targetRect.x - 6,
          y: targetRect.y - topPad,
          w: targetRect.w + 12,
          h: targetRect.h + topPad + bottomPad,
        };
      })()
    : null;

  const leftCand: BubblePlacement = {
    x: Math.round(leftX),
    y: Math.round(verticalY),
    side: "left",
  };
  const rightCand: BubblePlacement = {
    x: Math.round(rightX),
    y: Math.round(verticalY),
    side: "right",
  };
  const aboveCand: BubblePlacement = {
    x: Math.round(centeredX),
    y: Math.round(companionPos.y - bubbleSize.h - gap),
    side: "above",
  };
  const belowCand: BubblePlacement = {
    x: Math.round(centeredX),
    y: Math.round(companionPos.y + companionSize + gap),
    side: "below",
  };

  const candidates: BubblePlacement[] = [];
  if (targetRect && protectedRect) {
    const targetCx = targetRect.x + targetRect.w / 2;
    const aboveTarget: BubblePlacement = {
      x: Math.round(centeredX),
      y: Math.round(protectedRect.y - bubbleSize.h - gap),
      side: "above",
    };
    const belowTarget: BubblePlacement = {
      x: Math.round(centeredX),
      y: Math.round(protectedRect.y + protectedRect.h + gap),
      side: "below",
    };
    if (compCx <= targetCx) {
      candidates.push(
        leftCand,
        aboveCand,
        belowCand,
        aboveTarget,
        belowTarget,
        rightCand,
      );
    } else {
      candidates.push(
        rightCand,
        aboveCand,
        belowCand,
        aboveTarget,
        belowTarget,
        leftCand,
      );
    }
  } else {
    const preferLeft = compCx > safeW * 0.56;
    if (preferLeft) {
      candidates.push(leftCand, rightCand, aboveCand, belowCand);
    } else {
      candidates.push(rightCand, leftCand, aboveCand, belowCand);
    }
  }

  const fitsCleanly = (cand: BubblePlacement): boolean => {
    if (cand.x < pad || cand.x > maxX || cand.y < pad || cand.y > maxY) {
      return false;
    }
    const bubbleBox: RectPx = {
      x: cand.x,
      y: cand.y,
      w: bubbleSize.w,
      h: bubbleSize.h,
    };
    if (protectedRect && rectsOverlap(bubbleBox, protectedRect)) {
      return false;
    }
    if (protectedRect && rectsOverlap(bubbleBox, companionBox)) {
      return false;
    }
    return true;
  };

  for (const cand of candidates) {
    if (fitsCleanly(cand)) {
      return cand;
    }
  }

  // Fallback: stay inside viewport and avoid targetRect if possible
  const clampedAbove: BubblePlacement = {
    x: Math.round(centeredX),
    y: Math.round(
      clamp(
        protectedRect
          ? protectedRect.y + protectedRect.h + gap
          : companionPos.y - bubbleSize.h - gap,
        pad,
        maxY,
      ),
    ),
    side: protectedRect ? "below" : "above",
  };
  return clampedAbove;
}
