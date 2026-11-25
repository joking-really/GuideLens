import { describe, expect, it } from "vitest";
import {
  computeBubblePosition,
  computeLandingSpot,
  computeWanderWaypoint,
  stepParabolicArc,
} from "../companions/companionPhysics";
import {
  COMPANION_PERSONAS,
  getCompanionPersona,
  VISIBLE_COMPANIONS,
} from "../companions/personas";

describe("companion personas", () => {
  it("exposes all 4 personas with exact default voice, pitch, and speed metadata", () => {
    expect(VISIBLE_COMPANIONS).toHaveLength(4);

    expect(COMPANION_PERSONAS.pixel_cat).toMatchObject({
      id: "pixel_cat",
      name: "Mochi",
      defaultVoice: "F2",
      defaultPitch: 1.5,
      defaultSpeed: 1.06,
    });
    expect(COMPANION_PERSONAS.tech_nerd).toMatchObject({
      id: "tech_nerd",
      name: "Byte",
      defaultVoice: "M2",
      defaultPitch: 0.0,
      defaultSpeed: 1.08,
    });
    expect(COMPANION_PERSONAS.anime_guide).toMatchObject({
      id: "anime_guide",
      name: "Sora",
      defaultVoice: "F2",
      defaultPitch: 2.5,
      defaultSpeed: 1.04,
    });
    expect(COMPANION_PERSONAS.minimal_orb).toMatchObject({
      id: "minimal_orb",
      name: "Flow",
      defaultVoice: "M2",
      defaultPitch: 0.0,
      defaultSpeed: 1.02,
    });
    expect(COMPANION_PERSONAS.none.id).toBe("none");

    expect(getCompanionPersona(null).id).toBe("pixel_cat");
    expect(getCompanionPersona(undefined).id).toBe("pixel_cat");
    expect(getCompanionPersona("unknown_id").id).toBe("pixel_cat");
    expect(getCompanionPersona("tech_nerd").name).toBe("Byte");
    expect(getCompanionPersona("none").id).toBe("none");
  });
});

describe("companionPhysics", () => {
  const viewport = { w: 1920, h: 1080 };

  it("computeLandingSpot stays onscreen and avoids covering target center", () => {
    const centerBtn = { x: 400, y: 300, w: 120, h: 40 };
    const spot = computeLandingSpot(centerBtn, viewport, 64);
    expect(spot.x).toBeGreaterThanOrEqual(12);
    expect(spot.y).toBeGreaterThanOrEqual(12);
    expect(spot.x + 64).toBeLessThanOrEqual(viewport.w - 12);
    expect(spot.y + 64).toBeLessThanOrEqual(viewport.h - 12);

    const btnCx = centerBtn.x + centerBtn.w / 2;
    const btnCy = centerBtn.y + centerBtn.h / 2;
    const coversCenter =
      btnCx >= spot.x &&
      btnCx <= spot.x + 64 &&
      btnCy >= spot.y &&
      btnCy <= spot.y + 64;
    expect(coversCenter).toBe(false);

    // Near right edge -> lands to the left facing right
    const rightEdgeBtn = { x: 1840, y: 260, w: 70, h: 36 };
    const leftSpot = computeLandingSpot(rightEdgeBtn, viewport, 64);
    expect(leftSpot.x + 64).toBeLessThanOrEqual(rightEdgeBtn.x);
    expect(leftSpot.facing).toBe("right");

    // Near left edge -> lands to the right facing left
    const leftEdgeBtn = { x: 8, y: 260, w: 70, h: 36 };
    const rightSpot = computeLandingSpot(leftEdgeBtn, viewport, 64);
    expect(rightSpot.x).toBeGreaterThanOrEqual(leftEdgeBtn.x + leftEdgeBtn.w);
    expect(rightSpot.facing).toBe("left");

    // Tiny target (<24px) prefers left side so it avoids the 2.5x right-hand magnifier
    const tinyBtn = { x: 300, y: 500, w: 14, h: 14 };
    const tinySpot = computeLandingSpot(tinyBtn, viewport, 64);
    expect(tinySpot.anchor).toBe("left");
    expect(tinySpot.facing).toBe("right");
  });

  it("stepParabolicArc traces clean gravity arc with mid-air lift and landing squash", () => {
    const start = { x: 100, y: 500 };
    const end = { x: 600, y: 500 };

    const t0 = stepParabolicArc(start, end, 0);
    expect(t0.x).toBe(100);
    expect(t0.y).toBe(500);
    expect(t0.grounded).toBe(true);
    expect(t0.scaleX).toBe(1);
    expect(t0.scaleY).toBe(1);

    const tMid = stepParabolicArc(start, end, 0.5);
    expect(tMid.x).toBeCloseTo(350, 1);
    expect(tMid.y).toBeLessThan(460); // Lifted upward cleanly
    expect(tMid.grounded).toBe(false);

    const tLand = stepParabolicArc(start, end, 0.92);
    expect(tLand.scaleX).toBeGreaterThan(1);
    expect(tLand.scaleY).toBeLessThan(1);
    expect(tLand.grounded).toBe(false);

    const t1 = stepParabolicArc(start, end, 1);
    expect(t1.x).toBe(600);
    expect(t1.y).toBe(500);
    expect(t1.grounded).toBe(true);
    expect(t1.scaleX).toBe(1);
    expect(t1.scaleY).toBe(1);
  });

  it("computeWanderWaypoint hugs screen edges and taskbar across ticks", () => {
    const seenModes = new Set<string>();
    for (let tick = 0; tick < 8; tick++) {
      const wp = computeWanderWaypoint(viewport, tick, "Code.exe", 64);
      seenModes.add(wp.mode);
      expect(wp.x).toBeGreaterThanOrEqual(6);
      expect(wp.x + 64).toBeLessThanOrEqual(viewport.w - 6);
      expect(wp.y).toBeGreaterThanOrEqual(12);
      expect(wp.y + 64).toBeLessThanOrEqual(viewport.h - 8);
    }
    expect(seenModes.has("taskbar_walk")).toBe(true);
    expect(seenModes.has("peek_left") || seenModes.has("peek_right")).toBe(true);
  });

  it("computeBubblePosition keeps bubble onscreen near screen edges", () => {
    const rightPos = computeBubblePosition(
      { x: 1840, y: 400 },
      64,
      { w: 260, h: 74 },
      viewport,
    );
    expect(rightPos.side).toBe("left");
    expect(rightPos.x).toBeGreaterThanOrEqual(12);
    expect(rightPos.x + 260).toBeLessThanOrEqual(viewport.w - 12);
  });
});
