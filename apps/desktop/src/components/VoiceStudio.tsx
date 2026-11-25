import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  encodeWavBlob,
  type TinyVocaBenchmarkResult,
  TinyVocaClient,
  type TinyVocaState,
} from "../lib/tinyVocaClient";
import type { Settings, SttEngine, TinyVocaVoice } from "../types";

export interface VoiceStudioProps {
  settings: Settings;
  onUpdateSettings: (patch: Partial<Settings>) => Promise<void> | void;
}

const SAMPLE_PRESETS = [
  {
    id: "guide",
    label: "Guide Step",
    text: "Click the Export button in the top right toolbar, then choose PNG format to save your image.",
  },
  {
    id: "multi",
    label: "Multi-Step",
    text: "First, open Settings from the gear icon. Next, choose your Groq Pro brain. Finally, press Control Space to start.",
  },
  {
    id: "welcome",
    label: "Welcome",
    text: "Welcome to GuideLens Voice Studio! Everything runs locally at 24 kilohertz with zero cloud latency.",
  },
] as const;

const VOICE_OPTIONS: ReadonlyArray<{
  id: TinyVocaVoice;
  name: string;
  subtitle: string;
}> = [
  { id: "M2", name: "M2", subtitle: "Natural Male — Default" },
  { id: "F2", name: "F2", subtitle: "Female" },
];

const INITIAL_ENGINE_STATE: TinyVocaState = {
  status: "idle",
  speaking: false,
  voices: ["M2", "F2"],
  sampleRate: 24000,
  modelBytes: 0,
  loadMs: 0,
  error: null,
};

function formatStatusLabel(state: TinyVocaState): string {
  switch (state.status) {
    case "loading":
      return "Loading…";
    case "ready":
      return state.loadMs > 0 ? `Ready (${state.loadMs} ms)` : "Ready";
    case "speaking":
      return "Speaking";
    case "error":
      return "Error";
    case "idle":
    default:
      return "Standby";
  }
}

export const VoiceStudio: React.FC<VoiceStudioProps> = ({
  settings,
  onUpdateSettings,
}) => {
  const clientRef = useRef<TinyVocaClient | null>(null);
  const mountedRef = useRef(true);

  const [engineState, setEngineState] =
    useState<TinyVocaState>(INITIAL_ENGINE_STATE);
  const [sampleText, setSampleText] = useState<string>(SAMPLE_PRESETS[0].text);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const [benchmarkResult, setBenchmarkResult] =
    useState<TinyVocaBenchmarkResult | null>(null);
  const [lastAudio, setLastAudio] = useState<{
    audio: Float32Array;
    sampleRate: number;
    voice: TinyVocaVoice;
  } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const appendLog = useCallback((entry: string) => {
    setLogs((prev) => [...prev.slice(-49), entry]);
  }, []);

  const getClient = useCallback((): TinyVocaClient => {
    if (!clientRef.current) {
      clientRef.current = new TinyVocaClient();
    }
    return clientRef.current;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const client = getClient();
    setEngineState(client.getState());
    const unsubscribe = client.subscribe((next) => {
      if (mountedRef.current) {
        setEngineState(next);
      }
    });

    return () => {
      mountedRef.current = false;
      unsubscribe();
      client.dispose();
      clientRef.current = null;
    };
  }, [getClient]);

  const speakingActive = isPlaying || engineState.speaking;

  const handlePlayOrStop = async () => {
    const client = getClient();
    if (speakingActive) {
      client.stop();
      setIsPlaying(false);
      appendLog("Playback stopped.");
      return;
    }

    const text = sampleText.trim();
    if (!text) return;

    setIsPlaying(true);
    appendLog(
      `Synthesizing (${settings.tts_voice}, ${settings.tts_speed.toFixed(2)}×, pitch ${settings.tts_pitch_shift >= 0 ? "+" : ""}${settings.tts_pitch_shift.toFixed(2)})…`,
    );

    try {
      const result = await client.speak(text, {
        voice: settings.tts_voice,
        speed: settings.tts_speed,
        pitchShift: settings.tts_pitch_shift,
        onSentence: ({ index, total, phonemes }) => {
          if (mountedRef.current) {
            appendLog(`[${index + 1}/${total}] ${phonemes}`);
          }
        },
      });

      if (!mountedRef.current) return;

      if (!result.cancelled && result.audio.length > 0) {
        setLastAudio({
          audio: result.audio,
          sampleRate: result.sampleRate,
          voice: settings.tts_voice,
        });
        appendLog(
          `Finished ${result.durationSec.toFixed(2)}s audio in ${result.workSec.toFixed(2)}s (${result.realtimeFactor.toFixed(1)}× real time).`,
        );
      }
    } catch (err) {
      if (mountedRef.current) {
        appendLog(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      if (mountedRef.current) {
        setIsPlaying(false);
      }
    }
  };

  const handleSaveWav = () => {
    if (!lastAudio || lastAudio.audio.length === 0) return;
    const blob = encodeWavBlob(lastAudio.audio, lastAudio.sampleRate);
    const filename = `tiny-voca-${lastAudio.voice}.wav`;

    if (typeof URL.createObjectURL === "function") {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => {
        if (typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(url);
        }
      }, 1000);
    }

    appendLog(`Exported ${filename} (${(blob.size / 1024).toFixed(1)} KB).`);
  };

  const handleBenchmark = async () => {
    if (isBenchmarking) return;
    const client = getClient();
    setIsBenchmarking(true);
    appendLog("Running tiny-voca local speed benchmark…");

    try {
      const result = await client.benchmark();
      if (!mountedRef.current) return;
      setBenchmarkResult(result);
      appendLog(`Benchmark: ${result.summary}`);
      if (result.parts) {
        appendLog(`Breakdown: ${result.parts}`);
      }
    } catch (err) {
      if (mountedRef.current) {
        appendLog(
          `Benchmark error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      if (mountedRef.current) {
        setIsBenchmarking(false);
      }
    }
  };

  return (
    <div className="space-y-4" data-testid="voice-studio">
      {/* Engine Header */}
      <section className="rounded-xl bg-[#111317] border border-white/[0.07] px-5 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[13.5px] font-semibold text-[#F4F4F5]">
            tiny-voca Local Voice Engine · 4.5M params · 8.0 MB Offline · 24 kHz
          </h2>
          <p className="text-[12px] text-[#8E929B] mt-0.5">
            In-browser Web Worker synthesis with zero external server calls
          </p>
        </div>
        <div className="flex items-center gap-3 text-[12px]">
          <span
            data-testid="voice-studio-active-voice"
            className="font-mono text-[#E4E4E7]"
          >
            Voice: {settings.tts_voice}
          </span>
          <span className="text-[#5C606A]">·</span>
          <span
            data-testid="voice-studio-status-badge"
            className="inline-flex items-center gap-1.5 text-[#8E929B]"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                engineState.status === "speaking" || engineState.status === "ready"
                  ? "bg-[#F4F4F5]"
                  : "bg-[#5C606A]"
              }`}
            />
            {formatStatusLabel(engineState)}
          </span>
        </div>
      </section>

      {engineState.error && (
        <div
          role="alert"
          className="rounded-xl bg-[#111317] border border-white/[0.12] px-4 py-2.5 text-[12px] text-[#E4E4E7]"
        >
          {engineState.error}
        </div>
      )}

      {/* Voice & Conversation Settings */}
      <section
        aria-label="Copilot Voice Settings"
        className="rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-4"
      >
        <h3 className="text-[13.5px] font-semibold text-[#F4F4F5]">
          Voice &amp; Conversation
        </h3>

        <div className="divide-y divide-white/[0.06]">
          <label className="flex items-center justify-between gap-4 py-2.5 first:pt-0 cursor-pointer">
            <div>
              <span className="block text-[12.5px] font-medium text-[#F4F4F5]">
                Voice Guidance Output
              </span>
              <span className="block text-[11.5px] text-[#8E929B]">
                Speak step instructions and error cues using local tiny-voca TTS
              </span>
            </div>
            <input
              type="checkbox"
              data-testid="tts-enabled-toggle"
              checked={settings.tts_enabled}
              onChange={(e) =>
                void onUpdateSettings({ tts_enabled: e.target.checked })
              }
              className="accent-[#F4F4F5]"
            />
          </label>

          <label className="flex items-center justify-between gap-4 py-2.5 cursor-pointer">
            <div>
              <span className="block text-[12.5px] font-medium text-[#F4F4F5]">
                Auto-Speak Steps
              </span>
              <span className="block text-[11.5px] text-[#8E929B]">
                Read each step aloud automatically when guidance updates
              </span>
            </div>
            <input
              type="checkbox"
              data-testid="tts-auto-speak-toggle"
              checked={settings.tts_auto_speak}
              onChange={(e) =>
                void onUpdateSettings({ tts_auto_speak: e.target.checked })
              }
              className="accent-[#F4F4F5]"
            />
          </label>

          <label className="flex items-center justify-between gap-4 py-2.5 last:pb-0 cursor-pointer">
            <div>
              <span className="block text-[12.5px] font-medium text-[#F4F4F5]">
                Hands-Free Voice-to-Voice Turn-Taking
              </span>
              <span className="block text-[11.5px] text-[#8E929B]">
                Pause mic while speaking and resume after 250ms echo settle
              </span>
            </div>
            <input
              type="checkbox"
              data-testid="voice-conversation-mode-toggle"
              checked={settings.voice_conversation_mode}
              onChange={(e) =>
                void onUpdateSettings({
                  voice_conversation_mode: e.target.checked,
                })
              }
              className="accent-[#F4F4F5]"
            />
          </label>
        </div>

        {/* Voice Persona Picker */}
        <div className="pt-3 border-t border-white/[0.07] space-y-2">
          <span className="block text-[12px] text-[#8E929B]">
            Voice Persona
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {VOICE_OPTIONS.map((v) => {
              const selected = settings.tts_voice === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  data-testid={`tts-voice-${v.id}`}
                  aria-pressed={selected}
                  onClick={() => void onUpdateSettings({ tts_voice: v.id })}
                  className={`flex items-center justify-between rounded-lg px-3 py-2 text-left border transition-colors ${
                    selected
                      ? "bg-[#17191E] border-white/25 text-[#F4F4F5]"
                      : "bg-[#0A0B0D] border-white/[0.07] text-[#8E929B] hover:text-[#F4F4F5]"
                  }`}
                >
                  <div className="text-[12.5px] font-medium text-[#F4F4F5]">
                    {v.name}{" "}
                    <span className="text-[#8E929B] font-normal">
                      ({v.subtitle})
                    </span>
                  </div>
                  {selected && (
                    <span className="w-1.5 h-1.5 rounded-full bg-[#F4F4F5]" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Speed & Pitch Sliders */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-white/[0.07]">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[12px]">
              <label htmlFor="tts-speed-slider" className="text-[#F4F4F5]">
                Speaking Speed
              </label>
              <span
                data-testid="tts-speed-value"
                className="gl-mono text-[#8E929B]"
              >
                {settings.tts_speed.toFixed(2)}×
              </span>
            </div>
            <input
              id="tts-speed-slider"
              data-testid="tts-speed-slider"
              type="range"
              min={0.75}
              max={1.5}
              step={0.05}
              value={settings.tts_speed}
              onChange={(e) =>
                void onUpdateSettings({ tts_speed: Number(e.target.value) })
              }
              className="w-full h-1 accent-[#F4F4F5]"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[12px]">
              <label htmlFor="tts-pitch-slider" className="text-[#F4F4F5]">
                Pitch Shift
              </label>
              <span
                data-testid="tts-pitch-value"
                className="gl-mono text-[#8E929B]"
              >
                {settings.tts_pitch_shift >= 0 ? "+" : ""}
                {settings.tts_pitch_shift.toFixed(2)}
              </span>
            </div>
            <input
              id="tts-pitch-slider"
              data-testid="tts-pitch-slider"
              type="range"
              min={-0.3}
              max={0.3}
              step={0.05}
              value={settings.tts_pitch_shift}
              onChange={(e) =>
                void onUpdateSettings({
                  tts_pitch_shift: Number(e.target.value),
                })
              }
              className="w-full h-1 accent-[#F4F4F5]"
            />
          </div>
        </div>

        {/* STT Engine Selector */}
        <div className="flex items-center justify-between gap-3 pt-3 border-t border-white/[0.07]">
          <label
            htmlFor="voice-studio-stt-select"
            className="text-[12.5px] text-[#F4F4F5]"
          >
            Speech-to-Text (STT) Engine
          </label>
          <select
            id="voice-studio-stt-select"
            aria-label="Speech-to-Text Engine"
            data-testid="voice-studio-stt-select"
            value={settings.stt_engine}
            onChange={(e) =>
              void onUpdateSettings({
                stt_engine: e.target.value as SttEngine,
              })
            }
            className="rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-[#F4F4F5]"
          >
            <option value="web_speech">
              Web Speech API (Default — Zero Overhead)
            </option>
            <option value="cloud">
              Cloud Whisper (Groq VAD Hands-Free)
            </option>
            <option value="whisper_cpp">
              Local whisper.cpp (Offline)
            </option>
          </select>
        </div>
      </section>

      {/* Embedded tiny-voca Playground */}
      <section
        aria-label="tiny-voca Web App Playground"
        className="rounded-xl bg-[#111317] border border-white/[0.07] p-5 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13.5px] font-semibold text-[#F4F4F5]">
            Playground
          </h3>
          <div className="flex items-center gap-1.5">
            {SAMPLE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-testid={`voice-preset-${preset.id}`}
                onClick={() => setSampleText(preset.text)}
                className="px-2.5 py-1 rounded-md text-[11.5px] bg-[#0A0B0D] border border-white/[0.07] text-[#8E929B] hover:text-[#F4F4F5] hover:bg-[#17191E] transition-colors"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <textarea
          rows={3}
          aria-label="Voice synthesis sample text"
          data-testid="voice-studio-textarea"
          value={sampleText}
          onChange={(e) => setSampleText(e.target.value)}
          placeholder="Type any coaching cue or paragraph to synthesize locally..."
          className="w-full rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-2 text-[12.5px] text-[#F4F4F5] placeholder-[#5C606A] focus:outline-none focus:border-white/25"
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="voice-studio-play-btn"
            onClick={() => void handlePlayOrStop()}
            disabled={!speakingActive && !sampleText.trim()}
            className={`px-3.5 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${
              speakingActive
                ? "bg-white/[0.08] text-[#F4F4F5] border border-white/20"
                : "bg-[#F4F4F5] text-[#0A0B0D] hover:bg-white disabled:opacity-40"
            }`}
          >
            {speakingActive ? "Stop" : "Play Sample"}
          </button>

          <button
            type="button"
            data-testid="voice-studio-save-wav-btn"
            onClick={handleSaveWav}
            disabled={!lastAudio || lastAudio.audio.length === 0}
            className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium bg-white/[0.04] border border-white/[0.08] text-[#E4E4E7] hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Save as WAV
          </button>

          <button
            type="button"
            data-testid="voice-studio-benchmark-btn"
            onClick={() => void handleBenchmark()}
            disabled={isBenchmarking}
            className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium bg-white/[0.04] border border-white/[0.08] text-[#E4E4E7] hover:bg-white/[0.08] disabled:opacity-40 transition-colors"
          >
            {isBenchmarking ? "Benchmarking…" : "Measure Speed"}
          </button>
        </div>

        {benchmarkResult && (
          <div
            data-testid="voice-studio-benchmark-results"
            className="rounded-lg bg-[#0A0B0D] border border-white/[0.08] p-3 space-y-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
              <span className="font-medium text-[#F4F4F5]">
                {benchmarkResult.summary}
              </span>
              {benchmarkResult.parts && (
                <span className="gl-mono text-[11px] text-[#8E929B]">
                  {benchmarkResult.parts}
                </span>
              )}
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-[11px] gl-mono text-[#8E929B] max-h-36 overflow-y-auto">
              {benchmarkResult.lines.map((line, i) => (
                <li key={i} className="truncate">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-1">
          <span className="block text-[11.5px] text-[#5C606A]">
            Telemetry Log
          </span>
          <div
            data-testid="voice-studio-log"
            className="rounded-lg bg-[#0A0B0D] border border-white/[0.07] p-2.5 h-28 overflow-y-auto gl-mono text-[11px] text-[#8E929B] space-y-1"
          >
            {logs.length === 0 ? (
              <p className="text-[#5C606A]">
                Click Play Sample or Measure Speed to inspect live phonemes and synthesis speed.
              </p>
            ) : (
              logs.map((entry, idx) => (
                <div key={idx} className="leading-snug break-words">
                  {entry}
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
