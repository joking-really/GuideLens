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
  getDefaultOptions,
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
  onShortcutAction,
  onStepChanged,
  onWindowMoved,
  openSettingsWindow,
  reportGuidanceFeedback,
  resizeBarWindow,
  restoreBarPosition,
  runPlaybook,
  saveBarPosition,
  screendaySetEnabled,
  screendayStatus,
  sendLiveMessage,
  setBarGlass,
  setSettings,
  startBarDrag,
  startLiveSession,
  toggleBarOnly,
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
  type CompiledPlaybookDto,
  DEFAULT_SETTINGS,
  type LiveSessionState,
  type ResolvedStep,
  type Settings,
  type SettingsTab,
  type StepMode,
} from "../types";
import { OnboardingView } from "./OnboardingView";
import { ResponseBlock } from "./ResponseBlock";
import { VoiceIndicator } from "./VoiceIndicator";

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
      return "Live guiding";
    case "waiting_settle":
      return "Settling";
    case "paused":
      return "Paused";
    case "completed":
      return "Goal complete";
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

  const [mode, setMode] = useState<StepMode>("guide");
  const [steps, setSteps] = useState<ResolvedStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [totalSteps, setTotalSteps] = useState(0);
  const [magnify, setMagnify] = useState(false);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [resolutionTier, setResolutionTier] = useState<string | null>(null);
  const [tokensSaved, setTokensSaved] = useState<number | null>(null);
  const [activePlaybookId, setActivePlaybookId] = useState<string | null>(null);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState<
    "worked" | "wrong" | null
  >(null);
  const [defaultOptions, setDefaultOptions] = useState<CompiledPlaybookDto[]>(
    [],
  );

  const [liveSession, setLiveSession] = useState<LiveSessionState | null>(null);
  const [livePending, setLivePending] = useState(false);
  const [screendayActive, setScreendayActive] = useState<boolean>(
    Boolean(
      initialSettings?.screenday_enabled ?? DEFAULT_SETTINGS.screenday_enabled,
    ),
  );
  const [screendayPulse, setScreendayPulse] = useState(false);

  const [voiceState, setVoiceState] = useState<TinyVocaState>(() =>
    voiceEngine.getState(),
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const latestSettingsRef = useRef<Settings>(settings);
  latestSettingsRef.current = settings;

  const liveSessionRef = useRef<LiveSessionState | null>(liveSession);
  liveSessionRef.current = liveSession;

  const lastSpokenKeyRef = useRef<string | null>(null);
  const lastSpokenErrorRef = useRef<string | null>(null);
  const lastWindowSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  const isSpeaking = voiceState.speaking;
  const isLiveActive =
    Boolean(liveSession) &&
    liveSession!.status !== "idle" &&
    liveSession!.status !== "completed";

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const refreshDefaultOptions = useCallback(async () => {
    try {
      const res = await getDefaultOptions(null, 4);
      setDefaultOptions(res.options.slice(0, 4));
    } catch {
      // Ignore outside Tauri or transient DB errors
    }
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

  // Sync Windows 10/11 Acrylic frosted glass attributes whenever glass settings change
  useEffect(() => {
    void setBarGlass(
      settings.bar_opacity,
      settings.bar_blur_enabled,
      settings.high_contrast,
    ).catch(() => {});
  }, [settings.bar_opacity, settings.bar_blur_enabled, settings.high_contrast]);

  // Dynamic ResizeObserver auto-sizing so bar height never clips response/pills
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    let rafId: number | null = null;
    const syncWindowSize = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const rect = el.getBoundingClientRect();
        const measured = rect.height > 0 ? rect.height : el.scrollHeight;
        const nextH = Math.max(54, Math.ceil(measured || 54));
        const nextW = 640;
        if (
          lastWindowSizeRef.current.h !== nextH ||
          lastWindowSizeRef.current.w !== nextW
        ) {
          lastWindowSizeRef.current = { w: nextW, h: nextH };
          void resizeBarWindow(nextH, nextW);
        }
      });
    };

    const observer = new ResizeObserver(() => {
      syncWindowSize();
    });
    observer.observe(el);
    syncWindowSize();

    return () => {
      observer.disconnect();
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

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

    void refreshDefaultOptions();

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
      void refreshDefaultOptions();
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
        // Persist position directly to SQLite without setSettings/settings-changed to prevent drag jitter
        latestSettingsRef.current = {
          ...latestSettingsRef.current,
          bar_position: pos,
        };
        void saveBarPosition(pos.x, pos.y).catch(() => {});
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
      } else if (sess.status === "idle" || sess.status === "completed") {
        if (sess.status === "idle") {
          setSteps([]);
          setStepIndex(0);
          setTotalSteps(0);
        }
        void refreshDefaultOptions();
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
      setActiveSessionId(null);
      setResolutionTier(null);
      setTokensSaved(null);
      setActivePlaybookId(null);
      setFeedbackSubmitted(null);
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

    const unlistenShortcut = onShortcutAction((ev) => {
      if (!mounted) return;
      switch (ev.action) {
        case "toggle_mic":
          setLocalSettings((prev) => ({ ...prev, voice_enabled: ev.active }));
          break;
        case "toggle_day":
          setScreendayActive(ev.active);
          setLocalSettings((prev) => ({ ...prev, screenday_enabled: ev.active }));
          break;
        case "use_local":
          setLocalSettings((prev) => ({ ...prev, brain_mode: "local_vlm" }));
          break;
        case "use_agent":
          setLocalSettings((prev) => ({ ...prev, brain_mode: "agent_cli" }));
          break;
        case "toggle_live":
          if (!ev.active) {
            voiceEngine.stop();
          }
          void getLiveSession()
            .then((sess) => {
              if (mounted) {
                setLiveSession(
                  sess.session_id && sess.status !== "idle" ? sess : null,
                );
              }
            })
            .catch(() => {});
          break;
        case "toggle_bar_only":
          if (!ev.active) {
            focusInput();
          }
          break;
        default:
          break;
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
      unlistenShortcut.then((fn) => fn()).catch(() => {});
    };
  }, [focusInput, initialSettings, refreshDefaultOptions, voiceEngine]);

  const currentStep: ResolvedStep | null = steps[stepIndex] ?? null;

  const latestTurn =
    liveSession && liveSession.turns.length > 0
      ? liveSession.turns[liveSession.turns.length - 1]
      : null;
  const liveStatusLine =
    liveSession &&
    liveSession.status !== "idle" &&
    !loading &&
    !error &&
    !currentStep
      ? (() => {
          const base = formatLiveStatusLabel(liveSession.status);
          const turnPart =
            liveSession.turn_count > 0 ? ` · Turn ${liveSession.turn_count}` : "";
          const whisper = clampInstruction(
            latestTurn?.spoken_text ??
              (isLiveActive ? liveSession.goal : null),
          );
          return whisper ? `${base}${turnPart} — ${whisper}` : `${base}${turnPart}`;
        })()
      : null;

  const isResponseExpanded =
    loading || Boolean(error) || Boolean(currentStep) || Boolean(liveStatusLine);

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
    setActiveSessionId(null);
    setResolutionTier(null);
    setTokensSaved(null);
    setActivePlaybookId(null);
    setFeedbackSubmitted(null);
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
    void refreshDefaultOptions();
  }, [refreshDefaultOptions, voiceEngine]);

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
    async (textToAsk: string, brainOverride?: BrainKind, forceAi?: boolean) => {
      const trimmed = textToAsk.trim();
      if (!trimmed) return;
      voiceEngine.stop();
      lastSpokenKeyRef.current = null;
      lastSpokenErrorRef.current = null;
      setLastSubmittedQuery(trimmed);
      setError(null);
      setFeedbackSubmitted(null);
      setActiveSessionId(null);
      setResolutionTier(null);
      setTokensSaved(null);
      setActivePlaybookId(null);

      // Route follow-ups directly through the active Live Session when a call is open
      const activeLive = liveSessionRef.current;
      if (
        !brainOverride &&
        !forceAi &&
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
        message: forceAi
          ? "Re-asking AI with live screen capture..."
          : "Checking learned playbooks & screen...",
      });

      try {
        const res = await ask(trimmed, brainOverride, forceAi);
        setMode(res.plan.mode);
        setSteps(res.resolved_steps);
        setStepIndex(0);
        setTotalSteps(
          res.plan.total_steps || res.resolved_steps.length || 1,
        );
        setActiveSessionId(res.session_id);
        setResolutionTier(res.resolution_tier ?? null);
        setTokensSaved(res.tokens_saved ?? null);
        setActivePlaybookId(res.playbook_id ?? null);
        setLoading(false);
      } catch (err) {
        setLoading(false);
        setError(err as AskError);
      }
    },
    [settings.brain_mode, voiceEngine],
  );

  const handleRunPlaybook = useCallback(
    async (opt: CompiledPlaybookDto, forceAi = false) => {
      voiceEngine.stop();
      lastSpokenKeyRef.current = null;
      lastSpokenErrorRef.current = null;
      setLastSubmittedQuery(opt.canonical_goal);
      setQuery(opt.canonical_goal);
      setError(null);
      setFeedbackSubmitted(null);
      setLoading(true);
      setBrainStatus({
        state: "locating",
        brain: settings.brain_mode,
        message: forceAi
          ? "Re-asking AI for fresh guidance..."
          : `Running learned playbook: ${opt.display_label || opt.canonical_goal}...`,
      });
      try {
        const res = await runPlaybook(opt.id, forceAi);
        setMode(res.plan.mode);
        setSteps(res.resolved_steps);
        setStepIndex(0);
        setTotalSteps(
          res.plan.total_steps || res.resolved_steps.length || 1,
        );
        setActiveSessionId(res.session_id);
        setResolutionTier(res.resolution_tier ?? "tier0_playbook");
        setTokensSaved(res.tokens_saved ?? 1800);
        setActivePlaybookId(res.playbook_id ?? opt.id);
        setLoading(false);
      } catch (err) {
        setLoading(false);
        setError(err as AskError);
      }
    },
    [settings.brain_mode, voiceEngine],
  );

  const handleReAskAi = useCallback(() => {
    const targetQuery =
      lastSubmittedQuery || query.trim() || "Help with active screen";
    void submitQuery(targetQuery, undefined, true);
  }, [lastSubmittedQuery, query, submitQuery]);

  const handleFeedback = useCallback(
    async (worked: boolean) => {
      setFeedbackSubmitted(worked ? "worked" : "wrong");
      try {
        await reportGuidanceFeedback(
          activeSessionId ?? "session-local",
          activePlaybookId,
          worked,
        );
        await refreshDefaultOptions();
      } catch {
        // Ignore outside Tauri
      }
    },
    [activePlaybookId, activeSessionId, refreshDefaultOptions],
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
        void refreshDefaultOptions();
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

  const handleSelectBrainMode = useCallback(async (nextMode: BrainMode) => {
    const updated: Settings = {
      ...latestSettingsRef.current,
      brain_mode: nextMode,
    };
    setLocalSettings(updated);
    try {
      await setSettings(updated);
    } catch {
      // Ignore outside Tauri
    }
  }, []);

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

  // Compute smoked-obsidian translucent alpha so bright windows blur through while keeping >=4.5:1 text contrast
  const rawOpacity = Number.isFinite(settings.bar_opacity)
    ? Math.min(0.85, Math.max(0.12, settings.bar_opacity))
    : DEFAULT_SETTINGS.bar_opacity;
  const surfaceAlpha = settings.high_contrast
    ? 0.92
    : settings.bar_blur_enabled
      ? Math.min(0.68, Math.max(0.42, Number((rawOpacity * 1.45).toFixed(3))))
      : Math.max(0.55, rawOpacity);

  const sheetClass = settings.high_contrast
    ? "w-full rounded-xl backdrop-blur-xl border-2 border-[#FACC15] shadow-[0_12px_32px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.16)] overflow-hidden"
    : "w-full rounded-xl backdrop-blur-xl border border-white/[0.20] shadow-[0_12px_32px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.16)] overflow-hidden transition-colors";

  const sheetStyle: React.CSSProperties = {
    backgroundColor: settings.high_contrast
      ? "rgba(9, 9, 11, 0.92)"
      : `rgba(14, 16, 22, ${surfaceAlpha})`,
  };

  const isLocalMode = settings.brain_mode === "local_vlm";
  const isAgentMode =
    settings.brain_mode === "agent_cli" || settings.brain_mode === "agent_mcp";
  const isAutoMode = settings.brain_mode === "auto";

  return (
    <div
      ref={rootRef}
      data-testid="floating-bar-root"
      className="w-full flex flex-col items-stretch select-none"
    >
      {/* Unified Windows Acrylic Frosted Glass Sheet */}
      <div
        data-testid="floating-glass-sheet"
        style={sheetStyle}
        className={sheetClass}
      >
        <div
          role="search"
          aria-label="GuideLens Companion Capsule"
          data-tauri-drag-region
          data-testid="floating-bar"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              void startBarDrag();
            }
          }}
          className="w-full h-[54px] px-2.5 flex items-center gap-1 gl-glass-text"
        >
          {/* Drag Grip */}
          <div
            data-tauri-drag-region
            aria-hidden="true"
            title="Drag capsule"
            onMouseDown={() => void startBarDrag()}
            className="flex flex-col gap-0.5 pl-1 pr-0.5 py-2 cursor-grab active:cursor-grabbing text-white/65 hover:text-white transition-colors"
          >
            <span className="w-1 h-1 rounded-full bg-current" />
            <span className="w-1 h-1 rounded-full bg-current" />
            <span className="w-1 h-1 rounded-full bg-current" />
          </div>

          {/* 1. Companion Icon Button */}
          <button
            type="button"
            onClick={() => void handleOpenControlCenter("companions")}
            title={`${companionMeta.name} (${companionEmotion}) — open Companion Studio`}
            aria-label={`Companion ${companionMeta.name}. Open Companion Studio.`}
            data-testid="capsule-companion-badge"
            className="shrink-0 relative flex items-center justify-center w-8 h-8 rounded-xl bg-black/30 border border-white/[0.18] hover:bg-black/45 hover:border-white/30 transition-colors focus:outline-none focus:ring-1 focus:ring-white/35"
          >
            {settings.companion_id === "none" ? (
              <span className="w-2.5 h-2.5 rounded-full bg-[#D4D4D8]" />
            ) : (
              <CompanionSprite
                companionId={settings.companion_id}
                emotion={companionEmotion}
                size={24}
              />
            )}
          </button>

          {/* 2. Borderless Ask Input */}
          <form onSubmit={handleFormSubmit} className="flex-1 min-w-[110px]">
            <input
              ref={inputRef}
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={isLiveActive ? "Follow up..." : "Ask anything..."}
              aria-label="Ask how to do anything or what's on screen"
              data-testid="bar-query-input"
              className="w-full bg-transparent px-1.5 text-[13px] text-[#F4F4F5] placeholder-white/75 focus:outline-none truncate gl-glass-text"
            />
          </form>

          {/* 2b. Compact Quick-Mode Switcher (Local / Agent / Auto) */}
          <div
            role="group"
            aria-label="Quick brain mode"
            className="shrink-0 flex items-center rounded-lg bg-black/30 border border-white/[0.18] p-0.5 gap-0.5"
          >
            <button
              type="button"
              onClick={() => void handleSelectBrainMode("local_vlm")}
              aria-pressed={isLocalMode}
              aria-label="Use Local Ollama (Ctrl+Alt+O)"
              title="Use Local Ollama (Ctrl+Alt+O)"
              data-testid="quick-mode-local"
              className={`h-6 px-1.5 rounded-md text-[11px] font-medium transition-colors ${
                isLocalMode
                  ? "bg-white/[0.22] text-white"
                  : "text-white/85 hover:text-white"
              }`}
            >
              Local
            </button>
            <button
              type="button"
              onClick={() => void handleSelectBrainMode("agent_cli")}
              aria-pressed={isAgentMode}
              aria-label="Use Agent CLI (Ctrl+Alt+A)"
              title="Use Agent CLI (Ctrl+Alt+A)"
              data-testid="quick-mode-agent"
              className={`h-6 px-1.5 rounded-md text-[11px] font-medium transition-colors ${
                isAgentMode
                  ? "bg-white/[0.22] text-white"
                  : "text-white/85 hover:text-white"
              }`}
            >
              Agent
            </button>
            <button
              type="button"
              onClick={() => void handleSelectBrainMode("auto")}
              aria-pressed={isAutoMode}
              aria-label="Auto brain routing"
              title="Auto brain routing"
              data-testid="quick-mode-auto"
              className={`h-6 px-1.5 rounded-md text-[11px] font-medium transition-colors ${
                isAutoMode
                  ? "bg-white/[0.22] text-white"
                  : "text-white/85 hover:text-white"
              }`}
            >
              Auto
            </button>
          </div>

          {/* 3. Monochrome Mic Icon Button */}
          <div
            className="gl-minimal-mic shrink-0"
            data-testid="mic-shortcut-wrapper"
            title="Mic (Ctrl+Alt+M)"
          >
            <VoiceIndicator
              voiceEnabled={settings.voice_enabled}
              sttEngine={settings.stt_engine}
              pausedForTts={settings.voice_conversation_mode && isSpeaking}
              speaking={isSpeaking}
              onToggleMute={(next) => void handleToggleVoice(next)}
              onTranscript={handleVoiceTranscript}
            />
          </div>

          {/* 4. Clean Live Text Button */}
          <button
            type="button"
            onClick={() => void handleToggleLiveCall()}
            disabled={livePending}
            aria-pressed={isLiveActive}
            aria-label={
              isLiveActive
                ? "End live guidance session (Ctrl+Alt+L)"
                : "Start live guidance session (Ctrl+Alt+L)"
            }
            title={
              isLiveActive
                ? "End Live session (Ctrl+Alt+L)"
                : "Start Live session (Ctrl+Alt+L)"
            }
            data-testid="live-call-toggle"
            className={`shrink-0 flex items-center gap-1 h-7 px-2 rounded-lg text-[11.5px] font-medium border transition-colors focus:outline-none focus:ring-1 focus:ring-white/35 ${
              isLiveActive
                ? "bg-black/45 text-white border-white/30"
                : "bg-black/25 text-white/90 border-white/[0.16] hover:text-white hover:bg-black/40"
            }`}
          >
            {(isLiveActive || livePending) && (
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  livePending ? "bg-[#A1A1AA] animate-pulse" : "bg-[#F4F4F5]"
                }`}
                aria-hidden="true"
              />
            )}
            <span>Live</span>
          </button>

          {/* 5. Clean Day Toggle */}
          <button
            type="button"
            onClick={() => void handleToggleScreenday()}
            aria-pressed={screendayActive}
            aria-label={
              screendayActive
                ? "Pause Screen Day visual diary (Ctrl+Alt+D)"
                : "Record My Day with Screen Day (Ctrl+Alt+D)"
            }
            title={
              screendayActive
                ? "Day active — click to pause (Ctrl+Alt+D)"
                : "Day off — click to enable (Ctrl+Alt+D)"
            }
            data-testid="screenday-toggle"
            className={`shrink-0 flex items-center gap-1 h-7 px-2 rounded-lg text-[11.5px] font-medium border transition-colors focus:outline-none focus:ring-1 focus:ring-white/35 ${
              screendayActive
                ? "bg-black/45 text-white border-white/30"
                : "bg-black/25 text-white/90 border-white/[0.16] hover:text-white hover:bg-black/40"
            }`}
          >
            {screendayActive && (
              <span
                data-testid="screenday-live-dot"
                className={`w-1.5 h-1.5 rounded-full bg-[#F4F4F5] transition-transform ${
                  screendayPulse ? "scale-125" : ""
                }`}
                aria-hidden="true"
              />
            )}
            <span>Day</span>
          </button>

          {/* 6. Subtle Hide Bar (Companion-Only Mode) Icon Button */}
          <button
            type="button"
            onClick={() => void toggleBarOnly()}
            aria-label="Hide top bar (Companion-only mode)"
            data-testid="hide-bar-btn"
            title="Hide bar — Companion only (Ctrl+Alt+H)"
            className="shrink-0 flex items-center justify-center w-7 h-7 rounded-lg text-white/85 hover:text-white hover:bg-black/35 transition-colors focus:outline-none focus:ring-1 focus:ring-white/35"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          </button>

          {/* 7. Clean Control Center Gear/Sliders Icon Button */}
          <button
            type="button"
            onClick={() => void handleOpenControlCenter("overview")}
            aria-label="Open Control Center"
            data-testid="open-settings-btn"
            title="Open GuideLens Control Center"
            className="shrink-0 flex items-center justify-center w-7 h-7 rounded-lg text-white/85 hover:text-white hover:bg-black/35 transition-colors focus:outline-none focus:ring-1 focus:ring-white/35"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
          </button>
        </div>

        {/* 1-Click Learned Default Options Strip (when idle and playbooks exist) */}
        {!isResponseExpanded && !showOnboarding && defaultOptions.length > 0 && (
          <div
            data-testid="default-options-strip"
            className="border-t border-white/[0.14] px-3 py-1.5 flex items-center gap-1.5 flex-wrap gl-glass-text"
          >
            <span className="text-[10.5px] uppercase tracking-wider text-white/80 mr-0.5 font-medium">
              Default Options
            </span>
            {defaultOptions.slice(0, 4).map((opt) => (
              <button
                key={opt.id}
                type="button"
                data-testid={`default-option-pill-${opt.id}`}
                onClick={() => void handleRunPlaybook(opt)}
                title={`${opt.canonical_goal} (${opt.app_exe})`}
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-black/30 hover:bg-black/45 border border-white/[0.20] text-[11.5px] font-medium text-[#F4F4F5] transition-colors"
              >
                <span>⚡ {opt.display_label || opt.canonical_goal}</span>
                {opt.confidence_tier === "verified" && (
                  <span className="px-1.5 py-0 rounded bg-emerald-950/75 border border-emerald-400/45 text-[10px] font-mono text-emerald-200">
                    0 tok
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Docked Monochrome Response Block inside the unified glass sheet */}
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
          liveStatusText={liveStatusLine}
          sessionId={activeSessionId}
          resolutionTier={resolutionTier}
          tokensSaved={tokensSaved}
          playbookId={activePlaybookId}
          feedbackSubmitted={feedbackSubmitted}
          onReAskAi={handleReAskAi}
          onFeedback={(worked) => void handleFeedback(worked)}
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
          <div className="border-t border-white/[0.10] p-2">
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
    </div>
  );
};
