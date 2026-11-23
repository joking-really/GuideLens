import type { TinyVocaVoice } from "../types";
import { limited, wav } from "../vendor/tiny-voca/text.js";
import type {
  WorkerInMessage,
  WorkerOutMessage,
} from "../workers/tinyVoca.worker";
import { type AudioContextLike, LivePlayer } from "./livePlayer";

export type { TinyVocaVoice };

export type TinyVocaSpeakOptions = {
  voice: TinyVocaVoice;
  speed?: number;
  pitchShift?: number;
  pitchRange?: number;
  onSentence?: (info: {
    index: number;
    total: number;
    phonemes: string;
  }) => void;
};

export type TinyVocaSpeakResult = {
  cancelled: boolean;
  audio: Float32Array;
  sampleRate: number;
  durationSec: number;
  workSec: number;
  realtimeFactor: number;
  phonemes: string[];
};

export type TinyVocaBenchmarkResult = {
  speed: number;
  summary: string;
  parts: string;
  lines: string[];
};

export type TinyVocaState = {
  status: "idle" | "loading" | "ready" | "speaking" | "error";
  speaking: boolean;
  voices: TinyVocaVoice[];
  sampleRate: number;
  modelBytes: number;
  loadMs: number;
  error: string | null;
};

export interface WorkerLike {
  onmessage: ((event: MessageEvent<WorkerOutMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: WorkerInMessage, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface TinyVocaClientOptions {
  modelUrl?: string;
  workerFactory?: () => WorkerLike;
  audioContextFactory?: () => AudioContextLike | null;
}

interface PendingSpeak {
  id: number;
  opts: TinyVocaSpeakOptions;
  cancelled: boolean;
  phonemes: string[];
  resolve: (result: TinyVocaSpeakResult) => void;
  reject: (err: Error) => void;
}

interface PendingBenchmark {
  id: number;
  resolve: (result: TinyVocaBenchmarkResult) => void;
  reject: (err: Error) => void;
}

const DEFAULT_MODEL_PATH = "/models/tiny-voca-js.gguf";

function resolveDefaultModelUrl(): string {
  if (
    typeof window !== "undefined" &&
    window.location &&
    typeof window.location.href === "string"
  ) {
    try {
      return new URL(DEFAULT_MODEL_PATH, window.location.href).href;
    } catch {
      // Fall back to relative path below
    }
  }
  return DEFAULT_MODEL_PATH;
}

function createBrowserAudioContext(): AudioContextLike | null {
  if (typeof window === "undefined") {
    return null;
  }
  const ctor =
    (
      window as unknown as {
        AudioContext?: new () => AudioContextLike;
        webkitAudioContext?: new () => AudioContextLike;
      }
    ).AudioContext ??
    (
      window as unknown as {
        webkitAudioContext?: new () => AudioContextLike;
      }
    ).webkitAudioContext;

  if (!ctor) {
    return null;
  }
  try {
    return new ctor();
  } catch {
    return null;
  }
}

export function encodeWavBlob(
  samples: Float32Array,
  sampleRate: number,
): Blob {
  const safeSamples = limited(samples);
  const buffer = wav(safeSamples, sampleRate);
  return new Blob([buffer], { type: "audio/wav" });
}

export class TinyVocaClient {
  private readonly modelUrl: string;
  private readonly workerFactory?: () => WorkerLike;
  private readonly audioContextFactory: () => AudioContextLike | null;
  private readonly listeners = new Set<(state: TinyVocaState) => void>();

  private worker: WorkerLike | null = null;
  private audioContext: AudioContextLike | null = null;
  private player: LivePlayer | null = null;
  private modelReady = false;
  private loadPromise: Promise<void> | null = null;
  private resolveLoad: (() => void) | null = null;
  private rejectLoad: ((err: Error) => void) | null = null;

  private nextRequestId = 1;
  private activeSpeak: PendingSpeak | null = null;
  private pendingBenchmark: PendingBenchmark | null = null;
  private fallbackSource: { stop: () => void; onended: (() => void) | null } | null =
    null;

  private state: TinyVocaState = {
    status: "idle",
    speaking: false,
    voices: ["M2", "F2"],
    sampleRate: 24000,
    modelBytes: 0,
    loadMs: 0,
    error: null,
  };

  constructor(options: TinyVocaClientOptions = {}) {
    this.modelUrl = options.modelUrl ?? resolveDefaultModelUrl();
    this.workerFactory = options.workerFactory;
    this.audioContextFactory =
      options.audioContextFactory ?? createBrowserAudioContext;
  }

  getState(): TinyVocaState {
    return {
      ...this.state,
      voices: [...this.state.voices],
    };
  }

  subscribe(listener: (state: TinyVocaState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<TinyVocaState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) {
      return this.worker;
    }

    let worker: WorkerLike;
    if (this.workerFactory) {
      worker = this.workerFactory();
    } else {
      if (typeof Worker === "undefined") {
        throw new Error("Offline voice engine requires Web Worker support");
      }
      worker = new Worker(
        new URL("../workers/tinyVoca.worker.ts", import.meta.url),
        { type: "module" },
      );
    }

    worker.onmessage = (event) => {
      this.handleWorkerMessage(event.data);
    };
    worker.onerror = (event) => {
      const msg = event.message || "Voice worker encountered an error";
      this.handleWorkerFailure(new Error(msg));
    };

    this.worker = worker;
    return worker;
  }

  private ensurePlayer(): LivePlayer | null {
    if (this.player) {
      return this.player;
    }
    const ctx = this.audioContext ?? this.audioContextFactory();
    if (!ctx) {
      return null;
    }
    this.audioContext = ctx;
    this.player = new LivePlayer(ctx, (playing) => {
      const synthesisActive = Boolean(
        this.activeSpeak && !this.activeSpeak.cancelled,
      );
      const isSpeaking = playing || synthesisActive || Boolean(this.fallbackSource);
      if (this.state.speaking !== isSpeaking) {
        this.setState({
          speaking: isSpeaking,
          status: isSpeaking
            ? "speaking"
            : this.modelReady
              ? "ready"
              : this.state.status === "error"
                ? "error"
                : "idle",
        });
      }
    });
    return this.player;
  }

  private stopFallbackAudio(): void {
    if (this.fallbackSource) {
      this.fallbackSource.onended = null;
      try {
        this.fallbackSource.stop();
      } catch {
        // Ignore already-stopped source
      }
      this.fallbackSource = null;
    }
  }

  private playFallbackClip(samples: Float32Array, sampleRate: number): boolean {
    if (!this.audioContext || !samples.length) {
      return false;
    }
    try {
      this.stopFallbackAudio();
      const buffer = this.audioContext.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.onended = () => {
        if (this.fallbackSource === source) {
          this.fallbackSource = null;
          if (!this.activeSpeak && !this.player?.playing) {
            this.setState({
              speaking: false,
              status: this.modelReady ? "ready" : "idle",
            });
          }
        }
      };
      this.fallbackSource = source;
      source.start(this.audioContext.currentTime);
      return true;
    } catch {
      this.fallbackSource = null;
      return false;
    }
  }

  private handleWorkerFailure(err: Error): void {
    this.modelReady = false;
    this.loadPromise = null;
    if (this.rejectLoad) {
      const reject = this.rejectLoad;
      this.resolveLoad = null;
      this.rejectLoad = null;
      reject(err);
    }
    if (this.activeSpeak) {
      const pending = this.activeSpeak;
      this.activeSpeak = null;
      pending.reject(err);
    }
    if (this.pendingBenchmark) {
      const bench = this.pendingBenchmark;
      this.pendingBenchmark = null;
      bench.reject(err);
    }
    this.player?.stop();
    this.stopFallbackAudio();
    this.setState({
      status: "error",
      speaking: false,
      error: err.message,
    });
  }

  private handleWorkerMessage(msg: WorkerOutMessage): void {
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "status": {
        if (!this.modelReady) {
          this.setState({ status: "loading", error: null });
        }
        break;
      }
      case "ready": {
        this.modelReady = true;
        this.setState({
          status: this.state.speaking ? "speaking" : "ready",
          voices: msg.voices,
          sampleRate: msg.sampleRate,
          modelBytes: msg.modelBytes,
          loadMs: msg.loadMs,
          error: null,
        });
        if (this.resolveLoad) {
          const resolve = this.resolveLoad;
          this.resolveLoad = null;
          this.rejectLoad = null;
          resolve();
        }
        break;
      }
      case "sentence": {
        const pending = this.activeSpeak;
        if (!pending || pending.id !== msg.id || pending.cancelled) {
          return;
        }
        pending.phonemes.push(msg.phonemes);
        this.player?.add(msg.audio, msg.sampleRate);
        pending.opts.onSentence?.({
          index: msg.index,
          total: msg.total,
          phonemes: msg.phonemes,
        });
        break;
      }
      case "done": {
        const pending = this.activeSpeak;
        if (!pending || pending.id !== msg.id) {
          return;
        }
        this.activeSpeak = null;

        const player = this.player;
        const playedStreaming = player ? player.end() : false;
        let playingFallback = false;
        if (player && !playedStreaming && !msg.cancelled && msg.audio.length > 0) {
          playingFallback = this.playFallbackClip(msg.audio, msg.sampleRate);
        }

        const stillPlaying =
          !msg.cancelled && (Boolean(player?.playing) || playingFallback);
        this.setState({
          speaking: stillPlaying,
          status: stillPlaying ? "speaking" : "ready",
          error: null,
        });

        pending.resolve({
          cancelled: msg.cancelled,
          audio: msg.audio,
          sampleRate: msg.sampleRate,
          durationSec: msg.durationSec,
          workSec: msg.workSec,
          realtimeFactor: msg.realtimeFactor,
          phonemes: msg.phonemes.length > 0 ? msg.phonemes : pending.phonemes,
        });
        break;
      }
      case "benchmark": {
        const bench = this.pendingBenchmark;
        if (bench && (msg.id === undefined || bench.id === msg.id)) {
          this.pendingBenchmark = null;
          bench.resolve({
            speed: msg.speed,
            summary: msg.summary,
            parts: msg.parts,
            lines: msg.lines,
          });
        }
        break;
      }
      case "error": {
        const err = new Error(msg.message || "Voice synthesis failed");
        if (
          this.activeSpeak &&
          (msg.id === undefined || this.activeSpeak.id === msg.id)
        ) {
          const pending = this.activeSpeak;
          this.activeSpeak = null;
          this.player?.stop();
          this.stopFallbackAudio();
          this.setState({
            status: "error",
            speaking: false,
            error: err.message,
          });
          pending.reject(err);
          return;
        }
        if (
          this.pendingBenchmark &&
          (msg.id === undefined || this.pendingBenchmark.id === msg.id)
        ) {
          const bench = this.pendingBenchmark;
          this.pendingBenchmark = null;
          this.setState({
            status: "error",
            speaking: false,
            error: err.message,
          });
          bench.reject(err);
          return;
        }
        this.handleWorkerFailure(err);
        break;
      }
    }
  }

  async load(): Promise<void> {
    if (this.modelReady) {
      return;
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }

    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.setState({
        status: "error",
        speaking: false,
        error: error.message,
      });
      return Promise.reject(error);
    }

    this.setState({ status: "loading", error: null });
    this.loadPromise = new Promise<void>((resolve, reject) => {
      this.resolveLoad = resolve;
      this.rejectLoad = reject;
    });

    worker.postMessage({
      type: "load",
      id: this.nextRequestId++,
      modelUrl: this.modelUrl,
    });

    return this.loadPromise;
  }

  async speak(
    text: string,
    opts: TinyVocaSpeakOptions,
  ): Promise<TinyVocaSpeakResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return {
        cancelled: false,
        audio: new Float32Array(0),
        sampleRate: this.state.sampleRate,
        durationSec: 0,
        workSec: 0,
        realtimeFactor: 0,
        phonemes: [],
      };
    }

    this.stop();

    const speakId = this.nextRequestId++;
    const player = this.ensurePlayer();
    player?.begin();

    await this.load();

    const worker = this.ensureWorker();
    this.setState({ status: "speaking", speaking: true, error: null });

    return new Promise<TinyVocaSpeakResult>((resolve, reject) => {
      this.activeSpeak = {
        id: speakId,
        opts,
        cancelled: false,
        phonemes: [],
        resolve,
        reject,
      };
      worker.postMessage({
        type: "speak",
        id: speakId,
        text: trimmed,
        voice: opts.voice,
        speed: opts.speed ?? 1.0,
        pitchShift: opts.pitchShift ?? 0.0,
        pitchRange: opts.pitchRange ?? 1.0,
        modelUrl: this.modelUrl,
      });
    });
  }

  stop(): void {
    this.stopFallbackAudio();
    this.player?.stop();

    if (this.activeSpeak) {
      const pending = this.activeSpeak;
      pending.cancelled = true;
      this.activeSpeak = null;
      this.worker?.postMessage({ type: "cancel", id: pending.id });
      pending.resolve({
        cancelled: true,
        audio: new Float32Array(0),
        sampleRate: this.state.sampleRate,
        durationSec: 0,
        workSec: 0,
        realtimeFactor: 0,
        phonemes: pending.phonemes,
      });
    } else {
      this.worker?.postMessage({ type: "cancel" });
    }

    this.setState({
      speaking: false,
      status: this.modelReady
        ? "ready"
        : this.state.status === "error"
          ? "error"
          : "idle",
    });
  }

  async benchmark(): Promise<TinyVocaBenchmarkResult> {
    await this.load();
    const worker = this.ensureWorker();
    const benchId = this.nextRequestId++;

    if (this.pendingBenchmark) {
      this.pendingBenchmark.reject(new Error("Superseded by newer benchmark"));
      this.pendingBenchmark = null;
    }

    return new Promise<TinyVocaBenchmarkResult>((resolve, reject) => {
      this.pendingBenchmark = { id: benchId, resolve, reject };
      worker.postMessage({
        type: "benchmark",
        id: benchId,
        modelUrl: this.modelUrl,
      });
    });
  }

  dispose(): void {
    this.stop();
    if (this.rejectLoad) {
      const reject = this.rejectLoad;
      this.resolveLoad = null;
      this.rejectLoad = null;
      reject(new Error("Voice client disposed"));
    }
    if (this.pendingBenchmark) {
      const bench = this.pendingBenchmark;
      this.pendingBenchmark = null;
      bench.reject(new Error("Voice client disposed"));
    }
    this.worker?.terminate();
    this.worker = null;
    this.modelReady = false;
    this.loadPromise = null;
    if (this.audioContext?.close) {
      Promise.resolve(this.audioContext.close()).catch(() => {});
    }
    this.audioContext = null;
    this.player = null;
    this.setState({
      status: "idle",
      speaking: false,
      error: null,
    });
  }
}

let sharedEngine: TinyVocaClient | null = null;

export function getCopilotVoiceEngine(): TinyVocaClient {
  if (!sharedEngine) {
    sharedEngine = new TinyVocaClient();
  }
  return sharedEngine;
}
