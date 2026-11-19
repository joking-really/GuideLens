import type { BBox, MonitorInfo, RectPx, ResolvedStep } from "../types";

export const AUTO_MAGNIFY_THRESHOLD_PX = 24;
export const DEFAULT_MAGNIFIER_ZOOM = 2.5;
export const DEFAULT_LENS_RADIUS_PX = 56;
export const MIN_CONFIDENCE_FOR_BOX = 0.5;

export interface ViewportSize {
  w: number;
  h: number;
}

export interface BadgePosition {
  x: number;
  y: number;
  placement: "above" | "below" | "inside";
}

export interface MagnifierGeometry {
  /** Center X of the circular lens on the overlay canvas */
  lensCx: number;
  /** Center Y of the circular lens on the overlay canvas */
  lensCy: number;
  /** Radius of the circular lens in pixels */
  radius: number;
  /** Magnification factor (default 2.5x) */
  zoom: number;
  /** Target center X on the overlay canvas */
  targetCx: number;
  /** Target center Y on the overlay canvas */
  targetCy: number;
  /** Source crop X in the captured monitor screenshot */
  sx: number;
  /** Source crop Y in the captured monitor screenshot */
  sy: number;
  /** Source crop width in the captured monitor screenshot */
  sw: number;
  /** Source crop height in the captured monitor screenshot */
  sh: number;
}

/**
 * Converts a 0–1000 normalized bounding box [x, y, w, h] into physical pixel
 * coordinates on the virtual desktop, accounting for monitor offset.
 */
export function normalizedToPhysical(
  bbox: BBox,
  monitor: MonitorInfo,
): RectPx {
  const [nx, ny, nw, nh] = bbox;
  const clampedX = Math.max(0, Math.min(1000, nx));
  const clampedY = Math.max(0, Math.min(1000, ny));
  const clampedW = Math.max(0, Math.min(1000 - clampedX, nw));
  const clampedH = Math.max(0, Math.min(1000 - clampedY, nh));

  return {
    x: Math.round(monitor.x + (clampedX / 1000) * monitor.w),
    y: Math.round(monitor.y + (clampedY / 1000) * monitor.h),
    w: Math.round((clampedW / 1000) * monitor.w),
    h: Math.round((clampedH / 1000) * monitor.h),
  };
}

/**
 * Converts physical virtual-desktop coordinates to local overlay CSS coordinates
 * given the overlay origin and DPI scale factor.
 */
export function physicalToOverlayCoords(
  rect: RectPx,
  dpiScale = 1,
  overlayOrigin: { x: number; y: number } = { x: 0, y: 0 },
): RectPx {
  const safeScale = dpiScale > 0 ? dpiScale : 1;
  return {
    x: (rect.x - overlayOrigin.x) / safeScale,
    y: (rect.y - overlayOrigin.y) / safeScale,
    w: rect.w / safeScale,
    h: rect.h / safeScale,
  };
}

/**
 * Determines whether a resolved step has a confident, valid bounding box to render.
 * Per decisions.md §1: if neither UIA nor brain bbox is confident (<0.5) -> text only, no box.
 */
export function isValidHighlightTarget(
  step: ResolvedStep | null | undefined,
): step is ResolvedStep & { rect_px: RectPx } {
  if (!step) return false;
  if (step.source === "none") return false;
  if (typeof step.confidence === "number" && step.confidence < MIN_CONFIDENCE_FOR_BOX) {
    return false;
  }
  if (!step.rect_px) return false;
  return step.rect_px.w > 0 && step.rect_px.h > 0;
}

/**
 * Returns true if the 2.5x circular magnifier lens should be shown.
 * Automatically activates for tiny targets (< 24x24px) per product_design.md §3.C.
 */
export function shouldAutoMagnify(
  rect: RectPx | null | undefined,
  manualMagnify = false,
  alwaysMagnify = false,
): boolean {
  if (!rect || rect.w <= 0 || rect.h <= 0) {
    return false;
  }
  if (manualMagnify || alwaysMagnify) {
    return true;
  }
  return (
    rect.w < AUTO_MAGNIFY_THRESHOLD_PX || rect.h < AUTO_MAGNIFY_THRESHOLD_PX
  );
}

/**
 * Computes the top-left anchored step badge position (`Step n of N`), flipping
 * below the bounding box if the box is too close to the top of the screen.
 */
export function computeStepBadgePosition(
  rect: RectPx,
  viewport: ViewportSize,
  badgeSize: { w: number; h: number } = { w: 96, h: 24 },
): BadgePosition {
  const gap = 6;
  const maxX = Math.max(4, viewport.w - badgeSize.w - 4);
  const x = Math.max(4, Math.min(rect.x, maxX));

  if (rect.y - badgeSize.h - gap >= 4) {
    return {
      x,
      y: rect.y - badgeSize.h - gap,
      placement: "above",
    };
  }

  if (rect.y + rect.h + gap + badgeSize.h <= viewport.h - 4) {
    return {
      x,
      y: rect.y + rect.h + gap,
      placement: "below",
    };
  }

  return {
    x: Math.max(4, Math.min(rect.x + 4, maxX)),
    y: Math.max(4, rect.y + 4),
    placement: "inside",
  };
}

/**
 * Computes the position of the 2.5x circular magnifier lens and the source crop
 * rectangle inside the captured screenshot image.
 * The lens is offset from the target box so it never blocks the user's click.
 */
export function computeMagnifierGeometry(
  rect: RectPx,
  viewport: ViewportSize,
  options: {
    zoom?: number;
    radius?: number;
    gap?: number;
    monitor?: MonitorInfo | null;
    /** Optional physical rect in virtual-desktop coordinates for high-DPI screenshot cropping */
    sourceRect?: RectPx | null;
  } = {},
): MagnifierGeometry {
  const zoom = options.zoom ?? DEFAULT_MAGNIFIER_ZOOM;
  const radius = options.radius ?? DEFAULT_LENS_RADIUS_PX;
  const gap = options.gap ?? 20;
  const monitor = options.monitor ?? null;

  const targetCx = rect.x + rect.w / 2;
  const targetCy = rect.y + rect.h / 2;

  // Prefer placing the lens to the right and slightly above the target box;
  // flip to the left or below if near viewport edges so it never clips or covers the box.
  const rightCandidateX = rect.x + rect.w + gap + radius;
  const leftCandidateX = rect.x - gap - radius;

  let lensCx: number;
  if (rightCandidateX + radius <= viewport.w - 8) {
    lensCx = rightCandidateX;
  } else if (leftCandidateX - radius >= 8) {
    lensCx = leftCandidateX;
  } else {
    lensCx = Math.max(radius + 8, Math.min(viewport.w - radius - 8, targetCx));
  }

  const topCandidateY = rect.y - gap - radius;
  const bottomCandidateY = rect.y + rect.h + gap + radius;

  let lensCy: number;
  if (
    lensCx !== rightCandidateX &&
    lensCx !== leftCandidateX
  ) {
    // Lens is horizontally centered with target, so offset vertically
    if (topCandidateY - radius >= 8) {
      lensCy = topCandidateY;
    } else {
      lensCy = Math.min(viewport.h - radius - 8, bottomCandidateY);
    }
  } else {
    lensCy = Math.max(
      radius + 8,
      Math.min(viewport.h - radius - 8, targetCy - radius * 0.35),
    );
  }

  // Diameter of the circular lens divided by zoom factor gives the capture crop size
  const srcRect = options.sourceRect ?? rect;
  const srcCx = srcRect.x + srcRect.w / 2;
  const srcCy = srcRect.y + srcRect.h / 2;
  const scaleFactor = monitor && monitor.scale > 0 && options.sourceRect ? monitor.scale : 1;

  const diameter = radius * 2;
  const sw = (diameter * scaleFactor) / zoom;
  const sh = (diameter * scaleFactor) / zoom;

  const monitorOffsetX = monitor ? monitor.x : 0;
  const monitorOffsetY = monitor ? monitor.y : 0;
  const localTargetCx = srcCx - monitorOffsetX;
  const localTargetCy = srcCy - monitorOffsetY;

  let sx = localTargetCx - sw / 2;
  let sy = localTargetCy - sh / 2;

  if (monitor && monitor.w > 0 && monitor.h > 0) {
    sx = Math.max(0, Math.min(monitor.w - sw, sx));
    sy = Math.max(0, Math.min(monitor.h - sh, sy));
  } else {
    sx = Math.max(0, sx);
    sy = Math.max(0, sy);
  }

  return {
    lensCx: Math.round(lensCx),
    lensCy: Math.round(lensCy),
    radius,
    zoom,
    targetCx: Math.round(targetCx),
    targetCy: Math.round(targetCy),
    sx,
    sy,
    sw,
    sh,
  };
}
