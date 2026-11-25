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
    bubble: "Moving to target control.",
  },
  {
    id: "peek",
    label: "Peek",
    emotion: "peeking",
    actionKind: null,
    bubble: "Observing while Screen Day is active.",
  },
  {
    id: "point",
    label: "Point",
    emotion: "pointing",
    actionKind: "click",
    bubble: "Select this element.",
  },
  {
    id: "bonk",
    label: "Bonk",
    emotion: "bonk",
    actionKind: "bonk",
    bubble: "Window shifted — re-grounding.",
  },
  {
    id: "celebrate",
    label: "Celebrate",
    emotion: "celebrate",
    actionKind: null,
    bubble: "Step complete.",
  },
  {
    id: "type",
    label: "Type",
    emotion: "typing",
    actionKind: "type",
    bubble: "Entering text…",
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
      "Ready to guide your screen.",
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
      setStageBubble(persona.idleWhisper || `Hi, I'm ${persona.name}.`);
      void previewCompanion(id, "celebrate", persona.idleWhisper);
    } else {
      setStageEmotion("idle");
      setStageBubble("Overlay companion hidden.");
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
      `Hello. I'm ${activePersona.name}, your GuideLens copilot.`;
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
      {/* Companion Picker + Quiet Preview Stage */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: 4 Persona Cards + Hidden */}
        <section className="lg:col-span-7 rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold text-[#F4F4F5]">
                Companion
              </h2>
              <p className="text-[12px] text-[#8E929B] mt-0.5">
                Minimal desktop guide that tracks active UI targets
              </p>
            </div>

            <button
              type="button"
              data-testid="companion-none-btn"
              onClick={() => void handleSelectCompanion("none")}
              className={`px-2.5 py-1 rounded-lg text-[11.5px] border transition-colors ${
                settings.companion_id === "none"
                  ? "bg-[#F4F4F5] border-[#F4F4F5] text-[#0A0B0D] font-medium"
                  : "bg-white/[0.04] border-white/[0.08] text-[#8E929B] hover:text-[#F4F4F5]"
              }`}
            >
              {COMPANION_PERSONAS.none.label}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {VISIBLE_COMPANIONS.map((persona) => {
              const selected = settings.companion_id === persona.id;
              return (
                <button
                  key={persona.id}
                  type="button"
                  data-testid={`companion-card-${persona.id}`}
                  aria-pressed={selected}
                  onClick={() => void handleSelectCompanion(persona.id)}
                  className={`text-left rounded-xl p-3.5 border transition-colors flex items-start gap-3 ${
                    selected
                      ? "bg-[#17191E] border-white/30"
                      : "bg-[#0A0B0D] border-white/[0.07] hover:bg-[#17191E]"
                  }`}
                >
                  <div className="shrink-0 w-12 h-12 rounded-lg bg-[#111317] border border-white/[0.07] flex items-center justify-center overflow-hidden">
                    <CompanionSprite
                      companionId={persona.id}
                      emotion={selected ? "celebrate" : "idle"}
                      size={40}
                    />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-[13px] font-semibold text-[#F4F4F5] truncate">
                        {persona.name}
                      </span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono border border-white/[0.07] bg-white/[0.03] text-[#8E929B] shrink-0">
                        {persona.defaultVoice} · {persona.defaultSpeed}×
                      </span>
                    </div>
                    <div className="text-[11.5px] text-[#E4E4E7]">
                      {persona.tagline}
                    </div>
                    <p className="text-[11px] text-[#5C606A] line-clamp-2 leading-snug">
                      {persona.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Calm Perch / Wander Toggle */}
          <label className="flex items-center justify-between gap-3 rounded-lg bg-[#0A0B0D] border border-white/[0.07] px-4 py-3 cursor-pointer">
            <div>
              <span className="block text-[12.5px] font-medium text-[#F4F4F5]">
                Idle perch while Screen Day is on
              </span>
              <span className="block text-[11.5px] text-[#8E929B]">
                Companion rests calmly above the taskbar while recording
              </span>
            </div>
            <input
              type="checkbox"
              data-testid="companion-wander-toggle"
              checked={settings.companion_wander}
              onChange={(e) =>
                void onUpdateSettings({ companion_wander: e.target.checked })
              }
              className="accent-[#F4F4F5]"
            />
          </label>
        </section>

        {/* Right: Quiet Preview Stage */}
        <section className="lg:col-span-5 rounded-xl bg-[#111317] border border-white/[0.07] p-5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-[13.5px] font-semibold text-[#F4F4F5]">
                Preview Stage
              </h3>
              <p className="text-[11.5px] text-[#8E929B]">
                {activePersona.name} ·{" "}
                <span className="font-mono text-[#5C606A]">{stageEmotion}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                setStageFacing((f) => (f === "right" ? "left" : "right"))
              }
              className="px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[11px] text-[#E4E4E7] transition-colors"
            >
              Face: {stageFacing}
            </button>
          </div>

          {/* Stage Viewport */}
          <div
            data-testid="companion-live-stage"
            className="relative rounded-lg bg-[#0A0B0D] border border-white/[0.07] p-5 flex flex-col items-center justify-center min-h-[185px] overflow-hidden"
          >
            {stageBubble && (
              <div className="relative z-10 mb-3 max-w-[250px] rounded-lg bg-[#111317] border border-white/[0.08] px-3 py-1.5 text-[11.5px] text-[#E4E4E7] text-center">
                {stageBubble}
              </div>
            )}
            <div className="relative z-10">
              <CompanionSprite
                companionId={stageCompanionId}
                emotion={stageEmotion}
                actionKind={stageActionKind}
                facing={stageFacing}
                size={88}
              />
            </div>
          </div>

          {/* Quiet Ghost Reaction Buttons */}
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-1.5">
              {STAGE_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  data-testid={`companion-react-${action.id}`}
                  disabled={previewBusy}
                  onClick={() => void handleTriggerReaction(action)}
                  className={`px-2.5 py-1.5 rounded-lg border text-[12px] font-medium transition-colors ${
                    stageEmotion === action.emotion
                      ? "bg-[#17191E] border-white/25 text-[#F4F4F5]"
                      : "bg-white/[0.04] border-white/[0.08] text-[#8E929B] hover:bg-white/[0.08] hover:text-[#F4F4F5]"
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
                className="flex-1 px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[12px] font-medium text-[#E4E4E7] transition-colors"
              >
                Speak
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
                className="px-3 py-1.5 rounded-lg bg-[#F4F4F5] hover:bg-white text-[#0A0B0D] text-[12px] font-medium transition-colors"
              >
                Sync Voice Preset
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Embedded VoiceStudio */}
      <div data-testid="panel-voice">
        <VoiceStudio settings={settings} onUpdateSettings={onUpdateSettings} />
      </div>
    </div>
  );
};
