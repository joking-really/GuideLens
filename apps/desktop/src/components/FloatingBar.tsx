import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  type CompanionEmotion,
  CompanionSprite,
  normalizeCompanionEmotion,
} from "../companions/CompanionSprite";
import { getCompanionPersona } from "../companions/personas";
import {
  ask,
  clearOverlay,
  endLiveSession,
  getLiveSession,
  getSettings,
  isTauriRuntime,
  nextStep,
  onBarSummoned,
  onBrainStatus,
  onLiveSessionEvent,
  onOverlayCleared,
  onScreenDayFrame,
  onSettingsChanged,
  onStepChanged,
  onWindowMoved,
  openSettingsWindow,
  resizeBarWindow,
  restoreBarPosition,
  screendaySetEnabled,
  screendayStatus,
  sendLiveMessage,
  setSettings,
  startBarDrag,
  startLiveSession,
  toggleMagnify,
  writeSavedBarPosition,
} from "../lib/ipc";
import { isValidHighlightTarget } from "../lib/overlayGeometry";
import {
  formatErrorForSpeech,
  formatStepForSpeech,
  matchVoiceCommand,
} from "../lib/speechText";
import { getCopilotVoiceEngine, type TinyVocaState } from "../lib/tinyVocaClient";
import {
  type AskError,
  type BrainKind,
  type BrainMode,
  type BrainStatusPayload,
  clampInstruction,
  DEFAULT_SETTINGS,
  formatBrainPillLabel,
  type LiveSessionState,
  type ResolvedStep,
  type Settings,
  type SettingsTab,
  type StepMode,
} from "../types";
import { OnboardingView } from "./OnboardingView";
import { ResponseBlock } from "./ResponseBlock";
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

function formatLiveStatusLabel(status: LiveSessionState["status"]): string {
  switch (status) {
    case "listening":
      return "Listening";
    case "observing":
      return "Observing screen";
    case "guiding":
      return "Live Guiding";
    case "waiting_settle":
      return "Settling";
    case "paused":
      return "Paused";
    case "completed":
      return "Goal Complete";
    case "idle":
    default:
      return "Standby";
  }
}

export const FloatingBar: React.FC<FloatingBarProps> = ({
  initialSettings,
  showOnboardingInitially = false,
}) => {
  // Singleton ref prevents recreating Web Worker / AudioContext per render
  const voiceEngineRef = useRef<ReturnType<typeof getCopilotVoiceEngine> | null>(
    null,
  );
  if (!voiceEngineRef.current) {
    voiceEngineRef.current = getCopilotVoiceEngine();
  }
  const voiceEngine = voiceEngineRef.current;

  const [settings, setLocalSettings] = useState<Settings>({
    ...DEFAULT_SETTINGS,
    onboarding_complete: !showOnboardingInitially,
    ...initialSettings,
  });
  const [showOnboarding, setShowOnboarding] = useState<boolean>(
    showOnboardingInitially,
  );

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

  const [liveSession, setLiveSession] = useState<LiveSessionState | null>(null);
  const [livePending, setLivePending] = useState(false);
  const [screendayActive, setScreendayActive] = useState<boolean>(
    Boolean(initialSettings?.screenday_enabled ?? DEFAULT_SETTINGS.screenday_enabled),
  );
  const [screendayPulse, setScreendayPulse] = useState(false);

  const [voiceState, setVoiceState] = useState<TinyVocaState>(() =>
    voiceEngine.getState(),
  );

  const inputRef = useRef<HTMLInputElement | null>(null);
  const latestSettingsRef = useRef<Settings>(settings);
  latestSettingsRef.current = settings;

  const liveSessionRef = useRef<LiveSessionState | null>(liveSession);
  liveSessionRef.current = liveSession;

  const lastSpokenKeyRef = useRef<string | null>(null);
  const lastSpokenErrorRef = useRef<string | null>(null);

  const isSpeaking = voiceState.speaking;
  const isLiveActive =
    Boolean(liveSession) &&
    liveSession!.status !== "idle" &&
    liveSession!.status !== "completed";

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    focusInput();
  }, [focusInput]);

  useEffect(() => {
    setVoiceState(voiceEngine.getState());
    const unsubscribe = voiceEngine.subscribe((next) => {
      setVoiceState(next);
    });
    return () => {
      unsubscribe();
      voiceEngine.stop();
    };
  }, [voiceEngine]);

  useEffect(() => {
    if (!settings.tts_enabled) {
      return;
    }
    const warmTimer = window.setTimeout(() => {
      void voiceEngine.load().catch(() => {});
    }, 300);
    return () => window.clearTimeout(warmTimer);
  }, [settings.tts_enabled, voiceEngine]);

  useEffect(() => {
    let mounted = true;
    let moveSaveTimer: number | null = null;
    let pulseTimer: number | null = null;

    getSettings()
      .then((loaded) => {
        if (!mounted) return;
        const merged: Settings = {
          ...loaded,
          ...initialSettings,
        };
        setLocalSettings(merged);
        setMagnify(Boolean(merged.always_magnify));
        setScreendayActive(Boolean(merged.screenday_enabled));
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

    getLiveSession()
      .then((sess) => {
        if (mounted && sess.session_id && sess.status !== "idle") {
          setLiveSession(sess);
        }
      })
      .catch(() => {});

    screendayStatus()
      .then((sd) => {
        if (mounted && !initialSettings?.screenday_enabled) {
          setScreendayActive(Boolean(sd.enabled));
        }
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
              setScreendayActive(Boolean(fresh.screenday_enabled));
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

    const unlistenLive = onLiveSessionEvent((sess) => {
      if (!mounted) return;
      setLiveSession(sess);
      setLivePending(false);
      if (sess.current_step) {
        setLoading(false);
        setError(null);
        setMode(sess.current_step.terminal_command ? "terminal" : "guide");
        setSteps([sess.current_step]);
        setStepIndex(0);
        setTotalSteps(Math.max(1, sess.turn_count || 1));
      } else if (sess.status === "idle") {
        setSteps([]);
        setStepIndex(0);
        setTotalSteps(0);
      }
    });

    const unlistenFrame = onScreenDayFrame(() => {
      if (!mounted) return;
      setScreendayActive(true);
      setScreendayPulse(true);
      if (pulseTimer !== null) {
        window.clearTimeout(pulseTimer);
      }
      pulseTimer = window.setTimeout(() => {
        if (mounted) setScreendayPulse(false);
      }, 1200);
    });

    const unlistenClear = onOverlayCleared(() => {
      if (!mounted) return;
      voiceEngine.stop();
      lastSpokenKeyRef.current = null;
      lastSpokenErrorRef.current = null;
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
      setScreendayActive(Boolean(updated.screenday_enabled));
      if (!updated.tts_enabled) {
        voiceEngine.stop();
      }
    });

    return () => {
      mounted = false;
      if (moveSaveTimer !== null) {
        window.clearTimeout(moveSaveTimer);
      }
      if (pulseTimer !== null) {
        window.clearTimeout(pulseTimer);
      }
      unlistenSummon.then((fn) => fn()).catch(() => {});
      unlistenMoved.then((fn) => fn()).catch(() => {});
      unlistenStatus.then((fn) => fn()).catch(() => {});
      unlistenStep.then((fn) => fn()).catch(() => {});
      unlistenLive.then((fn) => fn()).catch(() => {});
      unlistenFrame.then((fn) => fn()).catch(() => {});
      unlistenClear.then((fn) => fn()).catch(() => {});
      unlistenSettings.then((fn) => fn()).catch(() => {});
    };
  }, [focusInput, initialSettings, voiceEngine]);

  const currentStep: ResolvedStep | null = steps[stepIndex] ?? null;
  const hasLiveStrip =
    Boolean(liveSession) &&
    liveSession!.status !== "idle" &&
    !loading &&
    !error &&
    !currentStep;
  const isResponseExpanded =
    loading || Boolean(error) || Boolean(currentStep) || hasLiveStrip;

  useEffect(() => {
    if (showOnboarding) {
      void resizeBarWindow(620, 620);
    } else if (isResponseExpanded) {
      void resizeBarWindow(210, 620);
    } else {
      void resizeBarWindow(54, 620);
    }
  }, [isResponseExpanded, showOnboarding]);

  const speakCue = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const active = latestSettingsRef.current;
      voiceEngine.stop();
      void voiceEngine
        .speak(trimmed, {
          voice: active.tts_voice,
          speed: active.tts_speed,
          pitchShift: active.tts_pitch_shift,
        })
        .catch(() => {});
    },
    [voiceEngine],
  );

  const speakStep = useCallback(
    (
      step: ResolvedStep,
      idx: number,
      total: number,
      stepMode: StepMode,
    ) => {
      const displayTotal = Math.max(total, idx + 1);
      const cue = formatStepForSpeech(step, {
        mode: stepMode,
        index: idx,
        total: displayTotal,
        hasHighlight: isValidHighlightTarget(step),
      });
      speakCue(cue);
    },
    [speakCue],
  );

  // Deduplicated conversational TTS when a step arrives or advances
  const currentStepKey = currentStep
    ? `${stepIndex}:${Math.max(totalSteps, stepIndex + 1)}:${currentStep.instruction_line}:${currentStep.spoken_text ?? ""}`
    : null;

  useEffect(() => {
    if (loading || !currentStep || !currentStepKey) {
      return;
    }
    const active = latestSettingsRef.current;
    if (!active.tts_enabled || !active.tts_auto_speak) {
      return;
    }
    if (lastSpokenKeyRef.current === currentStepKey) {
      return;
    }
    lastSpokenKeyRef.current = currentStepKey;
    speakStep(currentStep, stepIndex, totalSteps, mode);
  }, [
    loading,
    currentStep,
    currentStepKey,
    stepIndex,
    totalSteps,
    mode,
    speakStep,
  ]);

  // Speak concise error cues when TTS auto-speak is active
  useEffect(() => {
    if (loading || !error) {
      return;
    }
    const active = latestSettingsRef.current;
    if (!active.tts_enabled || !active.tts_auto_speak) {
      return;
    }
    const errKey = `${error.code}:${error.brain ?? ""}:${error.message}`;
    if (lastSpokenErrorRef.current === errKey) {
      return;
    }
    lastSpokenErrorRef.current = errKey;
    speakCue(formatErrorForSpeech(error));
  }, [loading, error, speakCue]);

  const handleCloseResponse = useCallback(async () => {
    voiceEngine.stop();
    lastSpokenKeyRef.current = null;
    lastSpokenErrorRef.current = null;
    setLoading(false);
    setError(null);
    setSteps([]);
    setStepIndex(0);
    setTotalSteps(0);
    if (liveSessionRef.current && liveSessionRef.current.status !== "idle") {
      try {
        const ended = await endLiveSession(liveSessionRef.current.session_id);
        setLiveSession(ended.status === "completed" ? null : ended);
      } catch {
        setLiveSession(null);
      }
    }
    try {
      await clearOverlay();
    } catch {
      // Ignore outside Tauri
    }
  }, [voiceEngine]);

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

  // Global keyboard handler: Escape clears overlay, Tab/Enter advances step when query unchanged
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
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
    handleCloseResponse,
    handleNextStep,
  ]);

  const submitQuery = useCallback(
    async (textToAsk: string, brainOverride?: BrainKind) => {
      const trimmed = textToAsk.trim();
      if (!trimmed) return;
      voiceEngine.stop();
      lastSpokenKeyRef.current = null;
      lastSpokenErrorRef.current = null;
      setLastSubmittedQuery(trimmed);
      setError(null);

      // Route follow-ups directly through the active Live Session when a call is open
      const activeLive = liveSessionRef.current;
      if (
        !brainOverride &&
        activeLive &&
        activeLive.status !== "idle" &&
        activeLive.status !== "completed"
      ) {
        setLivePending(true);
        try {
          const nextState = await sendLiveMessage(
            trimmed,
            activeLive.session_id,
          );
          setLiveSession(nextState);
          if (nextState.current_step) {
            setMode(
              nextState.current_step.terminal_command ? "terminal" : "guide",
            );
            setSteps([nextState.current_step]);
            setStepIndex(0);
            setTotalSteps(Math.max(1, nextState.turn_count || 1));
          }
        } catch (err) {
          setError(err as AskError);
        } finally {
          setLivePending(false);
        }
        return;
      }

      setLoading(true);
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
    [settings.brain_mode, voiceEngine],
  );

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (
      currentStep &&
      !error &&
      !isLiveActive &&
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
      // Ignore outside Tauri
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
      // Ignore outside Tauri
    }
  };

  const handleToggleTts = async () => {
    if (isSpeaking || settings.tts_enabled) {
      voiceEngine.stop();
    }
    const nextEnabled = !settings.tts_enabled;
    const updated: Settings = {
      ...latestSettingsRef.current,
      tts_enabled: nextEnabled,
    };
    setLocalSettings(updated);
    if (nextEnabled) {
      void voiceEngine.load().catch(() => {});
    }
    try {
      await setSettings(updated);
    } catch {
      // Ignore outside Tauri
    }
  };

  const handleMuteTts = useCallback(async () => {
    voiceEngine.stop();
    const updated: Settings = {
      ...latestSettingsRef.current,
      tts_enabled: false,
    };
    setLocalSettings(updated);
    try {
      await setSettings(updated);
    } catch {
      // Ignore outside Tauri
    }
  }, [voiceEngine]);

  const handleToggleMagnify = useCallback(async (nextMag: boolean) => {
    setMagnify(nextMag);
    try {
      await toggleMagnify(nextMag);
    } catch {
      // Ignore outside Tauri
    }
  }, []);

  const handleToggleLiveCall = async () => {
    if (livePending) return;
    setLivePending(true);
    setError(null);

    try {
      if (isLiveActive && liveSession) {
        voiceEngine.stop();
        const ended = await endLiveSession(liveSession.session_id);
        setLiveSession(ended.status === "completed" ? ended : null);
        setSteps([]);
        setStepIndex(0);
        setTotalSteps(0);
        await clearOverlay().catch(() => {});
      } else {
        const goal = query.trim() || "Guide me step by step on this screen";
        const started = await startLiveSession(goal);
        setLiveSession(started);
        if (started.current_step) {
          setMode(
            started.current_step.terminal_command ? "terminal" : "guide",
          );
          setSteps([started.current_step]);
          setStepIndex(0);
          setTotalSteps(Math.max(1, started.turn_count || 1));
        }
      }
    } catch (err) {
      setError(err as AskError);
    } finally {
      setLivePending(false);
    }
  };

  const handleToggleScreenday = async () => {
    const nextEnabled = !screendayActive;
    setScreendayActive(nextEnabled);
    const updated: Settings = {
      ...latestSettingsRef.current,
      screenday_enabled: nextEnabled,
    };
    setLocalSettings(updated);
    try {
      const res = await screendaySetEnabled(nextEnabled);
      setScreendayActive(Boolean(res.enabled));
    } catch {
      // Fallback to settings persistence outside Tauri
    }
    try {
      await setSettings(updated);
    } catch {
      // Ignore outside Tauri
    }
  };

  const handleVoiceTranscript = useCallback(
    (transcript: string, isFinal: boolean) => {
      if (!isFinal) {
        setQuery(transcript);
        return;
      }

      const trimmed = transcript.trim();
      if (!trimmed) {
        return;
      }

      const command = matchVoiceCommand(trimmed, Boolean(currentStep));
      if (command) {
        setQuery("");
        switch (command) {
          case "next_step":
            void handleNextStep();
            break;
          case "repeat":
            if (currentStep) {
              speakStep(currentStep, stepIndex, totalSteps, mode);
            }
            break;
          case "magnify_on":
            void handleToggleMagnify(true);
            break;
          case "magnify_off":
            void handleToggleMagnify(false);
            break;
          case "stop_clear":
            void handleCloseResponse();
            break;
          case "mute_tts":
            void handleMuteTts();
            break;
        }
        return;
      }

      setQuery(trimmed);
      voiceEngine.stop();
      void submitQuery(trimmed);
    },
    [
      currentStep,
      stepIndex,
      totalSteps,
      mode,
      handleNextStep,
      speakStep,
      handleToggleMagnify,
      handleCloseResponse,
      handleMuteTts,
      voiceEngine,
      submitQuery,
    ],
  );

  const handleFallback = (fallbackBrain: BrainKind) => {
    const targetQuery =
      lastSubmittedQuery || query || "Help with active screen";
    void submitQuery(targetQuery, fallbackBrain);
  };

  const handleOpenControlCenter = async (tab: SettingsTab = "overview") => {
    await openSettingsWindow("/settings", tab);
  };

  const pillLabel = formatBrainPillLabel(settings, activeBrain);
  const companionMeta = getCompanionPersona(settings.companion_id);

  const deriveCompanionEmotion = (): CompanionEmotion => {
    if (loading || livePending || liveSession?.status === "observing") {
      return "thinking";
    }
    if (currentStep?.goal_complete || liveSession?.status === "completed") {
      return "celebrate";
    }
    if (currentStep?.companion_emotion) {
      return normalizeCompanionEmotion(
        currentStep.companion_emotion,
        currentStep.action_kind,
      );
    }
    if (isSpeaking) return "celebrate";
    if (isLiveActive) return "curious";
    if (screendayActive) return "peeking";
    return "idle";
  };

  const companionEmotion = deriveCompanionEmotion();

  const barSurfaceClass = settings.high_contrast
    ? "bg-[#09090B]/95 backdrop-blur-2xl border-2 border-[#FACC15]"
    : "bg-[#080A0F]/90 backdrop-blur-2xl border border-white/15";

  const latestTurn =
    liveSession && liveSession.turns.length > 0
      ? liveSession.turns[liveSession.turns.length - 1]
      : null;
  const whisperText = clampInstruction(
    latestTurn?.spoken_text ??
      currentStep?.spoken_text ??
      (isLiveActive ? liveSession?.goal : null),
  );

  return (
    <div
      data-testid="floating-bar-root"
      className="flex flex-col items-start select-none"
    >
      {/* Sleek Live Session & Companion Obsidian Capsule */}
      <div
        role="search"
        aria-label="GuideLens Live Companion Capsule"
        data-tauri-drag-region
        data-testid="floating-bar"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            void startBarDrag();
          }
        }}
        className={`${barSurfaceClass} w-[620px] max-w-[96vw] h-[54px] rounded-full px-2.5 flex items-center gap-1.5 shadow-[0_20px_50px_rgba(0,0,0,0.68)]`}
      >
        {/* Drag Grip */}
        <div
          data-tauri-drag-region
          aria-hidden="true"
          title="Drag capsule"
          onMouseDown={() => void startBarDrag()}
          className="flex flex-col gap-0.5 pl-1 pr-0.5 py-2 cursor-grab active:cursor-grabbing text-[#A1A1AA]/55 hover:text-[#A1A1AA]"
        >
          <span className="w-1 h-1 rounded-full bg-current" />
          <span className="w-1 h-1 rounded-full bg-current" />
          <span className="w-1 h-1 rounded-full bg-current" />
        </div>

        {/* 1. Mini Live Companion Badge */}
        <button
          type="button"
          onClick={() => void handleOpenControlCenter("companions")}
          title={`${companionMeta.name} (${companionEmotion}) — open Companion Studio`}
          aria-label={`Companion ${companionMeta.name}. Open Companion Studio.`}
          data-testid="capsule-companion-badge"
          className="shrink-0 relative flex items-center justify-center w-9 h-9 rounded-full bg-white/[0.04] border border-white/10 hover:border-[#38BDF8]/50 transition-colors focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
        >
          {settings.companion_id === "none" ? (
            <span className="w-3 h-3 rounded-full bg-slate-500/70 ring-2 ring-slate-400/20" />
          ) : (
            <CompanionSprite
              companionId={settings.companion_id}
              emotion={companionEmotion}
              size={28}
            />
          )}
        </button>

        {/* 2. Brain Mode Pill */}
        <button
          type="button"
          onClick={() => void handleCycleBrain()}
          aria-label={`Brain mode: ${pillLabel}. Click to switch brain.`}
          data-testid="brain-mode-pill"
          className="shrink-0 px-2.5 py-1 rounded-full text-[11.5px] font-semibold bg-[#38BDF8]/15 text-[#38BDF8] border border-[#38BDF8]/35 hover:bg-[#38BDF8]/25 transition-colors focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
        >
          {pillLabel}
        </button>

        {/* 3. Quick-Ask Composer / Live Turn Input */}
        <form onSubmit={handleFormSubmit} className="flex-1 min-w-[110px]">
          <input
            ref={inputRef}
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              isLiveActive
                ? "Follow up in live session..."
                : "Ask GuideLens anything on screen..."
            }
            aria-label="Ask how to do anything or what's on screen"
            data-testid="bar-query-input"
            className="w-full bg-transparent px-1 text-[13px] text-[#F4F4F5] placeholder-[#94A3B8] focus:outline-none truncate"
          />
        </form>

        {/* 4. Live Mic Waveform & Voice Toggle */}
        <VoiceIndicator
          voiceEnabled={settings.voice_enabled}
          sttEngine={settings.stt_engine}
          pausedForTts={settings.voice_conversation_mode && isSpeaking}
          speaking={isSpeaking}
          onToggleMute={(next) => void handleToggleVoice(next)}
          onTranscript={handleVoiceTranscript}
        />

        {/* 5. Live Call Toggle */}
        <button
          type="button"
          onClick={() => void handleToggleLiveCall()}
          disabled={livePending}
          aria-pressed={isLiveActive}
          aria-label={isLiveActive ? "End live guidance call" : "Start live guidance call"}
          title={
            isLiveActive
              ? "End live continuous guidance session"
              : "Start continuous live screen-guiding session"
          }
          data-testid="live-call-toggle"
          className={`shrink-0 flex items-center gap-1.5 h-8 px-2.5 rounded-full text-[11.5px] font-semibold border transition-all focus:outline-none focus:ring-1 focus:ring-[#38BDF8] ${
            isLiveActive
              ? "bg-emerald-500/20 text-emerald-300 border-emerald-400/45 hover:bg-rose-500/20 hover:text-rose-300 hover:border-rose-400/45"
              : "bg-white/[0.05] text-[#E4E4E7] border-white/10 hover:bg-[#38BDF8]/15 hover:text-[#38BDF8] hover:border-[#38BDF8]/40"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              livePending
                ? "bg-amber-400 animate-ping"
                : isLiveActive
                  ? "bg-emerald-400 animate-pulse"
                  : "bg-emerald-400/75"
            }`}
            aria-hidden="true"
          />
          <span>{isLiveActive ? "End Call" : "Live Call"}</span>
        </button>

        {/* 6. Screen Day Live Dot Toggle */}
        <button
          type="button"
          onClick={() => void handleToggleScreenday()}
          aria-pressed={screendayActive}
          aria-label={
            screendayActive
              ? "Pause Screen Day visual diary"
              : "Record My Day with Screen Day"
          }
          title={
            screendayActive
              ? "Screen Day recording active (click to pause)"
              : "Record My Day (Screen Day) off (click to enable)"
          }
          data-testid="screenday-toggle"
          className={`shrink-0 flex items-center gap-1.5 h-8 px-2.5 rounded-full text-[11.5px] font-semibold border transition-colors focus:outline-none focus:ring-1 focus:ring-[#38BDF8] ${
            screendayActive
              ? "bg-rose-500/15 text-rose-200 border-rose-500/40 hover:bg-rose-500/25"
              : "bg-white/[0.04] text-[#A1A1AA] border-white/10 hover:text-[#F4F4F5] hover:bg-white/10"
          }`}
        >
          <span
            data-testid="screenday-live-dot"
            className={`w-2 h-2 rounded-full ${
              screendayPulse
                ? "bg-rose-300 scale-125"
                : screendayActive
                  ? "bg-rose-400 animate-pulse"
                  : "bg-zinc-500"
            }`}
            aria-hidden="true"
          />
          <span>Day</span>
        </button>

        {/* 7. Speaker TTS Mute Toggle */}
        <button
          type="button"
          onClick={() => void handleToggleTts()}
          onContextMenu={(e) => {
            e.preventDefault();
            void handleOpenControlCenter("companions");
          }}
          aria-label={
            settings.tts_enabled
              ? "Mute spoken guidance"
              : "Enable spoken guidance"
          }
          aria-pressed={settings.tts_enabled}
          title={
            isSpeaking
              ? "Speaking — click to stop & mute"
              : settings.tts_enabled
                ? "Voice guidance on (click to mute)"
                : "Voice guidance muted (click to enable)"
          }
          data-testid="tts-mute-toggle"
          className={`relative shrink-0 flex items-center justify-center w-8 h-8 rounded-full border transition-colors focus:outline-none focus:ring-1 focus:ring-[#38BDF8] ${
            settings.tts_enabled
              ? "text-[#38BDF8] bg-[#38BDF8]/15 border-[#38BDF8]/35 hover:bg-[#38BDF8]/25"
              : "text-[#A1A1AA] bg-white/[0.04] border-white/10 hover:text-[#F4F4F5] hover:bg-white/10"
          }`}
        >
          {isSpeaking && (
            <span
              data-testid="tts-speaking-pulse"
              className="absolute inset-0 rounded-full ring-1 ring-[#38BDF8]/70 animate-ping pointer-events-none"
            />
          )}
          {settings.tts_enabled ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <line x1="22" x2="16" y1="9" y2="15" />
              <line x1="16" x2="22" y1="9" y2="15" />
            </svg>
          )}
        </button>

        {/* 8. Control Center Window Button */}
        <button
          type="button"
          onClick={() => void handleOpenControlCenter("overview")}
          aria-label="Open Control Center"
          data-testid="open-settings-btn"
          title="Open GuideLens Control Center"
          className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-full text-[11.5px] font-semibold bg-white/[0.08] text-[#F4F4F5] border border-white/15 hover:bg-white/15 hover:border-[#38BDF8]/40 transition-colors focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
          <span>Control Center</span>
        </button>
      </div>

      {/* Live Turn Status + Spoken Whisper Strip when Live Session has no active ResponseBlock */}
      {hasLiveStrip && liveSession && (
        <div
          data-testid="live-session-strip"
          className={`${barSurfaceClass} mt-2 w-[620px] max-w-[96vw] rounded-2xl px-4 py-2.5 flex items-center justify-between gap-3 text-[#F4F4F5] shadow-[0_18px_48px_rgba(0,0,0,0.65)]`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-400/35 text-[11px] font-semibold text-emerald-300">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {formatLiveStatusLabel(liveSession.status)}
              {liveSession.turn_count > 0
                ? ` · Turn ${liveSession.turn_count}`
                : ""}
            </span>
            {whisperText && (
              <span
                data-testid="live-whisper-text"
                className="text-[12.5px] text-[#E4E4E7] truncate"
              >
                {whisperText}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleCloseResponse()}
            className="shrink-0 px-2.5 py-0.5 rounded-full text-[11.5px] bg-white/5 border border-white/10 text-[#A1A1AA] hover:text-[#F4F4F5] hover:bg-white/10"
          >
            Dismiss
          </button>
        </div>
      )}

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
        ttsEnabled={settings.tts_enabled}
        isSpeaking={isSpeaking}
        liveTurnLabel={
          isLiveActive && liveSession
            ? `Live · Turn ${Math.max(1, liveSession.turn_count || stepIndex + 1)}`
            : null
        }
        onReplaySpeech={() => {
          if (currentStep) {
            speakStep(currentStep, stepIndex, totalSteps, mode);
          }
        }}
        onStopSpeech={() => voiceEngine.stop()}
        onOpenVoiceStudio={() => void handleOpenControlCenter("companions")}
        onToggleMagnify={(next) => void handleToggleMagnify(next)}
        onNextStep={() => void handleNextStep()}
        onClose={() => void handleCloseResponse()}
        onFallback={handleFallback}
      />

      {/* First-Run Onboarding Banner / Modal if onboarding_complete is false */}
      {showOnboarding && (
        <div className="mt-2 w-[620px] max-w-[96vw]">
          <OnboardingView
            settings={settings}
            onComplete={(updated) => {
              setLocalSettings(updated);
              setShowOnboarding(false);
            }}
          />
        </div>
      )}
    </div>
  );
};
