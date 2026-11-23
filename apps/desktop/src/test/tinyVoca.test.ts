import { afterEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => {
  const listeners: Record<string, ((ev: { payload: unknown }) => void)[]> = {};
  const emitWindow = vi.fn(async () => {});
  const setTitleWindow = vi.fn(async () => {});
  const unminimizeWindow = vi.fn(async () => {});
  const showWindow = vi.fn(async () => {});
  const setFocusWindow = vi.fn(async () => {});
  const createdWindows: Array<{ label: string; options: Record<string, unknown> }> = [];
  let existingSettingsWindow: Record<string, unknown> | null = null;

  return {
    listeners,
    emitWindow,
    setTitleWindow,
    unminimizeWindow,
    showWindow,
    setFocusWindow,
    createdWindows,
    setExistingSettingsWindow(win: Record<string, unknown> | null) {
      existingSettingsWindow = win;
    },
    getExistingSettingsWindow() {
      return existingSettingsWindow;
    },
    invoke: vi.fn(async () => ({})),
    listen: vi.fn(async (event: string, cb: (ev: { payload: unknown }) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
      return () => {
        listeners[event] = (listeners[event] || []).filter((fn) => fn !== cb);
      };
    }),
    emitEvent(event: string, payload: unknown) {
      for (const cb of listeners[event] || []) {
        cb({ payload });
      }
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setSize: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
    startDragging: vi.fn(async () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    innerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    onMoved: vi.fn(async () => () => {}),
    close: vi.fn(async () => {}),
  }),
  LogicalSize: class {},
  PhysicalPosition: class {},
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    constructor(label: string, options: Record<string, unknown>) {
      tauriMocks.createdWindows.push({ label, options });
    }
    static async getByLabel() {
      return tauriMocks.getExistingSettingsWindow();
    }
    once(event: string, cb: () => void) {
      if (event === "tauri://created") {
        queueMicrotask(cb);
      }
    }
  },
}));

import {
  getSettings,
  normalizeAskResponse,
  onSettingsRoute,
  onStepChanged,
  openSettingsWindow,
} from "../lib/ipc";
import {
  type AudioBufferLike,
  type AudioContextLike,
  LEAD,
  LivePlayer,
} from "../lib/livePlayer";
import {
  formatErrorForSpeech,
  formatStepForSpeech,
  matchVoiceCommand,
} from "../lib/speechText";
import {
  encodeWavBlob,
  getCopilotVoiceEngine,
  TinyVocaClient,
  type WorkerLike,
} from "../lib/tinyVocaClient";
import { DEFAULT_SETTINGS, type ResolvedStep } from "../types";
import { fromGGUF } from "../vendor/tiny-voca/dizione/engine.js";
import { utterancesOf } from "../vendor/tiny-voca/text.js";
import { readGGUF, TinyVoca } from "../vendor/tiny-voca/tiny-voca.js";

function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then((buf) => new Uint8Array(buf));
  }
  return new Promise((resolveBytes, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolveBytes(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function createMockAudioContext() {
  const scheduled: Array<{
    when: number;
    length: number;
    rate: number;
    stopped: boolean;
    source: {
      buffer: AudioBufferLike | null;
      onended: ((this: unknown, ev?: unknown) => unknown) | null;
      connect: ReturnType<typeof vi.fn>;
      start: (when?: number) => void;
      stop: () => void;
    };
  }> = [];
  let state = "suspended";

  const ctx: AudioContextLike & {
    scheduled: typeof scheduled;
    setState: (next: string) => void;
  } = {
    get state() {
      return state;
    },
    currentTime: 10,
    destination: {},
    scheduled,
    setState(next: string) {
      state = next;
    },
    resume: vi.fn(async () => {
      state = "running";
    }),
    createBuffer: (_channels: number, length: number, rate: number) => {
      const data = new Float32Array(length);
      return {
        getChannelData: () => data,
        length,
        rate,
      };
    },
    createBufferSource: () => {
      const entry = {
        when: 0,
        length: 0,
        rate: 24000,
        stopped: false,
        source: {
          buffer: null as AudioBufferLike | null,
          onended: null as ((this: unknown, ev?: unknown) => unknown) | null,
          connect: vi.fn(),
          start: (when = 0) => {
            entry.when = when;
            const buf = entry.source.buffer as { length: number; rate: number } | null;
            if (buf) {
              entry.length = buf.length;
              entry.rate = buf.rate;
            }
          },
          stop: () => {
            entry.stopped = true;
          },
        },
      };
      scheduled.push(entry);
      return entry.source;
    },
    close: vi.fn(async () => {}),
  };

  return ctx;
}

async function withNodeWebStreamGlobals<T>(fn: () => Promise<T>): Promise<T> {
  const bufMod = "node:buffer";
  const webStreamMod = "node:stream/web";
  const { Blob: NodeBlob } = (await import(/* @vite-ignore */ bufMod)) as {
    Blob: typeof Blob;
  };
  const { DecompressionStream: NodeDecompressionStream } = (await import(
    /* @vite-ignore */ webStreamMod
  )) as {
    DecompressionStream: unknown;
  };

  const prevBlob = globalThis.Blob;
  const prevDecomp = (globalThis as Record<string, unknown>).DecompressionStream;
  const prevResponse = (globalThis as Record<string, unknown>).Response;

  // jsdom's Blob may omit .stream(); temporarily bridge Node web streams for gunzip inside fromGGUF
  if (typeof new globalThis.Blob([]).stream !== "function") {
    (globalThis as Record<string, unknown>).Blob = NodeBlob;
  }
  if (typeof prevDecomp === "undefined") {
    (globalThis as Record<string, unknown>).DecompressionStream =
      NodeDecompressionStream;
  }
  if (typeof prevResponse === "undefined") {
    (globalThis as Record<string, unknown>).Response = class {
      constructor(private readonly body: ReadableStream<Uint8Array>) {}
      async arrayBuffer(): Promise<ArrayBuffer> {
        const reader = this.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.byteLength;
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.byteLength;
        }
        return out.buffer;
      }
    };
  }

  try {
    return await fn();
  } finally {
    (globalThis as Record<string, unknown>).Blob = prevBlob;
    (globalThis as Record<string, unknown>).DecompressionStream = prevDecomp;
    (globalThis as Record<string, unknown>).Response = prevResponse;
  }
}

async function readModelBytes(): Promise<Uint8Array> {
  const fsMod = "node:fs";
  const pathMod = "node:path";
  const { readFileSync } = (await import(/* @vite-ignore */ fsMod)) as {
    readFileSync: (path: string) => Uint8Array;
  };
  const { resolve } = (await import(/* @vite-ignore */ pathMod)) as {
    resolve: (...segments: string[]) => string;
  };
  const cwd = (
    globalThis as unknown as { process: { cwd(): string } }
  ).process.cwd();
  return readFileSync(resolve(cwd, "public/models/tiny-voca-js.gguf"));
}

describe("tiny-voca real GGUF synthesis", () => {
  it("loads tiny-voca-js.gguf and synthesizes non-silent 24 kHz waveforms for M2 and F2", async () => {
    const rawBytes = await readModelBytes();
    expect(rawBytes.byteLength).toBe(7_988_384);
    expect(String.fromCharCode(...rawBytes.subarray(0, 4))).toBe("GGUF");

    await withNodeWebStreamGlobals(async () => {
      const arrayBuf = Uint8Array.from(rawBytes).buffer;
      const gguf = readGGUF(arrayBuf);
      const voca = new TinyVoca(gguf);
      const phonemizer = await fromGGUF(gguf);

      expect(voca.config.sample_rate).toBe(24000);
      expect(voca.voices).toEqual(expect.arrayContaining(["F2", "M2"]));

      const utterances = utterancesOf(
        "Click the Export button I highlighted on your screen.",
        phonemizer,
        voca.config.max_tokens - 12,
      );
      expect(utterances.length).toBeGreaterThan(0);

      for (const voice of ["M2", "F2"] as const) {
        const res = voca.synthesize(utterances[0].ids, utterances[0].stress, {
          voice,
          speed: 1.0,
          pitchShift: 0.0,
          seed: 0,
        });
        expect(res.audio).toBeInstanceOf(Float32Array);
        expect(res.audio.length).toBeGreaterThan(voca.config.sample_rate * 0.5);

        let peak = 0;
        let energy = 0;
        for (let i = 0; i < res.audio.length; i++) {
          const s = res.audio[i];
          expect(Number.isFinite(s)).toBe(true);
          peak = Math.max(peak, Math.abs(s));
          energy += s * s;
        }
        const rms = Math.sqrt(energy / res.audio.length);
        expect(peak).toBeGreaterThan(0.05);
        expect(rms).toBeGreaterThan(0.005);
      }

      // Verify speed & pitchShift parameters meaningfully affect synthesis
      const slow = voca.synthesize(utterances[0].ids, utterances[0].stress, {
        voice: "M2",
        speed: 0.8,
        pitchShift: -0.2,
      });
      const fast = voca.synthesize(utterances[0].ids, utterances[0].stress, {
        voice: "M2",
        speed: 1.3,
        pitchShift: 0.2,
      });
      expect(slow.audio.length).toBeGreaterThan(fast.audio.length);

      const avgF0 = (f0: Float32Array) =>
        f0.reduce((sum, v) => sum + v, 0) / Math.max(f0.length, 1);
      expect(avgF0(fast.f0)).toBeGreaterThan(avgF0(slow.f0));
    });
  });

  it("loads model via worker message flow and aborts multi-sentence speak on cancel", async () => {
    const rawBytes = await readModelBytes();
    const arrayBuf = Uint8Array.from(rawBytes).buffer;

    const origPostMessage = window.postMessage;
    const origOnMessage = window.onmessage;
    const origFetch = globalThis.fetch;

    const posted: Array<{ type: string; [key: string]: unknown }> = [];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => arrayBuf.slice(0),
    }));

    await withNodeWebStreamGlobals(async () => {
      try {
        (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
        (window as unknown as { postMessage: unknown }).postMessage = (
          msg: { type: string; [key: string]: unknown },
        ) => {
          posted.push(msg);
          if (msg.type === "sentence" && msg.id === 2 && msg.index === 0) {
            window.onmessage?.({
              data: { type: "cancel", id: 2 },
            } as MessageEvent);
          }
        };

        await import("../workers/tinyVoca.worker");

        // Trigger load and wait for ready message
        window.onmessage?.({
          data: { type: "load", id: 1, modelUrl: "/models/tiny-voca-js.gguf" },
        } as MessageEvent);

        await vi.waitFor(
          () => {
            expect(posted.some((m) => m.type === "ready")).toBe(true);
          },
          { timeout: 10000 },
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
          new URL("/models/tiny-voca-js.gguf", window.location.origin).href,
        );

        // Trigger two-sentence speak; postMessage spy sends cancel as soon as sentence 0 arrives
        posted.length = 0;
        window.onmessage?.({
          data: {
            type: "speak",
            id: 2,
            text: "First, click File. Second, click Export.",
            voice: "M2",
            speed: 1.0,
          },
        } as MessageEvent);

        await vi.waitFor(
          () => {
            expect(
              posted.some((m) => m.type === "done" && m.id === 2),
            ).toBe(true);
          },
          { timeout: 10000 },
        );

        const doneMsg = posted.find((m) => m.type === "done" && m.id === 2);
        expect(doneMsg?.cancelled).toBe(true);
        expect(
          posted.filter((m) => m.type === "sentence" && m.id === 2),
        ).toHaveLength(1);
      } finally {
        (window as unknown as { postMessage: unknown }).postMessage =
          origPostMessage;
        window.onmessage = origOnMessage;
        (globalThis as unknown as { fetch: unknown }).fetch = origFetch;
      }
    });
  });
});

describe("encodeWavBlob", () => {
  it("encodes valid RIFF/WAVE 16-bit mono PCM bytes and limits peaks above 0.99", async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1.5, -1.5, 0.25]);
    const blob = encodeWavBlob(samples, 24000);

    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + samples.length * 2);

    const bytes = await readBlobBytes(blob);
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    const ascii = (start: number, len: number) =>
      String.fromCharCode(...bytes.subarray(start, start + len));

    expect(ascii(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(28, true)).toBe(48000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);

    // Peak limiting keeps max int16 amplitude <= Math.round(0.99 * 32767)
    const peakSample = view.getInt16(44 + 3 * 2, true);
    expect(peakSample).toBeLessThanOrEqual(Math.round(0.99 * 32767) + 1);
    expect(peakSample).toBeGreaterThan(30000);
  });
});

describe("speechText conversational formatter and voice commands", () => {
  it("prefers spoken_text when provided and adds highlight note on step 1 without duplicating", () => {
    const stepWithCue: ResolvedStep = {
      step_number: 1,
      instruction_line: "Click Object Selection Tool (W)",
      spoken_text: "Click the Object Selection Tool I highlighted on the left.",
      confidence: 0.92,
      rect_px: { x: 40, y: 180, w: 32, h: 32 },
      source: "uia",
    };

    const out = formatStepForSpeech(stepWithCue, {
      mode: "guide",
      index: 0,
      total: 3,
      hasHighlight: true,
    });
    expect(out).toBe(
      "First, click the Object Selection Tool I highlighted on the left.",
    );

    const stepAlreadyCadenced: ResolvedStep = {
      ...stepWithCue,
      spoken_text: "First, click the Export button.",
    };
    const out2 = formatStepForSpeech(stepAlreadyCadenced, {
      mode: "guide",
      index: 0,
      total: 2,
      hasHighlight: true,
    });
    expect(out2).toBe(
      "First, click the Export button. I highlighted it on your screen.",
    );
    expect(out2.startsWith("First, First")).toBe(false);
  });

  it("handles multi-step cadence, HTML/script/URL/markdown/arrow stripping, and shortcut expansion", () => {
    const step1: ResolvedStep = {
      step_number: 1,
      instruction_line:
        "Click **File -> Export** [docs](https://example.com) <script>alert(1)</script> (Ctrl+Shift+P)",
      confidence: 0.9,
      rect_px: { x: 10, y: 10, w: 50, h: 20 },
      source: "vlm",
    };
    const spoken1 = formatStepForSpeech(step1, {
      mode: "guide",
      index: 0,
      total: 3,
      hasHighlight: true,
    });
    expect(spoken1).not.toContain("<script>");
    expect(spoken1).not.toContain("alert");
    expect(spoken1).not.toContain("https://");
    expect(spoken1).not.toContain("->");
    expect(spoken1).not.toContain("**");
    expect(spoken1).toContain("First, click File, then Export docs");
    expect(spoken1).toContain("Control Shift P");
    expect(spoken1).toContain("highlighted it on your screen");

    const step2: ResolvedStep = {
      step_number: 2,
      instruction_line: "Choose PNG format.",
      confidence: 0.9,
      rect_px: null,
      source: "none",
    };
    expect(
      formatStepForSpeech(step2, {
        mode: "guide",
        index: 1,
        total: 3,
        hasHighlight: false,
      }),
    ).toBe("Next, choose PNG format.");

    const step3: ResolvedStep = {
      step_number: 3,
      instruction_line: "Save the file.",
      confidence: 0.9,
      rect_px: null,
      source: "none",
    };
    expect(
      formatStepForSpeech(step3, {
        mode: "guide",
        index: 2,
        total: 3,
        hasHighlight: false,
      }),
    ).toBe("Finally, save the file.");
  });

  it("never recites raw terminal commands in terminal mode", () => {
    const terminalStep: ResolvedStep = {
      step_number: 1,
      instruction_line: "Run `git reset --soft HEAD~1` to undo the last commit.",
      terminal_command: "git reset --soft HEAD~1",
      explanation:
        "Moves your branch back one commit while keeping all your edited files staged.",
      confidence: 0.95,
      rect_px: null,
      source: "none",
    };

    const spoken = formatStepForSpeech(terminalStep, {
      mode: "terminal",
      index: 0,
      total: 1,
      hasHighlight: false,
    });
    expect(spoken).not.toContain("git reset");
    expect(spoken).not.toContain("--soft");
    expect(spoken).not.toContain("HEAD~1");
    expect(spoken).toBe(
      "The command in the bar moves your branch back one commit while keeping all your edited files staged.",
    );

    const bareTerminalStep: ResolvedStep = {
      step_number: 1,
      instruction_line: "git reset --soft HEAD~1",
      terminal_command: "git reset --soft HEAD~1",
      explanation: null,
      confidence: 0.95,
      rect_px: null,
      source: "none",
    };
    const bareSpoken = formatStepForSpeech(bareTerminalStep, {
      mode: "terminal",
      index: 0,
      total: 1,
      hasHighlight: false,
    });
    expect(bareSpoken).not.toContain("git reset");
    expect(bareSpoken).toContain("command in the bar");
  });

  it("formats structured AskErrors cleanly", () => {
    expect(
      formatErrorForSpeech({
        code: "timeout",
        brain: "groq_pro",
        message: "504 timeout",
        fallbacks: ["local_vlm"],
      }),
    ).toBe("That took too long to answer. You can switch to Local.");

    expect(
      formatErrorForSpeech({
        code: "unavailable",
        brain: "local_vlm",
        message: "Connection refused",
        fallbacks: [],
      }),
    ).toContain("Ollama doesn't seem to be running");
  });

  it("matches imperative voice commands without false-triggering on real questions", () => {
    expect(matchVoiceCommand("next", true)).toBe("next_step");
    expect(matchVoiceCommand("Next step please!", true)).toBe("next_step");
    expect(matchVoiceCommand("continue", true)).toBe("next_step");
    expect(matchVoiceCommand("repeat", true)).toBe("repeat");
    expect(matchVoiceCommand("Say that again", true)).toBe("repeat");
    expect(matchVoiceCommand("magnify", true)).toBe("magnify_on");
    expect(matchVoiceCommand("zoom in", true)).toBe("magnify_on");
    expect(matchVoiceCommand("zoom out", true)).toBe("magnify_off");
    expect(matchVoiceCommand("stop", true)).toBe("stop_clear");
    expect(matchVoiceCommand("cancel", true)).toBe("stop_clear");
    expect(matchVoiceCommand("close", true)).toBe("stop_clear");
    expect(matchVoiceCommand("done", true)).toBe("stop_clear");
    expect(matchVoiceCommand("mute", true)).toBe("mute_tts");
    expect(matchVoiceCommand("quiet", false)).toBe("mute_tts");

    // Step-scoped commands ignore transcripts when no step is active
    expect(matchVoiceCommand("next", false)).toBeNull();
    expect(matchVoiceCommand("stop", false)).toBeNull();
    expect(matchVoiceCommand("zoom in", false)).toBeNull();

    // Real user queries must NEVER be intercepted as commands
    expect(matchVoiceCommand("how do I stop docker", true)).toBeNull();
    expect(matchVoiceCommand("what does next button do", true)).toBeNull();
    expect(matchVoiceCommand("zoom in on photoshop canvas", true)).toBeNull();
    expect(matchVoiceCommand("close all chrome tabs", true)).toBeNull();
    expect(matchVoiceCommand("why did it stop?", true)).toBeNull();
  });
});

describe("LivePlayer gapless audio scheduling", () => {
  it("schedules contiguous chunks with LEAD=0.05 and halts cleanly on stop()", () => {
    expect(LEAD).toBe(0.05);
    const ctx = createMockAudioContext();
    const states: boolean[] = [];
    const player = new LivePlayer(ctx, (playing) => states.push(playing));

    expect(player.playing).toBe(false);
    player.begin();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(true);

    const chunk1 = new Float32Array(24000); // 1.0 s at 24 kHz
    const chunk2 = new Float32Array(12000); // 0.5 s at 24 kHz
    player.add(chunk1, 24000);
    player.add(chunk2, 24000);

    expect(ctx.scheduled).toHaveLength(2);
    expect(ctx.scheduled[0].when).toBeCloseTo(10.05, 5);
    expect(ctx.scheduled[1].when).toBeCloseTo(11.05, 5);

    expect(player.end()).toBe(true);
    expect(player.playing).toBe(true);

    // Finish chunk 1 -> chunk 2 still active
    ctx.scheduled[0].source.onended?.({});
    expect(player.playing).toBe(true);

    // Finish chunk 2 -> playback ends
    ctx.scheduled[1].source.onended?.({});
    expect(player.playing).toBe(false);
    expect(states[states.length - 1]).toBe(false);

    // Stop mid-stream silences active sources and ignores trailing chunks
    player.begin();
    player.add(chunk1, 24000);
    player.stop();
    expect(player.playing).toBe(false);
    expect(ctx.scheduled[2].stopped).toBe(true);
    player.add(chunk2, 24000);
    expect(ctx.scheduled).toHaveLength(3);
  });
});

describe("TinyVocaClient jsdom resilience and worker orchestration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs and degrades cleanly in jsdom when Worker and AudioContext are absent", async () => {
    const client = new TinyVocaClient();
    const shared = getCopilotVoiceEngine();
    expect(shared).toBeInstanceOf(TinyVocaClient);
    expect(client.getState()).toEqual({
      status: "idle",
      speaking: false,
      voices: ["M2", "F2"],
      sampleRate: 24000,
      modelBytes: 0,
      loadMs: 0,
      error: null,
    });

    const listener = vi.fn();
    const unsub = client.subscribe(listener);
    client.stop();
    unsub();

    await expect(client.load()).rejects.toThrow(/Worker/i);
    expect(client.getState().status).toBe("error");
    expect(client.getState().speaking).toBe(false);

    client.dispose();
    expect(client.getState().status).toBe("idle");
  });

  it("orchestrates load, streaming speak, cancel, and benchmark with a mock Worker", async () => {
    const posted: unknown[] = [];
    const mockWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      terminate: vi.fn(),
      postMessage(msg: unknown) {
        posted.push(msg);
        const m = msg as { type: string; id?: number };
        if (m.type === "load") {
          queueMicrotask(() => {
            mockWorker.onmessage?.({
              data: {
                type: "ready",
                voices: ["F2", "M2"],
                sampleRate: 24000,
                modelBytes: 7988384,
                loadMs: 120,
              },
            } as MessageEvent);
          });
        } else if (m.type === "speak") {
          const chunk = new Float32Array(12000).fill(0.1);
          queueMicrotask(() => {
            mockWorker.onmessage?.({
              data: {
                type: "sentence",
                id: m.id!,
                index: 0,
                total: 1,
                phonemes: "h ə l oʊ",
                audio: chunk,
                sampleRate: 24000,
              },
            } as MessageEvent);
            mockWorker.onmessage?.({
              data: {
                type: "done",
                id: m.id!,
                cancelled: false,
                audio: chunk,
                sampleRate: 24000,
                durationSec: 0.5,
                workSec: 0.1,
                realtimeFactor: 5.0,
                phonemes: ["h ə l oʊ"],
              },
            } as MessageEvent);
          });
        } else if (m.type === "benchmark") {
          queueMicrotask(() => {
            mockWorker.onmessage?.({
              data: {
                type: "benchmark",
                id: m.id,
                speed: 2.5,
                summary: "10.0 s of audio in 4.00 s = 2.5 times real time",
                parts: "linear 70%, attention 20%",
                lines: ["sentence 0 M2: 1.00 s in 0.40 s = 2.5x"],
              },
            } as MessageEvent);
          });
        }
      },
    };

    const ctx = createMockAudioContext();
    const client = new TinyVocaClient({
      workerFactory: () => mockWorker,
      audioContextFactory: () => ctx,
    });

    const onSentence = vi.fn();
    const result = await client.speak("Hello!", { voice: "M2", onSentence });
    expect(result.cancelled).toBe(false);
    expect(result.sampleRate).toBe(24000);
    expect(onSentence).toHaveBeenCalledWith({
      index: 0,
      total: 1,
      phonemes: "h ə l oʊ",
    });

    const bench = await client.benchmark();
    expect(bench.speed).toBe(2.5);
    expect(bench.lines).toHaveLength(1);

    client.dispose();
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("IPC & Settings voice contracts", () => {
  afterEach(() => {
    tauriMocks.setExistingSettingsWindow(null);
    tauriMocks.createdWindows.length = 0;
    tauriMocks.emitWindow.mockClear();
  });

  it("exposes TTS defaults and normalizes spoken_text and legacy settings", async () => {
    expect(DEFAULT_SETTINGS.tts_enabled).toBe(true);
    expect(DEFAULT_SETTINGS.tts_voice).toBe("M2");
    expect(DEFAULT_SETTINGS.tts_speed).toBe(1.0);
    expect(DEFAULT_SETTINGS.tts_pitch_shift).toBe(0.0);
    expect(DEFAULT_SETTINGS.tts_auto_speak).toBe(true);
    expect(DEFAULT_SETTINGS.voice_conversation_mode).toBe(true);

    tauriMocks.invoke.mockResolvedValueOnce({ onboarding_complete: true });
    const loaded = await getSettings();
    expect(loaded.tts_voice).toBe("M2");
    expect(loaded.tts_enabled).toBe(true);
    expect(loaded.voice_conversation_mode).toBe(true);

    const normalized = normalizeAskResponse({
      session_id: "s-voice",
      brain: "groq_pro",
      plan: {
        mode: "guide",
        total_steps: 2,
        steps: [
          {
            step_number: 1,
            instruction_line: "Click Export",
            spoken_text: "  Click   the Export button on the top right.  ",
            confidence: 0.9,
          },
          {
            step_number: 2,
            instruction_line: "Confirm",
            spoken_text: "   ",
            confidence: 0.9,
          },
        ],
      },
    });
    expect(normalized.plan.steps[0].spoken_text).toBe(
      "Click the Export button on the top right.",
    );
    expect(normalized.resolved_steps[0].spoken_text).toBe(
      "Click the Export button on the top right.",
    );
    expect(normalized.plan.steps[1].spoken_text).toBeNull();
  });

  it("handles onStepChanged spoken_text and SettingsTab routing in openSettingsWindow/onSettingsRoute", async () => {
    const stepHandler = vi.fn();
    const unlistenStep = await onStepChanged(stepHandler);
    tauriMocks.emitEvent("step-changed", {
      step: {
        step_number: 1,
        instruction_line: "Open Voice Studio",
        spoken_text: "Open Voice Studio on the left.",
        confidence: 0.95,
      },
      index: 0,
      total: 1,
    });
    expect(stepHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        step: expect.objectContaining({
          spoken_text: "Open Voice Studio on the left.",
        }),
      }),
    );
    await unlistenStep();

    const routeHandler = vi.fn();
    const unlistenRoute = await onSettingsRoute(routeHandler);
    tauriMocks.emitEvent("settings-route", {
      route: "/settings",
      tab: "voice",
    });
    expect(routeHandler).toHaveBeenCalledWith({
      route: "/settings",
      tab: "voice",
    });
    await unlistenRoute();

    // New WebviewWindow passes ?tab=voice
    const created = await openSettingsWindow("/settings", "voice");
    expect(created).toBe(true);
    expect(tauriMocks.createdWindows[0]).toEqual({
      label: "settings",
      options: expect.objectContaining({
        url: "/settings?tab=voice",
        title: "GuideLens Voice Studio",
      }),
    });

    // Existing settings window emits { route, tab }
    tauriMocks.setExistingSettingsWindow({
      emit: tauriMocks.emitWindow,
      setTitle: tauriMocks.setTitleWindow,
      unminimize: tauriMocks.unminimizeWindow,
      show: tauriMocks.showWindow,
      setFocus: tauriMocks.setFocusWindow,
    });
    const reused = await openSettingsWindow("/settings", "voice");
    expect(reused).toBe(true);
    expect(tauriMocks.emitWindow).toHaveBeenCalledWith("settings-route", {
      route: "/settings",
      tab: "voice",
    });
  });
});
