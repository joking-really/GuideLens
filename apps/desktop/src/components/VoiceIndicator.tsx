import React, { useEffect, useRef, useState } from "react";
import { transcribeAudio } from "../lib/ipc";
import type { SttEngine } from "../types";

const ECHO_SETTLE_DELAY_MS = 250;
const VAD_POLL_INTERVAL_MS = 60;
const VAD_RMS_THRESHOLD = 0.02;
const VAD_SILENCE_MS = 1300;
const VAD_MAX_UTTERANCE_MS = 15000;

interface SpeechRecognitionResultItem {
  transcript: string;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  0: SpeechRecognitionResultItem;
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResult;
  };
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export interface VoiceIndicatorProps {
  voiceEnabled: boolean;
  sttEngine: SttEngine;
  pausedForTts?: boolean;
  speaking?: boolean;
  onToggleMute: (nextEnabled: boolean) => void;
  onTranscript: (text: string, isFinal: boolean) => void;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function getAudioContextConstructor(): (new () => AudioContext) | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: new () => AudioContext })
      .webkitAudioContext
  );
}

function computeAnalyserRms(
  analyser: AnalyserNode,
  floatBuf: Float32Array<ArrayBuffer>,
  byteBuf: Uint8Array<ArrayBuffer>,
): number {
  if (typeof analyser.getFloatTimeDomainData === "function") {
    analyser.getFloatTimeDomainData(floatBuf);
    let sumSq = 0;
    for (let i = 0; i < floatBuf.length; i++) {
      const sample = floatBuf[i];
      sumSq += sample * sample;
    }
    return Math.sqrt(sumSq / Math.max(1, floatBuf.length));
  }

  if (typeof analyser.getByteTimeDomainData === "function") {
    analyser.getByteTimeDomainData(byteBuf);
    let sumSq = 0;
    for (let i = 0; i < byteBuf.length; i++) {
      const normalized = (byteBuf[i] - 128) / 128;
      sumSq += normalized * normalized;
    }
    return Math.sqrt(sumSq / Math.max(1, byteBuf.length));
  }

  return 0;
}

function stopStreamTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // Ignore already-stopped tracks
    }
  });
}

export const VoiceIndicator: React.FC<VoiceIndicatorProps> = ({
  voiceEnabled,
  sttEngine,
  pausedForTts = false,
  speaking = false,
  onToggleMute,
  onTranscript,
}) => {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const pausedForTtsRef = useRef(pausedForTts);
  pausedForTtsRef.current = pausedForTts;
  const wasPausedForTtsRef = useRef(false);
  const unmountedRef = useRef(false);

  // Declare unmount tracker before listening effect so cleanup sees unmountedRef = true
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (!voiceEnabled) {
      wasPausedForTtsRef.current = false;
      setListening(false);
      return;
    }

    if (pausedForTts) {
      wasPausedForTtsRef.current = true;
      setListening(false);
      return;
    }

    let effectDisposed = false;
    let stopActiveInput: (() => void) | null = null;
    let settleTimer: number | null = null;

    const startActiveEngine = (): (() => void) => {
      if (sttEngine === "web_speech") {
        const Ctor =
          typeof window !== "undefined"
            ? window.SpeechRecognition || window.webkitSpeechRecognition
            : undefined;
        if (!Ctor) {
          setListening(false);
          return () => {};
        }

        let speechDisposed = false;
        let hadError = false;
        try {
          const recognition = new Ctor();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = "en-US";

          recognition.onresult = (event: SpeechRecognitionEvent) => {
            if (speechDisposed || pausedForTtsRef.current) {
              return;
            }
            let transcript = "";
            let isFinal = false;
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const res = event.results[i];
              if (res && res[0]) {
                transcript += res[0].transcript;
                if (res.isFinal) {
                  isFinal = true;
                }
              }
            }
            if (transcript.trim()) {
              onTranscriptRef.current(transcript.trim(), isFinal);
            }
          };

          recognition.onerror = () => {
            hadError = true;
            setListening(false);
          };

          recognition.onend = () => {
            setListening(false);
            // Gently restart after silence if still active and not paused for TTS
            if (
              !speechDisposed &&
              !hadError &&
              !pausedForTtsRef.current &&
              !unmountedRef.current
            ) {
              try {
                recognition.start();
                setListening(true);
              } catch {
                setListening(false);
              }
            }
          };

          recognition.start();
          recognitionRef.current = recognition;
          setListening(true);
        } catch {
          setListening(false);
        }

        return () => {
          speechDisposed = true;
          if (recognitionRef.current) {
            try {
              recognitionRef.current.stop();
            } catch {
              // Ignore cleanup errors
            }
            recognitionRef.current = null;
          }
          setListening(false);
        };
      }

      // MediaRecorder path for cloud (Groq Whisper with RMS VAD) or whisper_cpp
      let recorderDisposed = false;
      let discardChunk = false;
      let stream: MediaStream | null = null;
      let audioCtx: AudioContext | null = null;
      let mediaSource: MediaStreamAudioSourceNode | null = null;
      let pollTimer: number | null = null;

      if (
        typeof navigator !== "undefined" &&
        navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== "undefined"
      ) {
        navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((mediaStream) => {
            if (recorderDisposed || pausedForTtsRef.current) {
              stopStreamTracks(mediaStream);
              return;
            }
            stream = mediaStream;

            const AudioCtxCtor =
              sttEngine === "cloud" ? getAudioContextConstructor() : undefined;
            let analyser: AnalyserNode | null = null;

            if (AudioCtxCtor) {
              try {
                const ctx = new AudioCtxCtor();
                if (
                  typeof ctx.createMediaStreamSource === "function" &&
                  typeof ctx.createAnalyser === "function"
                ) {
                  const src = ctx.createMediaStreamSource(mediaStream);
                  const node = ctx.createAnalyser();
                  try {
                    node.fftSize = 1024;
                  } catch {
                    // Use default fftSize if read-only in mock
                  }
                  src.connect(node);
                  if (ctx.state === "suspended" && typeof ctx.resume === "function") {
                    void Promise.resolve(ctx.resume()).catch(() => {});
                  }
                  audioCtx = ctx;
                  mediaSource = src;
                  analyser = node;
                } else if (typeof ctx.close === "function") {
                  void Promise.resolve(ctx.close()).catch(() => {});
                }
              } catch {
                analyser = null;
              }
            }

            if (sttEngine === "cloud" && analyser) {
              // Hands-free RMS VAD utterance loop for Groq Whisper
              const binCount = analyser.fftSize || 1024;
              const floatBuf = new Float32Array(new ArrayBuffer(binCount * 4));
              const byteBuf = new Uint8Array(new ArrayBuffer(binCount));

              let activeRecorder: MediaRecorder | null = null;
              let speechActive = false;
              let utteranceStartedAt = 0;
              let lastSpeechAt = 0;
              let transcribing = false;

              const startUtteranceRecorder = (now: number) => {
                const recorder = new MediaRecorder(mediaStream);
                const chunks: BlobPart[] = [];
                activeRecorder = recorder;
                mediaRecorderRef.current = recorder;
                speechActive = true;
                utteranceStartedAt = now;
                lastSpeechAt = now;

                recorder.ondataavailable = (ev) => {
                  if (ev.data && ev.data.size > 0) {
                    chunks.push(ev.data);
                  }
                };

                recorder.onstop = async () => {
                  if (activeRecorder === recorder) {
                    activeRecorder = null;
                  }
                  if (mediaRecorderRef.current === recorder) {
                    mediaRecorderRef.current = null;
                  }
                  if (
                    discardChunk ||
                    recorderDisposed ||
                    pausedForTtsRef.current ||
                    chunks.length === 0
                  ) {
                    return;
                  }
                  transcribing = true;
                  try {
                    const blob = new Blob(chunks, { type: "audio/webm" });
                    const base64 = await blobToBase64(blob);
                    if (discardChunk || recorderDisposed || pausedForTtsRef.current) {
                      return;
                    }
                    const res = await transcribeAudio(base64, "cloud");
                    if (
                      !discardChunk &&
                      !recorderDisposed &&
                      !pausedForTtsRef.current &&
                      res.text.trim()
                    ) {
                      onTranscriptRef.current(res.text.trim(), true);
                    }
                  } catch {
                    // Graceful fallback if transcribe command fails
                  } finally {
                    transcribing = false;
                  }
                };

                recorder.start();
              };

              setListening(true);
              pollTimer = window.setInterval(() => {
                if (recorderDisposed || discardChunk || pausedForTtsRef.current) {
                  return;
                }
                const rms = computeAnalyserRms(analyser, floatBuf, byteBuf);
                const now = Date.now();
                const isSpeech = rms >= VAD_RMS_THRESHOLD;

                if (!speechActive) {
                  if (isSpeech && !activeRecorder && !transcribing) {
                    startUtteranceRecorder(now);
                  }
                  return;
                }

                if (isSpeech) {
                  lastSpeechAt = now;
                }

                const silenceElapsed = now - lastSpeechAt;
                const utteranceElapsed = now - utteranceStartedAt;
                if (
                  silenceElapsed >= VAD_SILENCE_MS ||
                  utteranceElapsed >= VAD_MAX_UTTERANCE_MS
                ) {
                  speechActive = false;
                  if (activeRecorder && activeRecorder.state !== "inactive") {
                    try {
                      activeRecorder.stop();
                    } catch {
                      // Ignore stop errors
                    }
                  }
                }
              }, VAD_POLL_INTERVAL_MS);

              return;
            }

            // Graceful manual-toggle fallback (whisper_cpp or cloud without AudioContext)
            const recorder = new MediaRecorder(mediaStream);
            const chunks: BlobPart[] = [];
            recorder.ondataavailable = (ev) => {
              if (ev.data && ev.data.size > 0) {
                chunks.push(ev.data);
              }
            };
            recorder.onstop = async () => {
              stopStreamTracks(stream);
              if (mediaRecorderRef.current === recorder) {
                mediaRecorderRef.current = null;
              }
              if (discardChunk || unmountedRef.current || chunks.length === 0) {
                return;
              }
              try {
                const blob = new Blob(chunks, { type: "audio/webm" });
                const base64 = await blobToBase64(blob);
                if (discardChunk || unmountedRef.current) {
                  return;
                }
                const res = await transcribeAudio(base64, sttEngine);
                if (!discardChunk && !unmountedRef.current && res.text.trim()) {
                  onTranscriptRef.current(res.text.trim(), true);
                }
              } catch {
                // Graceful fallback if transcribe command is unavailable
              }
            };
            mediaRecorderRef.current = recorder;
            recorder.start();
            setListening(true);
          })
          .catch(() => {
            setListening(false);
          });
      }

      return () => {
        recorderDisposed = true;
        // Discard chunks when paused for TTS, unmounted, or using continuous cloud VAD
        if (
          pausedForTtsRef.current ||
          unmountedRef.current ||
          audioCtx !== null
        ) {
          discardChunk = true;
        }
        if (pollTimer !== null) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
        if (
          mediaRecorderRef.current &&
          mediaRecorderRef.current.state !== "inactive"
        ) {
          try {
            mediaRecorderRef.current.stop();
          } catch {
            // Ignore cleanup errors
          }
        }
        if (audioCtx !== null) {
          mediaRecorderRef.current = null;
          stopStreamTracks(stream);
        } else if (!mediaRecorderRef.current) {
          stopStreamTracks(stream);
        }
        try {
          mediaSource?.disconnect();
        } catch {
          // Ignore disconnect errors
        }
        if (audioCtx && typeof audioCtx.close === "function") {
          void Promise.resolve(audioCtx.close()).catch(() => {});
        }
        setListening(false);
      };
    };

    if (wasPausedForTtsRef.current) {
      settleTimer = window.setTimeout(() => {
        if (effectDisposed || pausedForTtsRef.current) {
          return;
        }
        wasPausedForTtsRef.current = false;
        stopActiveInput = startActiveEngine();
      }, ECHO_SETTLE_DELAY_MS);
    } else {
      stopActiveInput = startActiveEngine();
    }

    return () => {
      effectDisposed = true;
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
      }
      stopActiveInput?.();
    };
  }, [voiceEnabled, sttEngine, pausedForTts]);

  const engineBadge =
    sttEngine === "whisper_cpp"
      ? "Whisper"
      : sttEngine === "cloud"
        ? "Cloud STT"
        : "Voice";

  const statusTitle = !voiceEnabled
    ? `${engineBadge}: Muted (click to enable)`
    : pausedForTts
      ? `${engineBadge}: Paused while GuideLens speaks (click to mute)`
      : `${engineBadge}: Active (click to mute)`;

  return (
    <button
      type="button"
      onClick={() => onToggleMute(!voiceEnabled)}
      aria-label={voiceEnabled ? "Mute voice input" : "Enable voice input"}
      aria-pressed={voiceEnabled}
      title={statusTitle}
      data-testid="voice-mute-toggle"
      data-paused-for-tts={pausedForTts ? "true" : "false"}
      data-speaking={speaking ? "true" : "false"}
      className={`relative flex items-center justify-center w-7 h-7 rounded-md transition-colors focus:outline-none focus:ring-1 focus:ring-[#38BDF8] ${
        voiceEnabled && pausedForTts
          ? "text-amber-300 bg-amber-400/15 hover:bg-amber-400/25"
          : voiceEnabled
            ? "text-[#38BDF8] bg-[#38BDF8]/15 hover:bg-[#38BDF8]/25"
            : "text-[#A1A1AA] hover:text-[#F4F4F5] hover:bg-white/5"
      }`}
    >
      {voiceEnabled && listening && !pausedForTts && (
        <span
          data-testid="voice-pulse-ring"
          className="absolute inset-0 rounded-md ring-1 ring-[#38BDF8]/60 animate-ping pointer-events-none"
        />
      )}
      {voiceEnabled ? (
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
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </svg>
      ) : (
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
          <line x1="2" x2="22" y1="2" y2="22" />
          <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
          <path d="M5 10v2a7 7 0 0 0 12 5" />
          <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </svg>
      )}
    </button>
  );
};
