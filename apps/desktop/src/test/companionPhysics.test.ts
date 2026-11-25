import { describe, expect, it } from "vitest";
import {
  computeCursorGaze,
  CURSOR_PROXIMITY_PX,
  stepChoreography,
} from "../companions/companionChoreography";
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

  it("stepParabolicArc traces silky easeOutQuart glide with <=16px arc lift, <=2deg lean, and 1.03x settle", () => {
    const start = { x: 100, y: 500 };
    const end = { x: 600, y: 500 };

    const t0 = stepParabolicArc(start, end, 0);
    expect(t0.x).toBe(100);
    expect(t0.y).toBe(500);
    expect(t0.grounded).toBe(true);
    expect(t0.scaleX).toBe(1);
    expect(t0.scaleY).toBe(1);
    expect(t0.rotationDeg).toBe(0);

    const tMid = stepParabolicArc(start, end, 0.5);
    expect(tMid.x).toBeGreaterThan(350); // easeOutQuart advances smoothly ahead of linear
    expect(tMid.y).toBeLessThan(500);
    expect(500 - tMid.y).toBeLessThanOrEqual(16); // gentle max 16px arc lift
    expect(Math.abs(tMid.rotationDeg)).toBeLessThanOrEqual(2);
    expect(tMid.grounded).toBe(false);

    const tLand = stepParabolicArc(start, end, 0.89);
    expect(tLand.scaleX).toBeGreaterThan(1);
    expect(tLand.scaleX).toBeLessThanOrEqual(1.035);
    expect(tLand.scaleY).toBeGreaterThanOrEqual(1);
    expect(tLand.grounded).toBe(false);

    const t1 = stepParabolicArc(start, end, 1);
    expect(t1.x).toBe(600);
    expect(t1.y).toBe(500);
    expect(t1.grounded).toBe(true);
    expect(t1.scaleX).toBe(1);
    expect(t1.scaleY).toBe(1);
    expect(t1.rotationDeg).toBe(0);
  });

  it("computeWanderWaypoint keeps companion peacefully in bottom-right resting zone without edge teleporting", () => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let tick = 0; tick < 8; tick++) {
      const wp = computeWanderWaypoint(viewport, tick, "Code.exe", 64);
      xs.push(wp.x);
      ys.push(wp.y);
      expect(wp.mode).toBe("corner_perch");
      expect(wp.facing).toBe("left");
      expect(wp.x).toBeGreaterThanOrEqual(viewport.w - 64 - 80);
      expect(wp.x + 64).toBeLessThanOrEqual(viewport.w - 12);
      expect(wp.y).toBeGreaterThanOrEqual(viewport.h - 64 - 80);
      expect(wp.y + 64).toBeLessThanOrEqual(viewport.h - 12);
    }
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    expect(spanX).toBeLessThanOrEqual(36);
    expect(spanY).toBeLessThanOrEqual(16);
  });

  it("computeBubblePosition keeps bubble onscreen and avoids overlapping targetRect and step badge", () => {
    const rightPos = computeBubblePosition(
      { x: 1840, y: 400 },
      64,
      { w: 260, h: 74 },
      viewport,
    );
    expect(rightPos.side).toBe("left");
    expect(rightPos.x).toBeGreaterThanOrEqual(12);
    expect(rightPos.x + 260).toBeLessThanOrEqual(viewport.w - 12);

    // When companion is to the left of a target near the left edge (where left bubble wouldn't fit),
    // bubble must NOT overlap targetRect or step badge on the right.
    const targetRect = { x: 230, y: 130, w: 84, h: 22 };
    const bubble = computeBubblePosition(
      { x: 152, y: 109 },
      64,
      { w: 258, h: 74 },
      viewport,
      targetRect,
    );
    const overlapsTarget =
      bubble.x < targetRect.x + targetRect.w &&
      bubble.x + 258 > targetRect.x &&
      bubble.y < targetRect.y + targetRect.h &&
      bubble.y + 74 > targetRect.y - 24;
    expect(overlapsTarget).toBe(false);
    expect(bubble.x).toBeGreaterThanOrEqual(12);
    expect(bubble.y).toBeGreaterThanOrEqual(12);
  });
});

describe("companionChoreography", () => {
  const viewport = { w: 1920, h: 1080 };

  it("cycles organically through idle, peeking, walking, play, and dance near bottom-right", () => {
    const activities = new Set<string>();
    for (let tick = 0; tick < 7; tick++) {
      const state = stepChoreography({ viewport, tick, companionSize: 64 });
      activities.add(state.activity);
      expect(state.cursorNear).toBe(false);
      expect(state.x).toBeGreaterThanOrEqual(12);
      expect(state.x + 64).toBeLessThanOrEqual(viewport.w);
      expect(state.y).toBeGreaterThanOrEqual(12);
      expect(state.y + 64).toBeLessThanOrEqual(viewport.h);
    }
    expect(activities.has("idle")).toBe(true);
    expect(activities.has("peeking")).toBe(true);
    expect(activities.has("walking")).toBe(true);
    expect(activities.has("play")).toBe(true);
    expect(activities.has("dance")).toBe(true);
  });

  it("reacts to nearby cursor (<150px) with curious/play and normalized gaze", () => {
    const base = stepChoreography({ viewport, tick: 0, companionSize: 64 });
    const center = { x: base.x + 32, y: base.y + 32 };

    // Far cursor -> no proximity reaction
    const farGaze = computeCursorGaze(center, {
      x: center.x - 300,
      y: center.y,
    });
    expect(farGaze.distance).toBeGreaterThanOrEqual(CURSOR_PROXIMITY_PX);

    // Medium-near cursor (110px left) -> curious & facing left
    const nearState = stepChoreography(
      {
        viewport,
        tick: 0,
        cursor: { x: center.x - 110, y: center.y - 20 },
        companionSize: 64,
      },
      base,
    );
    expect(nearState.cursorNear).toBe(true);
    expect(nearState.emotion).toBe("curious");
    expect(nearState.facing).toBe("left");
    expect(nearState.gazeX).toBeLessThan(0);
    expect(nearState.gazeY).toBeLessThan(0);

    // Very close cursor (<75px right) -> playful paw-bat & facing right
    const playState = stepChoreography(
      {
        viewport,
        tick: 0,
        cursor: { x: center.x + 40, y: center.y + 10 },
        companionSize: 64,
      },
      base,
    );
    expect(playState.cursorNear).toBe(true);
    expect(playState.emotion).toBe("play");
    expect(playState.facing).toBe("right");
    expect(playState.gazeX).toBeGreaterThan(0);
    expect(playState.gazeY).toBeGreaterThan(0);
  });

  it("transitions to sleep after idle threshold when cursor is far", () => {
    const sleepy = stepChoreography({
      viewport,
      tick: 2,
      idleSeconds: 200,
      cursor: { x: 100, y: 100 },
    });
    expect(sleepy.activity).toBe("sleep");
    expect(sleepy.emotion).toBe("sleep");
  });
});
