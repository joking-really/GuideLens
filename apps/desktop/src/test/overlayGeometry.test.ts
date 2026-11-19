import { describe, expect, it } from "vitest";
import {
  computeMagnifierGeometry,
  computeStepBadgePosition,
  isValidHighlightTarget,
  normalizedToPhysical,
  physicalToOverlayCoords,
  shouldAutoMagnify,
} from "../lib/overlayGeometry";
import type { ResolvedStep } from "../types";

describe("overlayGeometry", () => {
  it("normalizes 0-1000 bbox to physical pixels with multi-monitor offset", () => {
    const rect = normalizedToPhysical([500, 250, 100, 50], {
      x: -1920,
      y: 0,
      w: 1920,
      h: 1080,
      scale: 1,
    });
    expect(rect).toEqual({
      x: -960,
      y: 270,
      w: 192,
      h: 54,
    });
  });

  it("clamps out-of-range normalized coordinates cleanly", () => {
    const rect = normalizedToPhysical([-50, 950, 200, 100], {
      x: 0,
      y: 0,
      w: 1000,
      h: 1000,
      scale: 1,
    });
    expect(rect).toEqual({
      x: 0,
      y: 950,
      w: 200,
      h: 50,
    });
  });

  it("converts physical virtual-desktop rect to DPI-scaled overlay CSS coords", () => {
    const cssRect = physicalToOverlayCoords(
      { x: -1620, y: 300, w: 150, h: 60 },
      1.5,
      { x: -1920, y: 0 },
    );
    expect(cssRect).toEqual({
      x: 200,
      y: 200,
      w: 100,
      h: 40,
    });
  });

  it("rejects low-confidence (<0.5) or source=none highlight targets", () => {
    const baseStep: ResolvedStep = {
      step_number: 1,
      instruction_line: "Click button",
      confidence: 0.49,
      rect_px: { x: 100, y: 100, w: 40, h: 40 },
      source: "vlm",
    };
    expect(isValidHighlightTarget(baseStep)).toBe(false);
    expect(
      isValidHighlightTarget({ ...baseStep, confidence: 0.9, source: "none" }),
    ).toBe(false);
    expect(
      isValidHighlightTarget({ ...baseStep, confidence: 0.85, source: "uia" }),
    ).toBe(true);
  });

  it("auto-triggers magnification for targets smaller than 24x24px", () => {
    expect(shouldAutoMagnify({ x: 10, y: 10, w: 18, h: 18 })).toBe(true);
    expect(shouldAutoMagnify({ x: 10, y: 10, w: 23, h: 30 })).toBe(true);
    expect(shouldAutoMagnify({ x: 10, y: 10, w: 40, h: 32 })).toBe(false);
    expect(shouldAutoMagnify({ x: 10, y: 10, w: 40, h: 32 }, true)).toBe(true);
    expect(shouldAutoMagnify({ x: 10, y: 10, w: 40, h: 32 }, false, true)).toBe(true);
  });

  it("positions step badge above box or flips below near top edge", () => {
    const above = computeStepBadgePosition(
      { x: 300, y: 200, w: 80, h: 32 },
      { w: 1920, h: 1080 },
    );
    expect(above.placement).toBe("above");
    expect(above.y).toBeLessThan(200);

    const nearTop = computeStepBadgePosition(
      { x: 300, y: 5, w: 80, h: 32 },
      { w: 1920, h: 1080 },
    );
    expect(nearTop.placement).toBe("below");
    expect(nearTop.y).toBeGreaterThan(37);
  });

  it("offsets 2.5x magnifier lens away from target and flips near right edge", () => {
    const rightSide = computeMagnifierGeometry(
      { x: 200, y: 300, w: 20, h: 20 },
      { w: 1920, h: 1080 },
    );
    expect(rightSide.zoom).toBe(2.5);
    expect(rightSide.lensCx).toBeGreaterThan(220);

    const nearRightEdge = computeMagnifierGeometry(
      { x: 1880, y: 300, w: 20, h: 20 },
      { w: 1920, h: 1080 },
    );
    expect(nearRightEdge.lensCx).toBeLessThan(1880);
  });

  it("computes source crop coordinates relative to monitor offset", () => {
    const geom = computeMagnifierGeometry(
      { x: 400, y: 200, w: 16, h: 16 },
      { w: 1920, h: 1080 },
      {
        monitor: { x: 1920, y: 0, w: 1920, h: 1080, scale: 1 },
        sourceRect: { x: 2320, y: 200, w: 16, h: 16 },
      },
    );
    // Center of sourceRect relative to monitor.x=1920 is x=408, y=208
    expect(Math.round(geom.sx + geom.sw / 2)).toBe(408);
    expect(Math.round(geom.sy + geom.sh / 2)).toBe(208);
  });
});
