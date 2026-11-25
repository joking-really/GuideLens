import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  computeBubblePosition,
  computeLandingSpot,
  computeWanderWaypoint,
  type Point2D,
  stepParabolicArc,
} from "../companions/companionPhysics";
import { CompanionSpeechBubble } from "../companions/CompanionSpeechBubble";
import {
  type CompanionEmotion,
  CompanionSprite,
  normalizeCompanionEmotion,
} from "../companions/CompanionSprite";
import {
  clearOverlay,
  getOverlayOrigin,
  getSettings,
  isTauriRuntime,
  onLiveSessionEvent,
  onOverlayCleared,
  onOverlayCompanion,
  onSettingsChanged,
  onStepChanged,
  toAssetUrl,
} from "../lib/ipc";
import {
  computeMagnifierGeometry,
  computeStepBadgePosition,
  DEFAULT_LENS_RADIUS_PX,
  DEFAULT_MAGNIFIER_ZOOM,
  isValidHighlightTarget,
  physicalToOverlayCoords,
  shouldAutoMagnify,
} from "../lib/overlayGeometry";
import {
  type CompanionId,
  DEFAULT_SETTINGS,
  type LiveSessionState,
  type OverlayCompanionPayload,
  type StepChangedPayload,
} from "../types";

export interface OverlayCanvasProps {
  initialPayload?: StepChangedPayload | null;
}

const JUMP_DURATION_MS = 440;
const WANDER_TICK_MS = 4800;
const PREVIEW_TTL_MS = 5500;

export const OverlayCanvas: React.FC<OverlayCanvasProps> = ({
  initialPayload = null,
}) => {
  const [payload, setPayload] = useState<StepChangedPayload | null>(
    initialPayload,
  );
  const [highContrastSetting, setHighContrastSetting] = useState(false);
  const [alwaysMagnifySetting, setAlwaysMagnifySetting] = useState(false);
  const [companionId, setCompanionId] = useState<CompanionId>(
    DEFAULT_SETTINGS.companion_id,
  );
  const [companionWander, setCompanionWander] = useState<boolean>(
    DEFAULT_SETTINGS.companion_wander,
  );
  const [screendayEnabled, setScreendayEnabled] = useState<boolean>(
    DEFAULT_SETTINGS.screenday_enabled,
  );
  const [companionOverlay, setCompanionOverlay] =
    useState<OverlayCompanionPayload | null>(null);
  const [liveSession, setLiveSession] = useState<LiveSessionState | null>(null);
  const [wanderTick, setWanderTick] = useState(0);

  const [overlayOrigin, setOverlayOrigin] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [viewport, setViewport] = useState<{ w: number; h: number }>({
    w: typeof window !== "undefined" ? window.innerWidth || 1920 : 1920,
    h: typeof window !== "undefined" ? window.innerHeight || 1080 : 1080,
  });
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);

  const [animatedCompanion, setAnimatedCompanion] = useState<{
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
    rotationDeg: number;
    inFlight: boolean;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedImageRef = useRef<HTMLImageElement | null>(null);
  const loadedSrcRef = useRef<string | null>(null);
  const lastSpotRef = useRef<Point2D | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const didMountJumpRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    getSettings()
      .then((s) => {
        if (mounted) {
          setHighContrastSetting(Boolean(s.high_contrast));
          setAlwaysMagnifySetting(Boolean(s.always_magnify));
          setCompanionId(s.companion_id ?? DEFAULT_SETTINGS.companion_id);
          setCompanionWander(Boolean(s.companion_wander));
          setScreendayEnabled(Boolean(s.screenday_enabled));
        }
      })
      .catch(() => {
        // Ignore settings error outside Tauri
      });

    if (isTauriRuntime()) {
      getOverlayOrigin()
        .then((origin) => {
          if (mounted) setOverlayOrigin(origin);
        })
        .catch(() => {});
    }

    const unlistenStepPromise = onStepChanged((nextPayload) => {
      if (mounted) {
        setPayload(nextPayload);
        if (isTauriRuntime()) {
          getOverlayOrigin()
            .then((origin) => {
              if (mounted) setOverlayOrigin(origin);
            })
            .catch(() => {});
        }
      }
    });

    const unlistenClearPromise = onOverlayCleared(() => {
      if (mounted) {
        setPayload(null);
      }
    });

    const unlistenSettingsPromise = onSettingsChanged((updated) => {
      if (mounted) {
        setHighContrastSetting(Boolean(updated.high_contrast));
        setAlwaysMagnifySetting(Boolean(updated.always_magnify));
        setCompanionId(updated.companion_id ?? DEFAULT_SETTINGS.companion_id);
        setCompanionWander(Boolean(updated.companion_wander));
        setScreendayEnabled(Boolean(updated.screenday_enabled));
      }
    });

    const unlistenCompanionPromise = onOverlayCompanion((nextCompanion) => {
      if (!mounted) return;
      setCompanionOverlay(nextCompanion);
      if (previewTimerRef.current !== null) {
        window.clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
      if (nextCompanion.mode === "preview") {
        previewTimerRef.current = window.setTimeout(() => {
          if (mounted) {
            setCompanionOverlay((prev) =>
              prev?.mode === "preview" ? null : prev,
            );
          }
        }, PREVIEW_TTL_MS);
      }
    });

    const unlistenLivePromise = onLiveSessionEvent((sessionState) => {
      if (!mounted) return;
      setLiveSession(sessionState);
      if (
        sessionState.status === "idle" ||
        sessionState.status === "completed"
      ) {
        if (sessionState.status === "idle") {
          setPayload(null);
        }
      }
    });

    const handleResize = () => {
      setViewport({
        w: window.innerWidth || 1920,
        h: window.innerHeight || 1080,
      });
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPayload(null);
        clearOverlay().catch(() => {
          // Ignore error outside Tauri
        });
      }
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      mounted = false;
      if (previewTimerRef.current !== null) {
        window.clearTimeout(previewTimerRef.current);
      }
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handleKeyDown);
      unlistenStepPromise.then((fn) => fn()).catch(() => {});
      unlistenClearPromise.then((fn) => fn()).catch(() => {});
      unlistenSettingsPromise.then((fn) => fn()).catch(() => {});
      unlistenCompanionPromise.then((fn) => fn()).catch(() => {});
      unlistenLivePromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Gentle wander ticker when Screen Day / wander mode is active without a locked target
  const isScreendayRecording = Boolean(
    companionOverlay && companionOverlay.mode !== "preview"
      ? companionOverlay.screenday_recording
      : screendayEnabled,
  );
  const effectiveWander =
    companionOverlay?.wander ?? (companionWander && isScreendayRecording);

  useEffect(() => {
    if (!effectiveWander && companionOverlay?.mode !== "wander") {
      return;
    }
    const timer = window.setInterval(() => {
      setWanderTick((t) => t + 1);
    }, WANDER_TICK_MS);
    return () => window.clearInterval(timer);
  }, [effectiveWander, companionOverlay?.mode]);

  const step = payload?.step ?? null;
  const hasValidBox = isValidHighlightTarget(step);
  const physicalRect = hasValidBox ? step.rect_px : null;
  const dpiScale =
    typeof window !== "undefined" && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  const physX = physicalRect?.x ?? null;
  const physY = physicalRect?.y ?? null;
  const physW = physicalRect?.w ?? null;
  const physH = physicalRect?.h ?? null;
  const rect = useMemo(
    () =>
      physX !== null && physY !== null && physW !== null && physH !== null
        ? physicalToOverlayCoords(
            { x: physX, y: physY, w: physW, h: physH },
            dpiScale,
            overlayOrigin,
          )
        : null,
    [physX, physY, physW, physH, dpiScale, overlayOrigin],
  );

  const highContrast = payload?.high_contrast ?? highContrastSetting;
  const accentColor = highContrast ? "#FACC15" : "#38BDF8";

  const showMagnifier = shouldAutoMagnify(
    physicalRect,
    Boolean(payload?.magnify),
    alwaysMagnifySetting,
  );

  const captureSrc = payload?.image_base64
    ? payload.image_base64.startsWith("data:")
      ? payload.image_base64
      : `data:image/jpeg;base64,${payload.image_base64}`
    : toAssetUrl(
        payload?.capture_path ??
          (step as { screenshot_path?: string } | null)?.screenshot_path,
      );

  // Draw glowing box & 2.5x magnifier on the 2D canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    ctx.clearRect(0, 0, viewport.w, viewport.h);
    if (!rect || !physicalRect) return;

    ctx.save();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = highContrast ? 3 : 2.5;
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = highContrast ? 16 : 12;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();

    if (showMagnifier) {
      const mag = computeMagnifierGeometry(rect, viewport, {
        zoom: DEFAULT_MAGNIFIER_ZOOM,
        radius: DEFAULT_LENS_RADIUS_PX,
        monitor: payload?.monitor ?? null,
        sourceRect: physicalRect,
      });

      const drawLens = (img: HTMLImageElement | null) => {
        if (!ctx) return;
        ctx.save();
        ctx.beginPath();
        ctx.arc(mag.lensCx, mag.lensCy, mag.radius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();

        ctx.fillStyle = "#09090B";
        ctx.fillRect(
          mag.lensCx - mag.radius,
          mag.lensCy - mag.radius,
          mag.radius * 2,
          mag.radius * 2,
        );

        if (img && img.complete && img.naturalWidth > 0) {
          ctx.drawImage(
            img,
            mag.sx,
            mag.sy,
            mag.sw,
            mag.sh,
            mag.lensCx - mag.radius,
            mag.lensCy - mag.radius,
            mag.radius * 2,
            mag.radius * 2,
          );
        }

        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mag.lensCx - 8, mag.lensCy);
        ctx.lineTo(mag.lensCx + 8, mag.lensCy);
        ctx.moveTo(mag.lensCx, mag.lensCy - 8);
        ctx.lineTo(mag.lensCx, mag.lensCy + 8);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.beginPath();
        ctx.arc(mag.lensCx, mag.lensCy, mag.radius, 0, Math.PI * 2);
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = accentColor;
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.restore();
      };

      if (captureSrc) {
        if (loadedSrcRef.current === captureSrc && loadedImageRef.current) {
          drawLens(loadedImageRef.current);
        } else {
          const img = new Image();
          img.onload = () => {
            loadedSrcRef.current = captureSrc;
            loadedImageRef.current = img;
            setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
            drawLens(img);
          };
          img.src = captureSrc;
          drawLens(null);
        }
      } else {
        drawLens(null);
      }
    }
  }, [
    rect,
    physicalRect,
    viewport,
    accentColor,
    highContrast,
    showMagnifier,
    captureSrc,
    payload?.monitor,
  ]);

  // Resolve companion appearance & target position
  const activeCompanionId: CompanionId =
    companionOverlay?.companion_id ||
    liveSession?.companion_id ||
    companionId;

  const isPreview = companionOverlay?.mode === "preview";
  const isLiveActive =
    Boolean(liveSession) &&
    liveSession!.status !== "idle" &&
    (liveSession!.status !== "completed" || Boolean(companionOverlay));
  const shouldShowIdleCompanion =
    activeCompanionId !== "none" &&
    (isScreendayRecording ||
      isPreview ||
      companionOverlay?.mode === "wander" ||
      companionOverlay?.mode === "bonk" ||
      companionOverlay?.mode === "celebrate" ||
      isLiveActive ||
      (companionWander && companionOverlay !== null));

  const companionSize = 64;

  const targetCompanionAnchor = useMemo(() => {
    if (rect && physicalRect) {
      const spot = computeLandingSpot(rect, viewport, companionSize);
      return {
        x: spot.x,
        y: spot.y,
        facing: spot.facing,
      };
    }

    if (companionOverlay?.x != null && companionOverlay?.y != null) {
      const x = Math.max(
        6,
        Math.min(viewport.w - companionSize - 6, companionOverlay.x),
      );
      const y = Math.max(
        12,
        Math.min(viewport.h - companionSize - 12, companionOverlay.y),
      );
      return {
        x,
        y,
        facing: x > viewport.w / 2 ? ("left" as const) : ("right" as const),
      };
    }

    if (isPreview) {
      return {
        x: Math.max(16, viewport.w - companionSize - 96),
        y: Math.max(16, viewport.h - companionSize - 110),
        facing: "left" as const,
      };
    }

    const activeApp =
      liveSession?.turns?.[liveSession.turns.length - 1]?.active_app ?? null;
    const waypoint = computeWanderWaypoint(
      viewport,
      wanderTick,
      activeApp,
      companionSize,
    );
    return {
      x: waypoint.x,
      y: waypoint.y,
      facing: waypoint.facing,
      wanderEmotion: waypoint.emotion,
    };
  }, [
    rect,
    physicalRect,
    viewport,
    companionOverlay?.x,
    companionOverlay?.y,
    isPreview,
    liveSession,
    wanderTick,
  ]);

  // Smooth parabolic arc jump whenever target position changes cleanly
  const targetKey =
    rect && physicalRect
      ? `step:${Math.round(targetCompanionAnchor.x)},${Math.round(targetCompanionAnchor.y)}`
      : isPreview
        ? `preview:${companionOverlay?.emotion ?? ""}:${Math.round(targetCompanionAnchor.x)}`
        : shouldShowIdleCompanion
          ? `idle:${Math.round(targetCompanionAnchor.x)},${Math.round(targetCompanionAnchor.y)}`
          : "hidden";

  const hasInitialPayload = Boolean(initialPayload);
  const hasRect = Boolean(rect);
  const isPreviewJump = isPreview && companionOverlay?.emotion === "jumping";

  useEffect(() => {
    if (targetKey === "hidden") {
      lastSpotRef.current = null;
      setAnimatedCompanion((prev) => (prev === null ? prev : null));
      return;
    }

    const endPt: Point2D = {
      x: targetCompanionAnchor.x,
      y: targetCompanionAnchor.y,
    };

    const shouldSkipFirstJump =
      !didMountJumpRef.current && hasInitialPayload && hasRect;
    didMountJumpRef.current = true;

    const startPt: Point2D | null = lastSpotRef.current;

    if (
      shouldSkipFirstJump ||
      (!startPt && !isPreviewJump) ||
      (startPt &&
        Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y) < 6 &&
        !isPreviewJump)
    ) {
      lastSpotRef.current = endPt;
      setAnimatedCompanion((prev) =>
        prev &&
        !prev.inFlight &&
        prev.x === endPt.x &&
        prev.y === endPt.y
          ? prev
          : {
              x: endPt.x,
              y: endPt.y,
              scaleX: 1,
              scaleY: 1,
              rotationDeg: 0,
              inFlight: false,
            },
      );
      return;
    }

    const originPt: Point2D = isPreviewJump
      ? { x: Math.max(12, endPt.x - 140), y: endPt.y }
      : startPt ?? {
          x: endPt.x > viewport.w / 2 ? viewport.w - companionSize - 8 : 8,
          y: endPt.y,
        };

    let disposed = false;
    let rafId: number | null = null;
    const startTs =
      typeof performance !== "undefined" ? performance.now() : Date.now();

    const tickFrame = (nowTs: number) => {
      if (disposed) return;
      const elapsed = Math.max(0, nowTs - startTs);
      const progress = Math.min(1, elapsed / JUMP_DURATION_MS);
      const frame = stepParabolicArc(originPt, endPt, progress);
      setAnimatedCompanion({
        x: frame.x,
        y: frame.y,
        scaleX: frame.scaleX,
        scaleY: frame.scaleY,
        rotationDeg: frame.rotationDeg,
        inFlight: !frame.grounded,
      });

      if (progress < 1 && typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(tickFrame);
      } else {
        lastSpotRef.current = endPt;
      }
    };

    if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(tickFrame);
    } else {
      lastSpotRef.current = endPt;
      setAnimatedCompanion({
        x: endPt.x,
        y: endPt.y,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        inFlight: false,
      });
    }

    return () => {
      disposed = true;
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
    };
  }, [
    targetKey,
    targetCompanionAnchor.x,
    targetCompanionAnchor.y,
    hasInitialPayload,
    hasRect,
    isPreviewJump,
    viewport.w,
  ]);

  const companionRenderPos = animatedCompanion ?? {
    x: targetCompanionAnchor.x,
    y: targetCompanionAnchor.y,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    inFlight: false,
  };

  const resolveDisplayedEmotion = (): CompanionEmotion => {
    if (rect && physicalRect && step) {
      if (step.goal_complete) return "celebrate";
      if (step.companion_emotion) {
        return normalizeCompanionEmotion(
          step.companion_emotion,
          step.action_kind,
        );
      }
      if (companionRenderPos.inFlight) return "jumping";
      if (step.action_kind) {
        return normalizeCompanionEmotion(undefined, step.action_kind);
      }
      return "pointing";
    }

    if (companionOverlay?.emotion) {
      return normalizeCompanionEmotion(companionOverlay.emotion);
    }

    if (liveSession) {
      switch (liveSession.status) {
        case "observing":
          return "thinking";
        case "listening":
          return "curious";
        case "completed":
          return "celebrate";
        case "guiding":
          return normalizeCompanionEmotion(
            liveSession.current_step?.companion_emotion,
            liveSession.current_step?.action_kind,
          );
        default:
          break;
      }
    }

    return (
      (targetCompanionAnchor as { wanderEmotion?: CompanionEmotion })
        .wanderEmotion ?? "peeking"
    );
  };

  const renderCompanionLayer = () => {
    const showCompanion =
      activeCompanionId !== "none" &&
      ((Boolean(rect) && Boolean(physicalRect)) || shouldShowIdleCompanion);

    if (!showCompanion) {
      return null;
    }

    const displayedEmotion = resolveDisplayedEmotion();
    const bubbleText =
      step?.instruction_line ??
      companionOverlay?.bubble_text ??
      (liveSession?.status === "observing"
        ? "Looking at your screen…"
        : liveSession?.status === "listening"
          ? "Listening…"
          : liveSession?.current_step?.instruction_line ?? null);

    const stepNum = (payload?.index ?? 0) + 1;
    const totalSteps = Math.max(payload?.total ?? 1, stepNum);
    const stepLabel =
      rect && physicalRect ? `Step ${stepNum}/${totalSteps}` : null;

    const bubblePos = computeBubblePosition(
      { x: companionRenderPos.x, y: companionRenderPos.y },
      companionSize,
      { w: 258, h: 74 },
      viewport,
    );

    return (
      <div
        data-testid="overlay-companion-layer"
        className="absolute inset-0 pointer-events-none overflow-hidden"
      >
        <div
          data-testid="overlay-companion-stage"
          data-in-flight={companionRenderPos.inFlight ? "true" : "false"}
          style={{
            left: `${Math.round(companionRenderPos.x)}px`,
            top: `${Math.round(companionRenderPos.y)}px`,
            width: `${companionSize}px`,
            height: `${companionSize}px`,
            transform: `scale(${companionRenderPos.scaleX.toFixed(3)}, ${companionRenderPos.scaleY.toFixed(3)}) rotate(${companionRenderPos.rotationDeg.toFixed(1)}deg)`,
            transformOrigin: "center bottom",
          }}
          className="absolute pointer-events-none"
        >
          <CompanionSprite
            companionId={activeCompanionId}
            emotion={displayedEmotion}
            actionKind={step?.action_kind ?? null}
            facing={targetCompanionAnchor.facing}
            size={companionSize}
          />

          {isScreendayRecording && !rect && (
            <div
              data-testid="screenday-companion-indicator"
              className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#090B10]/90 border border-rose-500/40 text-[9px] font-semibold text-rose-300 shadow"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
              Diary
            </div>
          )}
        </div>

        {(bubbleText || step?.shortcut || (isScreendayRecording && isPreview)) && (
          <div
            style={{
              left: `${bubblePos.x}px`,
              top: `${bubblePos.y}px`,
            }}
            className="absolute pointer-events-none"
          >
            <CompanionSpeechBubble
              text={bubbleText}
              companionId={activeCompanionId}
              shortcut={step?.shortcut ?? null}
              actionKind={step?.action_kind ?? null}
              stepLabel={stepLabel}
              highContrast={highContrast}
              screendayRecording={isScreendayRecording && !rect}
              placement={bubblePos.side}
            />
          </div>
        )}
      </div>
    );
  };

  if (!payload || !rect || !physicalRect) {
    return (
      <div
        data-testid="overlay-empty"
        className="relative w-screen h-screen bg-transparent pointer-events-none select-none overflow-hidden"
      >
        <canvas
          ref={canvasRef}
          width={viewport.w}
          height={viewport.h}
          className="w-full h-full pointer-events-none"
        />
        {renderCompanionLayer()}
      </div>
    );
  }

  const stepNum = (payload.index ?? 0) + 1;
  const totalSteps = Math.max(payload.total ?? 1, stepNum);
  const badgePos = computeStepBadgePosition(rect, viewport);
  const magGeom = showMagnifier
    ? computeMagnifierGeometry(rect, viewport, {
        zoom: DEFAULT_MAGNIFIER_ZOOM,
        radius: DEFAULT_LENS_RADIUS_PX,
        monitor: payload.monitor ?? null,
        sourceRect: physicalRect,
      })
    : null;

  const lensDiameter = magGeom ? magGeom.radius * 2 : DEFAULT_LENS_RADIUS_PX * 2;
  const sourceW = imgDims?.w ?? payload.monitor?.w ?? viewport.w;
  const sourceH = imgDims?.h ?? payload.monitor?.h ?? viewport.h;
  const cssBgScale =
    magGeom && magGeom.sw > 0
      ? lensDiameter / magGeom.sw
      : DEFAULT_MAGNIFIER_ZOOM;

  return (
    <div
      data-testid="overlay-active"
      aria-label={`Screen highlight overlay for Step ${stepNum} of ${totalSteps}`}
      className="relative w-screen h-screen bg-transparent pointer-events-none select-none overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        width={viewport.w}
        height={viewport.h}
        data-testid="overlay-canvas"
        className="absolute inset-0 w-full h-full pointer-events-none"
      />

      {/* Glowing pulsing bounding box DOM element for crisp CSS animation & accessibility */}
      <div
        data-testid="overlay-highlight-box"
        data-high-contrast={highContrast ? "true" : "false"}
        style={{
          left: `${rect.x}px`,
          top: `${rect.y}px`,
          width: `${rect.w}px`,
          height: `${rect.h}px`,
          borderColor: accentColor,
          boxShadow: `0 0 12px ${accentColor}, inset 0 0 6px ${accentColor}40`,
        }}
        className="gl-pulse-box absolute rounded-md border-2 pointer-events-none"
      />

      {/* Step Badge anchored to top-left corner of the glowing box */}
      <div
        data-testid="overlay-step-badge"
        style={{
          left: `${badgePos.x}px`,
          top: `${badgePos.y}px`,
          backgroundColor: accentColor,
          color: "#0F172A",
        }}
        className="absolute px-2.5 py-0.5 rounded-full text-[12px] font-bold tracking-tight shadow-lg pointer-events-none"
      >
        Step {stepNum} of {totalSteps}
      </div>

      {/* 2.5x Circular Magnifier Lens */}
      {showMagnifier && magGeom && (
        <div
          data-testid="overlay-magnifier-lens"
          data-zoom={magGeom.zoom}
          style={{
            left: `${magGeom.lensCx - magGeom.radius}px`,
            top: `${magGeom.lensCy - magGeom.radius}px`,
            width: `${lensDiameter}px`,
            height: `${lensDiameter}px`,
            borderColor: accentColor,
            boxShadow: `0 4px 20px rgba(0, 0, 0, 0.65), 0 0 12px ${accentColor}80`,
            backgroundImage: captureSrc ? `url("${captureSrc}")` : undefined,
            backgroundRepeat: "no-repeat",
            backgroundSize: captureSrc
              ? `${sourceW * cssBgScale}px ${sourceH * cssBgScale}px`
              : undefined,
            backgroundPosition: `-${magGeom.sx * cssBgScale}px -${magGeom.sy * cssBgScale}px`,
          }}
          className="absolute rounded-full border-2 bg-[#09090B]/90 overflow-hidden pointer-events-none flex items-center justify-center"
        >
          <span
            data-testid="magnifier-zoom-badge"
            style={{ backgroundColor: accentColor, color: "#0F172A" }}
            className="absolute bottom-1 px-1.5 py-0.2 rounded text-[10px] font-bold"
          >
            {magGeom.zoom}×
          </span>
        </div>
      )}

      {/* Companion Sprite & Speech Bubble */}
      {renderCompanionLayer()}
    </div>
  );
};
