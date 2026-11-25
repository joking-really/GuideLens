import React, { useRef, useState } from "react";
import {
  CompanionSprite,
  type CompanionEmotion,
} from "../companions/CompanionSprite";
import {
  COMPANION_PERSONAS,
  getCompanionPersona,
  VISIBLE_COMPANIONS,
} from "../companions/personas";
import { VoiceStudio } from "../components/VoiceStudio";
import { previewCompanion } from "../lib/ipc";
import { getCopilotVoiceEngine } from "../lib/tinyVocaClient";
import type { CompanionId, Settings } from "../types";
import { CompanionIcon, EyeIcon, PlayIcon } from "./HubIcons";

export interface CompanionsVoiceTabProps {
  settings: Settings;
  onUpdateSettings: (patch: Partial<Settings>) => Promise<void> | void;
}

const STAGE_ACTIONS: ReadonlyArray<{
  id: string;
  label: string;
  emotion: CompanionEmotion;
  actionKind?: string | null;
  bubble: string;
}> = [
  {
    id: "jump",
    label: "Jump",
    emotion: "jumping",
    actionKind: null,
    bubble: "Leaping right to the target button!",
  },
  {
    id: "bonk",
    label: "Bonk",
    emotion: "bonk",
    actionKind: "bonk",
    bubble: "Bonk! Did that window just move?",
  },
  {
    id: "peek",
    label: "Peek",
    emotion: "peeking",
    actionKind: null,
    bubble: "Peeking from the edge while Screen Day watches.",
  },
  {
    id: "celebrate",
    label: "Celebrate",
    emotion: "celebrate",
    actionKind: null,
    bubble: "Step complete! Nice work!",
  },
  {
    id: "point",
    label: "Point",
    emotion: "pointing",
    actionKind: "click",
    bubble: "Click right here!",
  },
  {
    id: "type",
    label: "Type",
    emotion: "typing",
    actionKind: "type",
    bubble: "Typing into this field...",
  },
];

export const CompanionsVoiceTab: React.FC<CompanionsVoiceTabProps> = ({
  settings,
  onUpdateSettings,
}) => {
  const voiceEngineRef = useRef<ReturnType<typeof getCopilotVoiceEngine> | null>(
    null,
  );
  const [stageEmotion, setStageEmotion] = useState<CompanionEmotion>("idle");
  const [stageActionKind, setStageActionKind] = useState<string | null>(null);
  const [stageFacing, setStageFacing] = useState<"left" | "right">("right");
  const [stageBubble, setStageBubble] = useState<string>(
    getCompanionPersona(settings.companion_id).idleWhisper ||
      "Ready to guide your screen!",
  );
  const [previewBusy, setPreviewBusy] = useState(false);

  const activePersona = getCompanionPersona(settings.companion_id);
  const stageCompanionId: CompanionId =
    settings.companion_id === "none" ? "pixel_cat" : settings.companion_id;

  const handleSelectCompanion = async (id: CompanionId) => {
    const persona = getCompanionPersona(id);
    await onUpdateSettings({ companion_id: id });
    if (id !== "none") {
      setStageEmotion("celebrate");
      setStageActionKind(null);
      setStageBubble(persona.idleWhisper || `Hi! I'm ${persona.name}.`);
      void previewCompanion(id, "celebrate", persona.idleWhisper);
    } else {
      setStageEmotion("idle");
      setStageBubble("Overlay companion hidden (stealth mode).");
      void previewCompanion("none", "idle", null);
    }
  };

  const handleTriggerReaction = async (
    action: (typeof STAGE_ACTIONS)[number],
  ) => {
    setStageEmotion(action.emotion);
    setStageActionKind(action.actionKind ?? null);
    setStageBubble(action.bubble);
    setPreviewBusy(true);
    try {
      await previewCompanion(stageCompanionId, action.emotion, action.bubble);
    } finally {
      setPreviewBusy(false);
    }
  };

  const handleSpeakGreeting = async () => {
    if (!voiceEngineRef.current) {
      voiceEngineRef.current = getCopilotVoiceEngine();
    }
    const text =
      activePersona.idleWhisper ||
      `Hello! I'm ${activePersona.name}, your GuideLens copilot.`;
    setStageEmotion("celebrate");
    setStageBubble(text);
    try {
      await voiceEngineRef.current.speak(text, {
        voice: activePersona.defaultVoice,
        speed: activePersona.defaultSpeed,
        pitchShift: activePersona.defaultPitchShift,
      });
    } catch {
      // Ignore audio errors in headless/browser environments
    }
  };

  return (
    <div className="space-y-5" data-testid="panel-companions">
      {/* Companion Selector + Live Stage */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: 4 Persona Cards + Stealth Option */}
        <section className="lg:col-span-7 rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-pink-500/15 border border-pink-400/30 flex items-center justify-center text-pink-300">
                <CompanionIcon className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-[14px] font-semibold text-zinc-100">
                  Interactive Companion Studio
                </h2>
                <p className="text-[11.5px] text-zinc-400">
                  Pick your animated desktop sprite that leaps to UI targets and peeks while recording
                </p>
              </div>
            </div>

            <button
              type="button"
              data-testid="companion-none-btn"
              onClick={() => void handleSelectCompanion("none")}
              className={`px-2.5 py-1 rounded-lg text-[11.5px] border transition-colors ${
                settings.companion_id === "none"
                  ? "bg-amber-500/20 border-amber-400/50 text-amber-200 font-semibold"
                  : "bg-white/[0.04] border-white/10 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {COMPANION_PERSONAS.none.label}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {VISIBLE_COMPANIONS.map((persona) => {
              const selected = settings.companion_id === persona.id;
              return (
                <button
                  key={persona.id}
                  type="button"
                  data-testid={`companion-card-${persona.id}`}
                  aria-pressed={selected}
                  onClick={() => void handleSelectCompanion(persona.id)}
                  className={`text-left rounded-2xl p-3.5 border transition-all flex items-start gap-3 ${
                    selected
                      ? "bg-sky-400/12 border-sky-400 shadow-lg shadow-sky-500/10"
                      : "bg-[#090B10]/85 border-white/10 hover:border-white/25"
                  }`}
                >
                  <div className="shrink-0 w-14 h-14 rounded-xl bg-[#11141D] border border-white/10 flex items-center justify-center overflow-hidden">
                    <CompanionSprite
                      companionId={persona.id}
                      emotion={selected ? "celebrate" : "idle"}
                      size={48}
                    />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-[13.5px] font-bold text-zinc-100 truncate">
                        {persona.name}
                      </span>
                      <span
                        style={{
                          borderColor: `${persona.accentColor}55`,
                          color: persona.accentColor,
                        }}
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium border bg-white/[0.03] shrink-0"
                      >
                        {persona.defaultVoice} · {persona.defaultSpeed}×
                      </span>
                    </div>
                    <div className="text-[11px] font-medium text-sky-300">
                      {persona.tagline}
                    </div>
                    <p className="text-[11px] text-zinc-400 line-clamp-2 leading-snug">
                      {persona.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Companion Behavior Toggle */}
          <label className="flex items-center justify-between gap-3 rounded-xl bg-[#090B10]/85 border border-white/[0.08] px-4 py-3 cursor-pointer">
            <div className="flex items-center gap-2.5">
              <EyeIcon className="w-4 h-4 text-emerald-300 shrink-0" />
              <div>
                <span className="block text-[12.5px] font-semibold text-zinc-100">
                  Peek &amp; wander while Screen Day is on
                </span>
                <span className="block text-[11px] text-zinc-400">
                  Companion gently walks along your taskbar and peeks from the edge when recording your day
                </span>
              </div>
            </div>
            <input
              type="checkbox"
              data-testid="companion-wander-toggle"
              checked={settings.companion_wander}
              onChange={(e) =>
                void onUpdateSettings({ companion_wander: e.target.checked })
              }
            />
          </label>
        </section>

        {/* Right: Live Animated Stage */}
        <section className="lg:col-span-5 rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-[13.5px] font-semibold text-zinc-100">
                Live Animation Stage
              </h3>
              <p className="text-[11px] text-zinc-400">
                Previewing {activePersona.label} ·{" "}
                <span className="font-mono text-sky-300">{stageEmotion}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                setStageFacing((f) => (f === "right" ? "left" : "right"))
              }
              className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] text-zinc-300"
            >
              Face: {stageFacing}
            </button>
          </div>

          {/* Stage Backdrop */}
          <div
            data-testid="companion-live-stage"
            className="relative rounded-2xl bg-[#090B10] border border-white/10 p-5 flex flex-col items-center justify-center min-h-[190px] overflow-hidden"
          >
            <div
              style={{
                background: `radial-gradient(circle at 50% 45%, ${activePersona.accentColor}22, transparent 70%)`,
              }}
              className="absolute inset-0 pointer-events-none"
            />
            {stageBubble && (
              <div className="relative z-10 mb-3 max-w-[260px] rounded-xl bg-[#161B26]/95 border border-white/15 px-3 py-1.5 text-[11.5px] text-zinc-100 text-center shadow-lg">
                {stageBubble}
              </div>
            )}
            <div className="relative z-10">
              <CompanionSprite
                companionId={stageCompanionId}
                emotion={stageEmotion}
                actionKind={stageActionKind}
                facing={stageFacing}
                size={96}
              />
            </div>
          </div>

          {/* Reaction Trigger Buttons */}
          <div className="space-y-2.5">
            <div className="grid grid-cols-3 gap-2">
              {STAGE_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  data-testid={`companion-react-${action.id}`}
                  disabled={previewBusy}
                  onClick={() => void handleTriggerReaction(action)}
                  className={`px-2.5 py-1.5 rounded-xl border text-[12px] font-medium transition-colors ${
                    stageEmotion === action.emotion
                      ? "bg-sky-400/20 border-sky-400 text-sky-200"
                      : "bg-[#090B10]/85 border-white/10 text-zinc-300 hover:bg-white/[0.06]"
                  }`}
                >
                  {action.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                data-testid="companion-speak-greeting-btn"
                onClick={() => void handleSpeakGreeting()}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-[12px] font-medium text-zinc-100"
              >
                <PlayIcon className="w-3.5 h-3.5 text-sky-300" />
                Speak Persona Cue
              </button>
              <button
                type="button"
                data-testid="apply-persona-voice-btn"
                onClick={() =>
                  void onUpdateSettings({
                    tts_voice: activePersona.defaultVoice,
                    tts_speed: activePersona.defaultSpeed,
                    tts_pitch_shift: activePersona.defaultPitchShift,
                  })
                }
                className="px-3 py-1.5 rounded-xl bg-sky-400/15 hover:bg-sky-400/25 border border-sky-400/40 text-[12px] font-medium text-sky-200"
              >
                Sync Voice Preset
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Embedded VoiceStudio (Preserves data-testid="panel-voice" and all VoiceStudio testids) */}
      <div data-testid="panel-voice">
        <VoiceStudio settings={settings} onUpdateSettings={onUpdateSettings} />
      </div>
    </div>
  );
};
