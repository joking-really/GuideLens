import React, { useEffect, useRef, useState } from "react";
import { transcribeAudio } from "../lib/ipc";
import type { SttEngine } from "../types";

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
  onToggleMute: (nextEnabled: boolean) => void;
  onTranscript: (text: string, isFinal: boolean) => void;
}

export const VoiceIndicator: React.FC<VoiceIndicatorProps> = ({
  voiceEnabled,
  sttEngine,
  onToggleMute,
  onTranscript,
}) => {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    if (!voiceEnabled) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // Ignore stop errors
        }
        recognitionRef.current = null;
      }
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // Ignore stop errors
        }
      }
      setListening(false);
      return;
    }

    if (sttEngine === "web_speech") {
      const Ctor =
        typeof window !== "undefined"
          ? window.SpeechRecognition || window.webkitSpeechRecognition
          : undefined;
      if (!Ctor) {
        setListening(false);
        return;
      }

      let disposed = false;
      let hadError = false;
      try {
        const recognition = new Ctor();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "en-US";

        recognition.onresult = (event: SpeechRecognitionEvent) => {
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
          // In continuous mode, WebView2 may end after prolonged silence; gently restart if still enabled and no error
          if (!disposed && !hadError && voiceEnabled) {
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
        disposed = true;
        if (recognitionRef.current) {
          try {
            recognitionRef.current.stop();
          } catch {
            // Ignore cleanup errors
          }
          recognitionRef.current = null;
        }
      };
    }

    // Optional whisper_cpp or cloud STT path via MediaRecorder
    let cancelled = false;
    let stream: MediaStream | null = null;

    if (
      typeof navigator !== "undefined" &&
      navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== "undefined"
    ) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((mediaStream) => {
          if (cancelled) {
            mediaStream.getTracks().forEach((t) => t.stop());
            return;
          }
          stream = mediaStream;
          const recorder = new MediaRecorder(mediaStream);
          const chunks: BlobPart[] = [];
          recorder.ondataavailable = (ev) => {
            if (ev.data.size > 0) chunks.push(ev.data);
          };
          recorder.onstop = async () => {
            stream?.getTracks().forEach((t) => t.stop());
            if (chunks.length === 0 || cancelled) return;
            try {
              const blob = new Blob(chunks, { type: "audio/webm" });
              const buffer = await blob.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = "";
              for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              const base64 = btoa(binary);
              const res = await transcribeAudio(base64, sttEngine);
              if (res.text.trim()) {
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
      cancelled = true;
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
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [voiceEnabled, sttEngine]);

  const engineBadge =
    sttEngine === "whisper_cpp"
      ? "Whisper"
      : sttEngine === "cloud"
        ? "Cloud STT"
        : "Voice";

  return (
    <button
      type="button"
      onClick={() => onToggleMute(!voiceEnabled)}
      aria-label={voiceEnabled ? "Mute voice input" : "Enable voice input"}
      aria-pressed={voiceEnabled}
      title={`${engineBadge}: ${voiceEnabled ? "Active (click to mute)" : "Muted (click to enable)"}`}
      data-testid="voice-mute-toggle"
      className={`relative flex items-center justify-center w-7 h-7 rounded-md transition-colors focus:outline-none focus:ring-1 focus:ring-[#38BDF8] ${
        voiceEnabled
          ? "text-[#38BDF8] bg-[#38BDF8]/15 hover:bg-[#38BDF8]/25"
          : "text-[#A1A1AA] hover:text-[#F4F4F5] hover:bg-white/5"
      }`}
    >
      {voiceEnabled && listening && (
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
