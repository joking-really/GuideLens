import benchmarkSentences from "../vendor/tiny-voca/benchmark-sentences.json";
import { fromGGUF, type Phonemizer } from "../vendor/tiny-voca/dizione/engine.js";
import { limited, utterancesOf } from "../vendor/tiny-voca/text.js";
import { readGGUF, spent, TinyVoca } from "../vendor/tiny-voca/tiny-voca.js";
import type { TinyVocaVoice } from "../types";

export type WorkerInMessage =
  | { type: "load"; id?: number; modelUrl?: string }
  | {
      type: "speak";
      id: number;
      text: string;
      voice: TinyVocaVoice;
      speed?: number;
      pitchShift?: number;
      pitchRange?: number;
      modelUrl?: string;
    }
  | { type: "cancel"; id?: number }
  | { type: "benchmark"; id?: number; modelUrl?: string };

export type WorkerOutMessage =
  | { type: "status"; text: string; progress?: number }
  | {
      type: "ready";
      voices: TinyVocaVoice[];
      sampleRate: number;
      modelBytes: number;
      loadMs: number;
    }
  | {
      type: "sentence";
      id: number;
      index: number;
      total: number;
      phonemes: string;
      audio: Float32Array;
      sampleRate: number;
    }
  | {
      type: "done";
      id: number;
      cancelled: boolean;
      audio: Float32Array;
      sampleRate: number;
      durationSec: number;
      workSec: number;
      realtimeFactor: number;
      phonemes: string[];
    }
  | {
      type: "benchmark";
      id?: number;
      speed: number;
      summary: string;
      parts: string;
      lines: string[];
    }
  | { type: "error"; id?: number; message: string; plain?: boolean };

interface DedicatedWorkerScopeLike {
  location?: { origin?: string; href?: string };
  postMessage(message: WorkerOutMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerInMessage>) => void) | null;
}

const workerScope = self as unknown as DedicatedWorkerScopeLike;

let cachedVoca: TinyVoca | null = null;
let cachedPhonemizer: Phonemizer | null = null;
let cachedModelBytes = 0;
let cachedLoadMs = 0;
let loadPromise: Promise<void> | null = null;

let activeSpeakId: number | null = null;
const cancelledSpeakIds = new Set<number>();
let taskQueue: Promise<void> = Promise.resolve();

function post(message: WorkerOutMessage, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    workerScope.postMessage(message, transfer);
  } else {
    workerScope.postMessage(message);
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function resolveModelUrl(modelUrl?: string): string {
  const target = modelUrl || "/models/tiny-voca-js.gguf";
  const baseOrigin =
    typeof workerScope.location?.origin === "string" &&
    workerScope.location.origin !== "null"
      ? workerScope.location.origin
      : typeof workerScope.location?.href === "string"
        ? workerScope.location.href
        : "http://localhost";
  return new URL(target, baseOrigin).href;
}

async function fetchModelBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch voice model (${response.status}): ${url}`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !total) {
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    post({
      type: "status",
      text: "Loading offline voice model…",
      progress: Math.min(1, received / total),
    });
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}

async function ensureLoaded(modelUrl?: string): Promise<{
  voca: TinyVoca;
  phonemizer: Phonemizer;
}> {
  if (cachedVoca && cachedPhonemizer) {
    return { voca: cachedVoca, phonemizer: cachedPhonemizer };
  }

  if (!loadPromise) {
    loadPromise = (async () => {
      const started = performance.now();
      post({ type: "status", text: "Loading offline voice model…", progress: 0 });
      const resolvedUrl = resolveModelUrl(modelUrl);
      const buffer = await fetchModelBuffer(resolvedUrl);
      cachedModelBytes = buffer.byteLength;

      post({ type: "status", text: "Initializing voice engine…", progress: 1 });
      const file = readGGUF(buffer);
      const voca = new TinyVoca(file);
      const phonemizer = await fromGGUF(file);

      cachedVoca = voca;
      cachedPhonemizer = phonemizer;
      cachedLoadMs = Math.round(performance.now() - started);
    })().catch((err) => {
      loadPromise = null;
      throw err;
    });
  }

  await loadPromise;
  return {
    voca: cachedVoca as TinyVoca,
    phonemizer: cachedPhonemizer as Phonemizer,
  };
}

function getVoices(voca: TinyVoca): TinyVocaVoice[] {
  const valid = voca.voices.filter(
    (v): v is TinyVocaVoice => v === "M2" || v === "F2",
  );
  return valid.length > 0 ? valid : ["M2", "F2"];
}

function isSpeakCancelled(id: number): boolean {
  return cancelledSpeakIds.has(id);
}

async function runSpeak(
  msg: Extract<WorkerInMessage, { type: "speak" }>,
): Promise<void> {
  const { id } = msg;
  activeSpeakId = id;

  try {
    if (isSpeakCancelled(id)) {
      const empty = new Float32Array(0);
      post(
        {
          type: "done",
          id,
          cancelled: true,
          audio: empty,
          sampleRate: cachedVoca?.config.sample_rate ?? 24000,
          durationSec: 0,
          workSec: 0,
          realtimeFactor: 0,
          phonemes: [],
        },
        [empty.buffer],
      );
      return;
    }

    const { voca, phonemizer } = await ensureLoaded(msg.modelUrl);
    const sampleRate = voca.config.sample_rate;

    if (isSpeakCancelled(id)) {
      const empty = new Float32Array(0);
      post(
        {
          type: "done",
          id,
          cancelled: true,
          audio: empty,
          sampleRate,
          durationSec: 0,
          workSec: 0,
          realtimeFactor: 0,
          phonemes: [],
        },
        [empty.buffer],
      );
      return;
    }

    const limit = Math.max(16, voca.config.max_tokens - 12);
    const utterances = utterancesOf(msg.text, phonemizer, limit);

    if (utterances.length === 0) {
      const empty = new Float32Array(0);
      post(
        {
          type: "done",
          id,
          cancelled: false,
          audio: empty,
          sampleRate,
          durationSec: 0,
          workSec: 0,
          realtimeFactor: 0,
          phonemes: [],
        },
        [empty.buffer],
      );
      return;
    }

    const chunks: Float32Array[] = [];
    const phonemesList: string[] = [];
    let workSec = 0;

    for (let idx = 0; idx < utterances.length; idx++) {
      if (isSpeakCancelled(id)) {
        const empty = new Float32Array(0);
        post(
          {
            type: "done",
            id,
            cancelled: true,
            audio: empty,
            sampleRate,
            durationSec: 0,
            workSec,
            realtimeFactor: 0,
            phonemes: phonemesList,
          },
          [empty.buffer],
        );
        return;
      }

      const utt = utterances[idx];
      const t0 = performance.now();
      const { audio } = voca.synthesize(utt.ids, utt.stress, {
        voice: msg.voice,
        speed: msg.speed ?? 1.0,
        pitchShift: msg.pitchShift ?? 0.0,
        pitchRange: msg.pitchRange ?? 1.0,
        seed: idx,
      });
      workSec += (performance.now() - t0) / 1000;

      chunks.push(audio);
      phonemesList.push(utt.phonemes);

      // Clone before peak-limiting so `chunks` keeps an un-detached buffer for final assembly
      const heard = limited(audio.slice());
      post(
        {
          type: "sentence",
          id,
          index: idx,
          total: utterances.length,
          phonemes: utt.phonemes,
          audio: heard,
          sampleRate,
        },
        [heard.buffer],
      );

      // Yield between sentences so incoming cancel messages execute before the next synthesis
      await yieldToEventLoop();
      if (isSpeakCancelled(id)) {
        const empty = new Float32Array(0);
        post(
          {
            type: "done",
            id,
            cancelled: true,
            audio: empty,
            sampleRate,
            durationSec: 0,
            workSec,
            realtimeFactor: 0,
            phonemes: phonemesList,
          },
          [empty.buffer],
        );
        return;
      }
    }

    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const finalAudio = limited(combined);
    const durationSec = finalAudio.length / sampleRate;
    const realtimeFactor = workSec > 0 ? durationSec / workSec : 0;

    post(
      {
        type: "done",
        id,
        cancelled: false,
        audio: finalAudio,
        sampleRate,
        durationSec,
        workSec,
        realtimeFactor,
        phonemes: phonemesList,
      },
      [finalAudio.buffer],
    );
  } finally {
    if (activeSpeakId === id) {
      activeSpeakId = null;
    }
    cancelledSpeakIds.delete(id);
  }
}

async function runBenchmark(
  msg: Extract<WorkerInMessage, { type: "benchmark" }>,
): Promise<void> {
  const { voca } = await ensureLoaded(msg.modelUrl);

  for (const key of Object.keys(spent)) {
    delete spent[key];
  }

  const lines: string[] = [];
  let audioSeconds = 0;
  let workSeconds = 0;
  const voices = getVoices(voca);
  const sentences = benchmarkSentences as Array<{
    ids: number[];
    stress: number[];
  }>;

  for (let number = 0; number < sentences.length; number++) {
    const { ids, stress } = sentences[number];
    for (const voice of voices) {
      const started = performance.now();
      const { audio } = voca.synthesize(ids, stress, { voice });
      const elapsedSec = Math.max((performance.now() - started) / 1000, 1e-6);
      const seconds = audio.length / voca.config.sample_rate;
      audioSeconds += seconds;
      workSeconds += elapsedSec;
      lines.push(
        `sentence ${number} ${voice}: ${seconds.toFixed(2)} s in ${elapsedSec.toFixed(2)} s = ${(seconds / elapsedSec).toFixed(1)}x`,
      );
      await yieldToEventLoop();
    }
  }

  const totalSpent = Object.values(spent).reduce((a, b) => a + b, 0);
  const parts =
    totalSpent > 0
      ? Object.entries(spent)
          .sort((a, b) => b[1] - a[1])
          .map(([name, ms]) => `${name} ${((100 * ms) / totalSpent).toFixed(0)}%`)
          .join(", ")
      : "";
  const speed = workSeconds > 0 ? audioSeconds / workSeconds : 0;
  const summary = `${audioSeconds.toFixed(1)} s of audio in ${workSeconds.toFixed(2)} s = ${speed.toFixed(1)} times real time`;

  post({
    type: "benchmark",
    id: msg.id,
    speed,
    summary,
    parts,
    lines,
  });
}

workerScope.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "cancel") {
    if (typeof data.id === "number") {
      cancelledSpeakIds.add(data.id);
    } else if (activeSpeakId !== null) {
      cancelledSpeakIds.add(activeSpeakId);
    }
    return;
  }

  if (data.type === "load") {
    taskQueue = taskQueue.then(async () => {
      try {
        const { voca } = await ensureLoaded(data.modelUrl);
        post({
          type: "ready",
          voices: getVoices(voca),
          sampleRate: voca.config.sample_rate,
          modelBytes: cachedModelBytes,
          loadMs: cachedLoadMs,
        });
      } catch (err) {
        post({
          type: "error",
          id: data.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return;
  }

  if (data.type === "speak") {
    if (activeSpeakId !== null && activeSpeakId !== data.id) {
      cancelledSpeakIds.add(activeSpeakId);
    }
    taskQueue = taskQueue.then(async () => {
      try {
        await runSpeak(data);
      } catch (err) {
        post({
          type: "error",
          id: data.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return;
  }

  if (data.type === "benchmark") {
    taskQueue = taskQueue.then(async () => {
      try {
        await runBenchmark(data);
      } catch (err) {
        post({
          type: "error",
          id: data.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }
};
