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
  side: "left" | "right" | "above";
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
 * Computes one frame along a smooth gravity-arc parabolic leap from `start` to `end`.
 * Includes subtle stretch in mid-air and gentle squash upon landing.
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
    options.arcHeight ?? Math.max(44, Math.min(180, dist * 0.28 + 32));

  // Smooth ease-in-out horizontal/baseline interpolation
  const eased =
    t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  const baseX = start.x + dx * eased;
  const baseY = start.y + dy * eased;

  // Parabolic upward arc: 4 * h * t * (1 - t) peaks at t = 0.5
  const arcLift = 4 * arcHeight * t * (1 - t);
  const y = baseY - arcLift;

  let scaleX = 1;
  let scaleY = 1;
  let rotationDeg = 0;

  if (t > 0 && t < 1) {
    if (t < 0.14) {
      // Takeoff spring
      const k = Math.sin((t / 0.14) * Math.PI);
      scaleX = 1 - 0.06 * k;
      scaleY = 1 + 0.08 * k;
    } else if (t < 0.85) {
      // Mid-air extension
      const midLiftFactor = 4 * t * (1 - t);
      scaleX = 1 - 0.04 * midLiftFactor;
      scaleY = 1 + 0.05 * midLiftFactor;
    } else {
      // Landing squash cushioning
      const landT = (t - 0.85) / 0.15;
      const squash = Math.sin(landT * Math.PI);
      scaleX = 1 + 0.14 * squash;
      scaleY = 1 - 0.12 * squash;
    }

    const dir = Math.abs(dx) < 2 ? 0 : dx > 0 ? 1 : -1;
    rotationDeg = dir * (1 - 2 * t) * -7;
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

/**
 * Generates gentle screen-edge peeking and taskbar-walking waypoints when
 * Screen Day or wander mode is active so the companion never blocks the center.
 */
export function computeWanderWaypoint(
  viewport: ViewportBounds,
  tick: number,
  activeApp?: string | null,
  companionSize = 64,
): WanderWaypoint {
  const safeW = Math.max(companionSize + 16, viewport.w || 1920);
  const safeH = Math.max(companionSize + 64, viewport.h || 1080);
  const minX = 6;
  const maxX = Math.max(minX, safeW - companionSize - 6);
  const taskbarY = clamp(safeH - companionSize - 46, 12, safeH - companionSize - 8);

  const appBias = activeApp ? hashString(activeApp.toLowerCase()) % 4 : 0;
  const normalizedTick = Math.max(0, Math.floor(tick));
  const phase = (normalizedTick + appBias) % 8;

  switch (phase) {
    case 0:
    case 1: {
      // Gentle walk along right side of taskbar
      const walkX = clamp(
        safeW - companionSize - 110 - phase * 65,
        minX,
        maxX,
      );
      return {
        x: Math.round(walkX),
        y: Math.round(taskbarY),
        facing: "left",
        mode: "taskbar_walk",
        emotion: phase === 0 ? "walking" : "idle",
      };
    }
    case 2:
      // Peek curiously from right screen edge
      return {
        x: Math.round(maxX),
        y: Math.round(clamp(safeH * 0.42, 48, taskbarY - 24)),
        facing: "left",
        mode: "peek_right",
        emotion: "peeking",
      };
    case 3:
      // Quiet perch near bottom-right corner
      return {
        x: Math.round(clamp(safeW - companionSize - 32, minX, maxX)),
        y: Math.round(taskbarY),
        facing: "left",
        mode: "corner_perch",
        emotion: "curious",
      };
    case 4:
    case 5: {
      // Gentle walk along left-center taskbar
      const walkX = clamp(84 + (phase - 4) * 72, minX, maxX);
      return {
        x: Math.round(walkX),
        y: Math.round(taskbarY),
        facing: "right",
        mode: "taskbar_walk",
        emotion: phase === 4 ? "walking" : "idle",
      };
    }
    case 6:
      // Peek curiously from left screen edge
      return {
        x: Math.round(minX),
        y: Math.round(clamp(safeH * 0.46, 48, taskbarY - 24)),
        facing: "right",
        mode: "peek_left",
        emotion: "peeking",
      };
    case 7:
    default:
      // Bottom-left quiet perch
      return {
        x: Math.round(clamp(32, minX, maxX)),
        y: Math.round(taskbarY),
        facing: "right",
        mode: "corner_perch",
        emotion: "idle",
      };
  }
}

/**
 * Places the companion speech bubble cleanly beside or above the companion
 * without clipping outside the viewport.
 */
export function computeBubblePosition(
  companionPos: Point2D,
  companionSize: number,
  bubbleSize: { w: number; h: number },
  viewport: ViewportBounds,
): BubblePlacement {
  const safeW = Math.max(bubbleSize.w + 24, viewport.w || 1920);
  const safeH = Math.max(bubbleSize.h + 24, viewport.h || 1080);
  const pad = 12;
  const gap = 10;

  const rightX = companionPos.x + companionSize + gap;
  const leftX = companionPos.x - bubbleSize.w - gap;
  const verticalY = clamp(
    companionPos.y - 6,
    pad,
    Math.max(pad, safeH - bubbleSize.h - pad),
  );

  const compCx = companionPos.x + companionSize / 2;
  const preferLeft = compCx > safeW * 0.56;

  if (preferLeft && leftX >= pad) {
    return { x: Math.round(leftX), y: Math.round(verticalY), side: "left" };
  }
  if (!preferLeft && rightX + bubbleSize.w <= safeW - pad) {
    return { x: Math.round(rightX), y: Math.round(verticalY), side: "right" };
  }
  if (leftX >= pad) {
    return { x: Math.round(leftX), y: Math.round(verticalY), side: "left" };
  }
  if (rightX + bubbleSize.w <= safeW - pad) {
    return { x: Math.round(rightX), y: Math.round(verticalY), side: "right" };
  }

  return {
    x: Math.round(
      clamp(compCx - bubbleSize.w / 2, pad, safeW - bubbleSize.w - pad),
    ),
    y: Math.round(
      clamp(companionPos.y - bubbleSize.h - gap, pad, safeH - bubbleSize.h - pad),
    ),
    side: "above",
  };
}
