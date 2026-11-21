import React, { useEffect, useRef, useState } from "react";
import {
  clearOverlay,
  getOverlayOrigin,
  getSettings,
  isTauriRuntime,
  onOverlayCleared,
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
import type { StepChangedPayload } from "../types";

export interface OverlayCanvasProps {
  initialPayload?: StepChangedPayload | null;
}

export const OverlayCanvas: React.FC<OverlayCanvasProps> = ({
  initialPayload = null,
}) => {
  const [payload, setPayload] = useState<StepChangedPayload | null>(
    initialPayload,
  );
  const [highContrastSetting, setHighContrastSetting] = useState(false);
  const [alwaysMagnifySetting, setAlwaysMagnifySetting] = useState(false);
  const [overlayOrigin, setOverlayOrigin] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [viewport, setViewport] = useState<{ w: number; h: number }>({
    w: typeof window !== "undefined" ? window.innerWidth || 1920 : 1920,
    h: typeof window !== "undefined" ? window.innerHeight || 1080 : 1080,
  });
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedImageRef = useRef<HTMLImageElement | null>(null);
  const loadedSrcRef = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getSettings()
      .then((s) => {
        if (mounted) {
          setHighContrastSetting(Boolean(s.high_contrast));
          setAlwaysMagnifySetting(Boolean(s.always_magnify));
        }
      })
      .catch(() => {
        // Ignore settings error
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
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handleKeyDown);
      unlistenStepPromise.then((fn) => fn()).catch(() => {});
      unlistenClearPromise.then((fn) => fn()).catch(() => {});
      unlistenSettingsPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const step = payload?.step ?? null;
  const hasValidBox = isValidHighlightTarget(step);
  const physicalRect = hasValidBox ? step.rect_px : null;
  const dpiScale =
    typeof window !== "undefined" && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  const rect = physicalRect
    ? physicalToOverlayCoords(physicalRect, dpiScale, overlayOrigin)
    : null;

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

  // Draw on the 2D canvas whenever payload, viewport, or image updates
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

    // 1. Draw glowing bounding box
    ctx.save();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = highContrast ? 3 : 2.5;
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = highContrast ? 16 : 12;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();

    // 2. Draw 2.5x circular magnifier lens if active
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

        // Crosshair at center of lens
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mag.lensCx - 8, mag.lensCy);
        ctx.lineTo(mag.lensCx + 8, mag.lensCy);
        ctx.moveTo(mag.lensCx, mag.lensCy - 8);
        ctx.lineTo(mag.lensCx, mag.lensCy + 8);
        ctx.stroke();
        ctx.restore();

        // Outer ring of magnifier lens
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

  if (!payload || !rect || !physicalRect) {
    return (
      <div
        data-testid="overlay-empty"
        className="w-screen h-screen bg-transparent pointer-events-none select-none overflow-hidden"
      >
        <canvas
          ref={canvasRef}
          width={viewport.w}
          height={viewport.h}
          className="w-full h-full pointer-events-none"
        />
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
  const cssBgScale = magGeom && magGeom.sw > 0 ? lensDiameter / magGeom.sw : DEFAULT_MAGNIFIER_ZOOM;

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
    </div>
  );
};
