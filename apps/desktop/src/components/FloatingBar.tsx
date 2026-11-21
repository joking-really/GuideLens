import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ask,
  clearOverlay,
  getSettings,
  isTauriRuntime,
  nextStep,
  onBarSummoned,
  onBrainStatus,
  onOverlayCleared,
  onSettingsChanged,
  onStepChanged,
  onWindowMoved,
  openSettingsWindow,
  resizeBarWindow,
  restoreBarPosition,
  setSettings,
  startBarDrag,
  toggleMagnify,
  writeSavedBarPosition,
} from "../lib/ipc";
import {
  type AskError,
  type BrainKind,
  type BrainMode,
  type BrainStatusPayload,
  DEFAULT_SETTINGS,
  formatBrainPillLabel,
  type ResolvedStep,
  type Settings,
  type StepMode,
} from "../types";
import { OnboardingView } from "./OnboardingView";
import { ResponseBlock } from "./ResponseBlock";
import { SettingsView } from "./SettingsView";
import { VoiceIndicator } from "./VoiceIndicator";

const BRAIN_CYCLE_ORDER: BrainMode[] = [
  "local_vlm",
  "byo_api",
  "groq_pro",
  "agent_cli",
  "auto",
];

export interface FloatingBarProps {
  initialSettings?: Partial<Settings>;
  showOnboardingInitially?: boolean;
}

export const FloatingBar: React.FC<FloatingBarProps> = ({
  initialSettings,
  showOnboardingInitially = false,
}) => {
  const [settings, setLocalSettings] = useState<Settings>({
    ...DEFAULT_SETTINGS,
    onboarding_complete: !showOnboardingInitially,
    ...initialSettings,
  });
  const [showOnboarding, setShowOnboarding] = useState<boolean>(
    showOnboardingInitially,
  );
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false);

  const [query, setQuery] = useState("");
  const [lastSubmittedQuery, setLastSubmittedQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [brainStatus, setBrainStatus] = useState<BrainStatusPayload | null>(
    null,
  );
  const [error, setError] = useState<AskError | null>(null);

  const [activeBrain, setActiveBrain] = useState<BrainKind | null>(null);
  const [mode, setMode] = useState<StepMode>("guide");
  const [steps, setSteps] = useState<ResolvedStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [totalSteps, setTotalSteps] = useState(0);
  const [magnify, setMagnify] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const latestSettingsRef = useRef<Settings>(settings);
  latestSettingsRef.current = settings;

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    focusInput();
  }, [focusInput]);

  useEffect(() => {
    let mounted = true;
    let moveSaveTimer: number | null = null;

    getSettings()
      .then((loaded) => {
        if (!mounted) return;
        const merged: Settings = {
          ...loaded,
          ...initialSettings,
        };
        setLocalSettings(merged);
        setMagnify(Boolean(merged.always_magnify));
        if (loaded.onboarding_complete === false && !initialSettings) {
          if (isTauriRuntime()) {
            void openSettingsWindow("/onboarding").then((opened) => {
              if (mounted && !opened) {
                setShowOnboarding(true);
              }
            });
          } else {
            setShowOnboarding(true);
          }
        }
        void restoreBarPosition(merged.bar_position);
      })
      .catch(() => {});

    const unlistenSummon = onBarSummoned(() => {
      if (!mounted) return;
      focusInput();
      if (!initialSettings) {
        getSettings()
          .then((fresh) => {
            if (mounted) {
              setLocalSettings(fresh);
            }
          })
          .catch(() => {});
      }
    });

    const unlistenMoved = onWindowMoved((pos) => {
      if (!mounted) return;
      writeSavedBarPosition(pos);
      if (moveSaveTimer !== null) {
        window.clearTimeout(moveSaveTimer);
      }
      moveSaveTimer = window.setTimeout(() => {
        const nextSettings: Settings = {
          ...latestSettingsRef.current,
          bar_position: pos,
        };
        setLocalSettings(nextSettings);
        void setSettings(nextSettings).catch(() => {});
      }, 300);
    });

    const unlistenStatus = onBrainStatus((st) => {
      if (!mounted) return;
      setBrainStatus(st);
      if (st.state === "done" || st.state === "idle") {
        setLoading(false);
      }
    });

    const unlistenStep = onStepChanged((payload) => {
      if (!mounted) return;
      setLoading(false);
      setError(null);
      setMode(
        payload.mode ??
          (payload.step.terminal_command ? "terminal" : "guide"),
      );
      setStepIndex(payload.index);
      setTotalSteps(payload.total);
      if (typeof payload.magnify === "boolean") {
        setMagnify(payload.magnify);
      }
      setSteps((prev) => {
        const base =
          payload.index === 0 || prev.length > payload.total
            ? prev.slice(0, payload.total)
            : [...prev];
        if (payload.index === 0 && base.length !== payload.total) {
          const fresh: ResolvedStep[] = [];
          fresh[0] = payload.step;
          return fresh;
        }
        base[payload.index] = payload.step;
        return base;
      });
    });

    const unlistenClear = onOverlayCleared(() => {
      if (!mounted) return;
      setLoading(false);
      setError(null);
      setSteps([]);
      setStepIndex(0);
      setTotalSteps(0);
    });

    const unlistenSettings = onSettingsChanged((updated) => {
      if (!mounted || initialSettings) return;
      setLocalSettings(updated);
      setMagnify(Boolean(updated.always_magnify));
    });

    return () => {
      mounted = false;
      if (moveSaveTimer !== null) {
        window.clearTimeout(moveSaveTimer);
      }
      unlistenSummon.then((fn) => fn()).catch(() => {});
      unlistenMoved.then((fn) => fn()).catch(() => {});
      unlistenStatus.then((fn) => fn()).catch(() => {});
      unlistenStep.then((fn) => fn()).catch(() => {});
      unlistenClear.then((fn) => fn()).catch(() => {});
      unlistenSettings.then((fn) => fn()).catch(() => {});
    };
  }, [focusInput, initialSettings]);

  const currentStep: ResolvedStep | null = steps[stepIndex] ?? null;
  const isResponseExpanded =
    loading || Boolean(error) || Boolean(currentStep);

  useEffect(() => {
    if (showSettingsDrawer) {
      void resizeBarWindow(640, 780);
    } else if (showOnboarding) {
      void resizeBarWindow(620, 520);
    } else if (isResponseExpanded) {
      void resizeBarWindow(185, 480);
    } else {
      void resizeBarWindow(52, 480);
    }
  }, [isResponseExpanded, showSettingsDrawer, showOnboarding]);

  const handleCloseResponse = useCallback(async () => {
    setLoading(false);
    setError(null);
    setSteps([]);
    setStepIndex(0);
    setTotalSteps(0);
    try {
      await clearOverlay();
    } catch {
      // Ignore outside Tauri
    }
  }, []);

  const handleNextStep = useCallback(async () => {
    if (steps.length === 0) return;
    const effectiveTotal = totalSteps > 0 ? totalSteps : steps.length;
    if (stepIndex + 1 < effectiveTotal) {
      const nextIdx = stepIndex + 1;
      setStepIndex(nextIdx);
      try {
        const resolved = await nextStep();
        if (resolved) {
          setSteps((prev) => {
            const copy = [...prev];
            copy[nextIdx] = resolved;
            return copy;
          });
        }
      } catch {
        // Local step index already advanced
      }
    } else {
      await handleCloseResponse();
    }
  }, [steps.length, stepIndex, totalSteps, handleCloseResponse]);

  // Global keyboard handler: Escape clears overlay, Tab/Enter advances step when input is not actively submitting new text
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (showSettingsDrawer) {
          setShowSettingsDrawer(false);
          return;
        }
        void handleCloseResponse();
        return;
      }

      if (currentStep && !loading) {
        const trimmedQuery = query.trim();
        const queryUnchanged =
          !trimmedQuery || trimmedQuery === lastSubmittedQuery;
        const activeTag = document.activeElement?.tagName;
        const isInteractiveControl =
          activeTag === "BUTTON" ||
          activeTag === "A" ||
          activeTag === "SELECT" ||
          activeTag === "TEXTAREA" ||
          activeTag === "INPUT";

        if (
          e.key === "Tab" &&
          !e.shiftKey &&
          document.activeElement === inputRef.current &&
          queryUnchanged
        ) {
          e.preventDefault();
          void handleNextStep();
        } else if (e.key === "Enter" && !isInteractiveControl) {
          e.preventDefault();
          void handleNextStep();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    currentStep,
    loading,
    query,
    lastSubmittedQuery,
    showSettingsDrawer,
    handleCloseResponse,
    handleNextStep,
  ]);

  const submitQuery = useCallback(
    async (textToAsk: string, brainOverride?: BrainKind) => {
      const trimmed = textToAsk.trim();
      if (!trimmed) return;
      setLastSubmittedQuery(trimmed);
      setLoading(true);
      setError(null);
      setBrainStatus({
        state: "capturing",
        brain: brainOverride ?? settings.brain_mode,
        message: "Capturing screen & analyzing...",
      });

      try {
        const res = await ask(trimmed, brainOverride);
        setActiveBrain(res.brain);
        setMode(res.plan.mode);
        setSteps(res.resolved_steps);
        setStepIndex(0);
        setTotalSteps(
          res.plan.total_steps || res.resolved_steps.length || 1,
        );
        setLoading(false);
      } catch (err) {
        setLoading(false);
        setError(err as AskError);
      }
    },
    [settings.brain_mode],
  );

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (
      currentStep &&
      !error &&
      (!trimmed || trimmed === lastSubmittedQuery)
    ) {
      void handleNextStep();
      return;
    }
    if (!trimmed) {
      return;
    }
    void submitQuery(trimmed);
  };

  const handleCycleBrain = async () => {
    const currentIdx = BRAIN_CYCLE_ORDER.indexOf(settings.brain_mode);
    const nextMode =
      BRAIN_CYCLE_ORDER[(currentIdx + 1) % BRAIN_CYCLE_ORDER.length];
    const updated: Settings = {
      ...settings,
      brain_mode: nextMode,
    };
    setLocalSettings(updated);
    setActiveBrain(null);
    try {
      await setSettings(updated);
    } catch {
      // Ignore error outside Tauri
    }
  };

  const handleToggleVoice = async (nextVoice: boolean) => {
    const updated: Settings = {
      ...settings,
      voice_enabled: nextVoice,
    };
    setLocalSettings(updated);
    try {
      await setSettings(updated);
    } catch {
      // Ignore error outside Tauri
    }
  };

  const handleVoiceTranscript = useCallback(
    (transcript: string, isFinal: boolean) => {
      setQuery(transcript);
      if (isFinal && transcript.trim()) {
        void submitQuery(transcript);
      }
    },
    [submitQuery],
  );

  const handleToggleMagnify = async (nextMag: boolean) => {
    setMagnify(nextMag);
    try {
      await toggleMagnify(nextMag);
    } catch {
      // Ignore error outside Tauri
    }
  };

  const handleFallback = (fallbackBrain: BrainKind) => {
    const targetQuery = lastSubmittedQuery || query || "Help with active screen";
    void submitQuery(targetQuery, fallbackBrain);
  };

  const handleOpenSettings = async () => {
    const openedWindow = isTauriRuntime()
      ? await openSettingsWindow("/settings")
      : false;
    if (!openedWindow) {
      setShowSettingsDrawer((prev) => !prev);
    }
  };

  const pillLabel = formatBrainPillLabel(settings, activeBrain);
  const barSurfaceClass = settings.high_contrast
    ? "gl-glass-bar-hc"
    : "gl-glass-bar";

  return (
    <div
      data-testid="floating-bar-root"
      className="flex flex-col items-start select-none"
    >
      {/* Compact 480x52 Floating Command Bar */}
      <div
        role="search"
        aria-label="GuideLens Floating Command Bar"
        data-tauri-drag-region
        data-testid="floating-bar"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            void startBarDrag();
          }
        }}
        className={`${barSurfaceClass} w-[480px] h-[52px] rounded-xl px-2.5 flex items-center gap-2 shadow-2xl`}
      >
        {/* Drag Grip */}
        <div
          data-tauri-drag-region
          aria-hidden="true"
          title="Drag bar"
          onMouseDown={() => void startBarDrag()}
          className="flex flex-col gap-0.5 px-1 py-2 cursor-grab active:cursor-grabbing text-[#A1A1AA]/60 hover:text-[#A1A1AA]"
        >
          <span className="w-1 h-1 rounded-full bg-current" />
          <span className="w-1 h-1 rounded-full bg-current" />
          <span className="w-1 h-1 rounded-full bg-current" />
        </div>

        {/* 1. Brain Mode Pill */}
        <button
          type="button"
          onClick={() => void handleCycleBrain()}
          aria-label={`Brain mode: ${pillLabel}. Click to switch brain.`}
          data-testid="brain-mode-pill"
          className="shrink-0 px-2.5 py-1 rounded-full text-[12px] font-semibold bg-[#38BDF8]/15 text-[#38BDF8] border border-[#38BDF8]/35 hover:bg-[#38BDF8]/25 transition-colors focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
        >
          {pillLabel}
        </button>

        {/* 2. Input Field */}
        <form onSubmit={handleFormSubmit} className="flex-1 min-w-0">
          <input
            ref={inputRef}
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask how to do anything or what's on screen..."
            aria-label="Ask how to do anything or what's on screen"
            data-testid="bar-query-input"
            className="w-full bg-transparent text-[13.5px] text-[#F4F4F5] placeholder-[#A1A1AA] focus:outline-none truncate"
          />
        </form>

        {/* 3. Auto Voice Indicator with Mute Toggle */}
        <VoiceIndicator
          voiceEnabled={settings.voice_enabled}
          sttEngine={settings.stt_engine}
          onToggleMute={(next) => void handleToggleVoice(next)}
          onTranscript={handleVoiceTranscript}
        />

        {/* 4. Settings / History Gear Icon */}
        <button
          type="button"
          onClick={() => void handleOpenSettings()}
          aria-label="Open Settings and History"
          data-testid="open-settings-btn"
          title="Settings & Session History"
          className="flex items-center justify-center w-7 h-7 rounded-md text-[#A1A1AA] hover:text-[#F4F4F5] hover:bg-white/5 transition-colors focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
        </button>
      </div>

      {/* Compact Response Block Expanding Downward */}
      <ResponseBlock
        loading={loading}
        brainStatus={brainStatus}
        error={error}
        mode={mode}
        step={currentStep}
        stepIndex={stepIndex}
        totalSteps={totalSteps}
        magnify={magnify}
        highContrast={settings.high_contrast}
        onToggleMagnify={(next) => void handleToggleMagnify(next)}
        onNextStep={() => void handleNextStep()}
        onClose={() => void handleCloseResponse()}
        onFallback={handleFallback}
      />

      {/* First-Run Onboarding Banner / Modal if onboarding_complete is false */}
      {showOnboarding && (
        <div className="mt-2 w-[480px]">
          <OnboardingView
            settings={settings}
            onComplete={(updated) => {
              setLocalSettings(updated);
              setShowOnboarding(false);
            }}
          />
        </div>
      )}

      {/* Inline Settings Drawer Fallback */}
      {showSettingsDrawer && (
        <div className="mt-2 w-[760px] max-w-[95vw]">
          <SettingsView
            initialSettings={settings}
            onSettingsChange={(updated) => setLocalSettings(updated)}
            onClose={() => setShowSettingsDrawer(false)}
          />
        </div>
      )}
    </div>
  );
};
