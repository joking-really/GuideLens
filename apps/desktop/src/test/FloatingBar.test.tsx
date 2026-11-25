import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../types";

const mocks = vi.hoisted(() => {
  const listeners: Record<string, ((event: { payload: unknown }) => void)[]> =
    {};

  type MockVoiceState = {
    status: "idle" | "loading" | "ready" | "speaking" | "error";
    speaking: boolean;
    voices: ("M2" | "F2")[];
    sampleRate: number;
    modelBytes: number;
    loadMs: number;
    error: string | null;
  };

  let voiceState: MockVoiceState = {
    status: "idle",
    speaking: false,
    voices: ["M2", "F2"],
    sampleRate: 24000,
    modelBytes: 0,
    loadMs: 0,
    error: null,
  };
  const voiceSubscribers = new Set<(s: MockVoiceState) => void>();
  const emitVoiceState = (patch: Partial<MockVoiceState>) => {
    voiceState = { ...voiceState, ...patch };
    const snapshot = { ...voiceState, voices: [...voiceState.voices] };
    for (const cb of voiceSubscribers) {
      cb(snapshot);
    }
  };

  const voiceEngine = {
    getState: () => ({ ...voiceState, voices: [...voiceState.voices] }),
    subscribe: vi.fn((cb: (s: MockVoiceState) => void) => {
      voiceSubscribers.add(cb);
      return () => {
        voiceSubscribers.delete(cb);
      };
    }),
    load: vi.fn(async () => {
      emitVoiceState({ status: "ready", loadMs: 120, modelBytes: 7988384 });
    }),
    speak: vi.fn(async () => ({
      cancelled: false,
      audio: new Float32Array([0.1, -0.1]),
      sampleRate: 24000,
      durationSec: 0.8,
      workSec: 0.08,
      realtimeFactor: 10,
      phonemes: ["k l ɪ k"],
    })),
    stop: vi.fn(() => {
      if (voiceState.speaking || voiceState.status === "speaking") {
        emitVoiceState({ speaking: false, status: "ready" });
      }
    }),
    reset() {
      voiceSubscribers.clear();
      voiceState = {
        status: "idle",
        speaking: false,
        voices: ["M2", "F2"],
        sampleRate: 24000,
        modelBytes: 0,
        loadMs: 0,
        error: null,
      };
      this.load.mockClear();
      this.speak.mockClear();
      this.stop.mockClear();
      this.subscribe.mockClear();
    },
    emitState: emitVoiceState,
  };

  const createdWindows: Array<{ label: string; options: Record<string, unknown> }> = [];

  return {
    listeners,
    voiceEngine,
    createdWindows,
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_settings") {
        return { ...DEFAULT_SETTINGS, onboarding_complete: true };
      }
      if (cmd === "set_settings") {
        return null;
      }
      if (cmd === "clear_overlay") {
        return null;
      }
      if (cmd === "toggle_magnify") {
        return null;
      }
      if (cmd === "copy_to_clipboard") {
        return null;
      }
      if (cmd === "transcribe") {
        return { text: "how do I export" };
      }
      if (cmd === "get_live_session") {
        return {
          session_id: null,
          status: "idle",
          goal: "",
          companion_id: "pixel_cat",
          current_step: null,
          current_monitor: null,
          turn_count: 0,
          turns: [],
          graph_md_path: null,
          started_at: null,
        };
      }
      if (cmd === "start_live_session") {
        return {
          session_id: "live-sess-1",
          status: "guiding",
          goal: String(args?.goal ?? "Guide me"),
          companion_id: "pixel_cat",
          current_step: {
            step_number: 1,
            instruction_line: "Click File in the menu bar",
            spoken_text: "I highlighted File at the top left.",
            confidence: 0.94,
            action_kind: "click",
            companion_emotion: "pointing",
            rect_px: { x: 12, y: 10, w: 48, h: 24 },
            source: "som",
          },
          current_monitor: { x: 0, y: 0, w: 1920, h: 1080, scale: 1 },
          turn_count: 1,
          turns: [
            {
              turn_number: 1,
              user_text: String(args?.goal ?? ""),
              instruction_line: "Click File in the menu bar",
              spoken_text: "I highlighted File at the top left.",
              action_kind: "click",
              companion_emotion: "pointing",
              target_name: "File",
              rect_px: { x: 12, y: 10, w: 48, h: 24 },
              active_app: "Code.exe",
              window_title: "GuideLens",
              latency: null,
              timestamp: 1731900000,
            },
          ],
          graph_md_path: null,
          started_at: 1731900000,
        };
      }
      if (cmd === "send_live_message") {
        return {
          session_id: String(args?.sessionId ?? "live-sess-1"),
          status: "guiding",
          goal: "Export PNG",
          companion_id: "pixel_cat",
          current_step: {
            step_number: 2,
            instruction_line: "Click Export As",
            spoken_text: "Now pick Export As from the menu.",
            confidence: 0.95,
            action_kind: "click",
            companion_emotion: "pointing",
            rect_px: { x: 30, y: 80, w: 120, h: 28 },
            source: "som",
          },
          current_monitor: { x: 0, y: 0, w: 1920, h: 1080, scale: 1 },
          turn_count: 2,
          turns: [],
          graph_md_path: null,
          started_at: 1731900000,
        };
      }
      if (cmd === "end_live_session") {
        return {
          session_id: "live-sess-1",
          status: "completed",
          goal: "Export PNG",
          companion_id: "pixel_cat",
          current_step: null,
          current_monitor: null,
          turn_count: 2,
          turns: [],
          graph_md_path: null,
          started_at: 1731900000,
        };
      }
      if (cmd === "screenday_status") {
        return {
          enabled: false,
          interval_sec: 15,
          today_key: "2026-11-25",
          today_frames: 0,
          today_bytes: 0,
          last_captured_at: null,
          current_project: null,
          current_meeting: null,
          skipped_private: false,
        };
      }
      if (cmd === "screenday_set_enabled") {
        return {
          enabled: Boolean(args?.enabled),
          interval_sec: 15,
          today_key: "2026-11-25",
          today_frames: 1,
          today_bytes: 42000,
          last_captured_at: 1731900000,
          current_project: "GuideLens",
          current_meeting: null,
          skipped_private: false,
        };
      }
      if (cmd === "next_step") {
        return {
          step_number: 2,
          instruction_line: "Click Select Subject at the top toolbar.",
          confidence: 0.9,
          rect_px: { x: 400, y: 80, w: 120, h: 30 },
          source: "uia",
        };
      }
      if (cmd === "ask") {
        const q = String(args?.query ?? "");
        const brainOverride = args?.brain;
        if (q.includes("timeout-test") && !brainOverride) {
          throw JSON.stringify({
            code: "timeout",
            brain: "groq_pro",
            message: "Groq request timed out",
            fallbacks: ["local_vlm", "agent_cli"],
          });
        }
        if (q.includes("git")) {
          return {
            session_id: "sess-term",
            brain: brainOverride ?? "groq_pro",
            plan: {
              mode: "terminal",
              total_steps: 1,
              steps: [
                {
                  step_number: 1,
                  instruction_line:
                    "Moves your branch back one commit while keeping all your edited files staged.",
                  confidence: 0.95,
                  terminal_command: "git reset --soft HEAD~1",
                  explanation:
                    "Moves your branch back one commit while keeping all your edited files staged.",
                },
              ],
            },
            resolved_steps: [
              {
                step_number: 1,
                instruction_line:
                  "Moves your branch back one commit while keeping all your edited files staged.",
                confidence: 0.95,
                terminal_command: "git reset --soft HEAD~1",
                explanation:
                  "Moves your branch back one commit while keeping all your edited files staged.",
                rect_px: null,
                source: "none",
              },
            ],
            capture_path: null,
            monitor: null,
          };
        }
        return {
          session_id: "sess-1",
          brain: brainOverride ?? "local_vlm",
          plan: {
            mode: "guide",
            total_steps: 2,
            steps: [
              {
                step_number: 1,
                instruction_line:
                  "Click the Object Selection Tool in the left toolbar <script>alert(1)</script>",
                confidence: 0.92,
                shortcut: "W",
                bbox: [40, 180, 32, 32],
              },
              {
                step_number: 2,
                instruction_line: "Click Select Subject at the top toolbar.",
                confidence: 0.9,
                bbox: [200, 40, 80, 20],
              },
            ],
          },
          resolved_steps: [
            {
              step_number: 1,
              instruction_line:
                "Click the Object Selection Tool in the left toolbar <script>alert(1)</script>",
              confidence: 0.92,
              shortcut: "W",
              rect_px: { x: 40, y: 180, w: 32, h: 32 },
              source: "uia",
            },
            {
              step_number: 2,
              instruction_line: "Click Select Subject at the top toolbar.",
              confidence: 0.9,
              rect_px: { x: 400, y: 80, w: 120, h: 30 },
              source: "uia",
            },
          ],
          capture_path: "C:\\captures\\shot.jpg",
          monitor: { x: 0, y: 0, w: 1920, h: 1080, scale: 1 },
        };
      }
      return null;
    }),
    listen: vi.fn(async (event: string, cb: (ev: { payload: unknown }) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
      return () => {
        listeners[event] = (listeners[event] || []).filter((fn) => fn !== cb);
      };
    }),
    emitMockEvent(event: string, payload: unknown) {
      for (const cb of listeners[event] || []) {
        cb({ payload });
      }
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setSize: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
    startDragging: vi.fn(async () => {}),
    outerPosition: vi.fn(async () => ({ x: 100, y: 100 })),
    onMoved: vi.fn(async () => () => {}),
    close: vi.fn(async () => {}),
  }),
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  },
  PhysicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    constructor(label: string, options: Record<string, unknown>) {
      mocks.createdWindows.push({ label, options });
    }
    static async getByLabel() {
      return null;
    }
    once(event: string, cb: () => void) {
      if (event === "tauri://created") {
        queueMicrotask(cb);
      }
    }
  },
}));

vi.mock("../lib/tinyVocaClient", () => ({
  getCopilotVoiceEngine: () => mocks.voiceEngine,
  TinyVocaClient: class {},
  encodeWavBlob: () => new Blob([], { type: "audio/wav" }),
}));

import { FloatingBar } from "../components/FloatingBar";

describe("FloatingBar", () => {
  beforeEach(() => {
    mocks.invoke.mockClear();
    mocks.createdWindows.length = 0;
    mocks.voiceEngine.reset();
    for (const k of Object.keys(mocks.listeners)) {
      delete mocks.listeners[k];
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.SpeechRecognition;
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  });

  it("renders sleek obsidian capsule pill with companion badge, focuses input on bar-summoned, and cycles brain modes", async () => {
    const user = userEvent.setup();
    render(<FloatingBar initialSettings={{ onboarding_complete: true, brain_mode: "local_vlm" }} />);

    const bar = screen.getByTestId("floating-bar");
    expect(bar).toHaveAttribute("data-tauri-drag-region");
    expect(bar.className).toContain("backdrop-blur-2xl");
    expect(bar.className).toContain("rounded-full");
    expect(bar.className).toContain("w-[620px]");
    expect(bar.className).toContain("h-[54px]");

    // Mini companion sprite badge renders inside capsule
    const companionBadge = screen.getByTestId("capsule-companion-badge");
    expect(companionBadge).toBeInTheDocument();
    expect(screen.getByTestId("companion-sprite")).toHaveAttribute("data-companion", "pixel_cat");

    const input = screen.getByTestId("bar-query-input");
    const pill = screen.getByTestId("brain-mode-pill");
    expect(pill).toHaveTextContent("Local");

    // Blur input then summon bar
    pill.focus();
    expect(document.activeElement).toBe(pill);

    await act(async () => {
      mocks.emitMockEvent("bar-summoned", {});
    });
    expect(document.activeElement).toBe(input);

    // Cycle brains: Local -> BYO: Groq -> Groq Pro -> Agent: Claude -> Auto
    await user.click(pill);
    expect(pill).toHaveTextContent("BYO: Groq");

    await user.click(pill);
    expect(pill).toHaveTextContent("Groq Pro");

    await user.click(pill);
    expect(pill).toHaveTextContent("Agent: Claude");

    await user.click(pill);
    expect(pill).toHaveTextContent("Auto");

    // Clicking Control Center opens the dedicated GuideLens Control Center window (no inline drawer)
    await user.click(screen.getByTestId("open-settings-btn"));
    expect(screen.queryByTestId("settings-view")).toBeNull();
    expect(mocks.createdWindows[0]).toMatchObject({
      label: "settings",
      options: expect.objectContaining({
        url: "/settings?tab=overview",
        title: "GuideLens Control Center",
      }),
    });
  });

  it("toggles voice mute and starts/stops Web Speech API", async () => {
    const startMock = vi.fn();
    const stopMock = vi.fn();
    class FakeSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((e: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onend: (() => void) | null = null;
      start = startMock;
      stop = stopMock;
    }
    window.SpeechRecognition = FakeSpeechRecognition as unknown as typeof window.SpeechRecognition;

    const user = userEvent.setup();
    render(<FloatingBar initialSettings={{ onboarding_complete: true, voice_enabled: false }} />);

    const voiceBtn = screen.getByTestId("voice-mute-toggle");
    expect(voiceBtn).toHaveAttribute("aria-pressed", "false");

    await user.click(voiceBtn);
    expect(voiceBtn).toHaveAttribute("aria-pressed", "true");
    expect(startMock).toHaveBeenCalledTimes(1);

    await user.click(voiceBtn);
    expect(voiceBtn).toHaveAttribute("aria-pressed", "false");
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("submits query, renders plain-text step response safely (no HTML), advances steps, and clears on Esc", async () => {
    const user = userEvent.setup();
    render(<FloatingBar initialSettings={{ onboarding_complete: true }} />);

    const input = screen.getByTestId("bar-query-input");
    await user.type(input, "Remove background{enter}");

    const block = await screen.findByTestId("response-block");
    expect(block).toBeInTheDocument();

    // AI text must render as plain text only, never executed as HTML
    const instr = screen.getByTestId("instruction-line");
    expect(instr.textContent).toContain("<script>alert(1)</script>");
    expect(instr.querySelector("script")).toBeNull();

    expect(screen.getByTestId("step-counter")).toHaveTextContent("Step 1/2");
    expect(screen.getByTestId("step-shortcut")).toHaveTextContent("W");

    // Toggle Magnify
    const magBtn = screen.getByTestId("magnify-toggle-btn");
    await user.click(magBtn);
    expect(mocks.invoke).toHaveBeenCalledWith("toggle_magnify", {
      on: true,
      enabled: true,
      magnify: true,
    });

    // Advance via Next -> button
    await user.click(screen.getByTestId("next-step-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("step-counter")).toHaveTextContent("Step 2/2");
    });
    expect(screen.getByTestId("instruction-line")).toHaveTextContent(
      "Click Select Subject at the top toolbar.",
    );

    // Pressing Escape clears overlay and collapses response block
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("response-block")).toBeNull();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("clear_overlay");
  });

  it("renders terminal variant with monospace command box and emerald Copy confirmation", async () => {
    const user = userEvent.setup();
    render(<FloatingBar initialSettings={{ onboarding_complete: true }} />);

    const input = screen.getByTestId("bar-query-input");
    await user.type(input, "undo last git commit{enter}");

    const termBox = await screen.findByTestId("terminal-variant");
    expect(termBox).toBeInTheDocument();
    expect(screen.getByTestId("terminal-command-text")).toHaveTextContent(
      "git reset --soft HEAD~1",
    );
    expect(screen.getByTestId("terminal-explanation")).toHaveTextContent(
      "Moves your branch back one commit while keeping all your edited files staged.",
    );

    const copyBtn = screen.getByTestId("copy-command-btn");
    await user.click(copyBtn);

    expect(mocks.invoke).toHaveBeenCalledWith("copy_to_clipboard", {
      text: "git reset --soft HEAD~1",
    });
    expect(copyBtn).toHaveTextContent("Copied!");
    expect(copyBtn.className).toContain("#22C55E");
  });

  it("shows Groq timeout fallback prompt and retries with Local VLM on click", async () => {
    const user = userEvent.setup();
    render(
      <FloatingBar
        initialSettings={{ onboarding_complete: true, brain_mode: "groq_pro" }}
      />,
    );

    const input = screen.getByTestId("bar-query-input");
    await user.type(input, "timeout-test{enter}");

    const errorAlert = await screen.findByTestId("response-error");
    expect(errorAlert).toHaveTextContent("Groq timed out — use Local?");

    const useLocalBtn = screen.getByTestId("fallback-btn-local_vlm");
    await user.click(useLocalBtn);

    await waitFor(() => {
      expect(screen.getByTestId("response-block")).toBeInTheDocument();
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith("ask", {
      query: "timeout-test",
      brain: "local_vlm",
      brainOverride: "local_vlm",
      brain_override: "local_vlm",
    });
  });

  it("warm-loads voice engine, persists speaker mute toggle, and stops playback when clicked while speaking", async () => {
    vi.useFakeTimers();
    render(
      <FloatingBar
        initialSettings={{
          onboarding_complete: true,
          tts_enabled: true,
        }}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(mocks.voiceEngine.load).toHaveBeenCalledTimes(1);

    const speakerBtn = screen.getByTestId("tts-mute-toggle");
    expect(speakerBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("tts-speaking-pulse")).toBeNull();

    await act(async () => {
      mocks.voiceEngine.emitState({ status: "speaking", speaking: true });
    });
    expect(screen.getByTestId("tts-speaking-pulse")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(speakerBtn);
    });
    expect(mocks.voiceEngine.stop).toHaveBeenCalled();
    expect(speakerBtn).toHaveAttribute("aria-pressed", "false");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_settings",
      expect.objectContaining({
        s: expect.objectContaining({ tts_enabled: false }),
      }),
    );
  });

  it("deduplicates step 0 speech across ask() + step-changed, speaks errors, and stops on Escape/overlay-cleared", async () => {
    const user = userEvent.setup();
    render(
      <FloatingBar
        initialSettings={{
          onboarding_complete: true,
          tts_enabled: true,
          tts_auto_speak: true,
          tts_voice: "F2",
          tts_speed: 1.15,
          tts_pitch_shift: 0.1,
        }}
      />,
    );

    const input = screen.getByTestId("bar-query-input");
    await user.type(input, "Remove background{enter}");

    await screen.findByTestId("response-block");
    expect(mocks.voiceEngine.speak).toHaveBeenCalledTimes(1);
    expect(mocks.voiceEngine.speak).toHaveBeenCalledWith(
      expect.stringContaining("First, click the Object Selection Tool"),
      expect.objectContaining({
        voice: "F2",
        speed: 1.15,
        pitchShift: 0.1,
      }),
    );

    // Rust emitting step-changed for step 0 must NOT double-speak step 0
    await act(async () => {
      mocks.emitMockEvent("step-changed", {
        index: 0,
        total: 2,
        mode: "guide",
        step: {
          step_number: 1,
          instruction_line:
            "Click the Object Selection Tool in the left toolbar <script>alert(1)</script>",
          confidence: 0.92,
          shortcut: "W",
          rect_px: { x: 40, y: 180, w: 32, h: 32 },
          source: "uia",
        },
      });
    });
    expect(mocks.voiceEngine.speak).toHaveBeenCalledTimes(1);

    // Advancing to step 2 stops previous speech and speaks step 2 once
    await user.click(screen.getByTestId("next-step-btn"));
    await waitFor(() => {
      expect(mocks.voiceEngine.speak).toHaveBeenCalledTimes(2);
    });
    expect(mocks.voiceEngine.speak).toHaveBeenLastCalledWith(
      expect.stringContaining("Finally, click Select Subject"),
      expect.objectContaining({ voice: "F2" }),
    );

    // overlay-cleared stops speech and resets deduplication
    await act(async () => {
      mocks.emitMockEvent("overlay-cleared", {});
    });
    expect(mocks.voiceEngine.stop).toHaveBeenCalled();

    // Error cue spoken on ask failure
    await user.clear(input);
    await user.type(input, "timeout-test{enter}");
    await screen.findByTestId("response-error");
    await waitFor(() => {
      expect(mocks.voiceEngine.speak).toHaveBeenCalledTimes(3);
    });
    expect(mocks.voiceEngine.speak).toHaveBeenLastCalledWith(
      expect.stringContaining("That took too long to answer."),
      expect.any(Object),
    );
  });

  it("supports ResponseBlock Speak/Stop buttons and suppresses mic during TTS with 250ms echo-settle delay", async () => {
    vi.useFakeTimers();
    const startMock = vi.fn();
    const stopMock = vi.fn();
    class FakeSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((e: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onend: (() => void) | null = null;
      start = startMock;
      stop = stopMock;
    }
    window.SpeechRecognition = FakeSpeechRecognition as unknown as typeof window.SpeechRecognition;

    render(
      <FloatingBar
        initialSettings={{
          onboarding_complete: true,
          voice_enabled: true,
          voice_conversation_mode: true,
          tts_enabled: true,
          tts_auto_speak: false,
        }}
      />,
    );

    expect(startMock).toHaveBeenCalledTimes(1);
    const voiceBtn = screen.getByTestId("voice-mute-toggle");
    expect(voiceBtn).toHaveAttribute("data-paused-for-tts", "false");

    // Emit step via step-changed
    await act(async () => {
      mocks.emitMockEvent("step-changed", {
        index: 0,
        total: 1,
        mode: "guide",
        step: {
          step_number: 1,
          instruction_line: "Click Export",
          spoken_text: "Click the Export button on the top right.",
          confidence: 0.9,
          rect_px: { x: 100, y: 20, w: 80, h: 30 },
          source: "uia",
        },
      });
    });

    // Manual Speak button in ResponseBlock
    const replayBtn = screen.getByTestId("replay-speech-btn");
    await act(async () => {
      fireEvent.click(replayBtn);
    });
    expect(mocks.voiceEngine.speak).toHaveBeenCalledTimes(1);

    // While engine is speaking: ResponseBlock shows Stop button and VoiceIndicator pauses mic
    await act(async () => {
      mocks.voiceEngine.emitState({ status: "speaking", speaking: true });
    });
    expect(voiceBtn).toHaveAttribute("data-paused-for-tts", "true");
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("voice-pulse-ring")).toBeNull();

    const stopSpeechBtn = screen.getByTestId("stop-speech-btn");
    await act(async () => {
      fireEvent.click(stopSpeechBtn);
    });
    expect(mocks.voiceEngine.stop).toHaveBeenCalled();

    // After TTS stops, mic stays paused during 250ms echo-settle delay, then resumes
    expect(voiceBtn).toHaveAttribute("data-paused-for-tts", "false");
    expect(startMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(startMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(startMock).toHaveBeenCalledTimes(2);
  });

  it("handles local hands-free voice commands without calling ask and submits spoken questions", async () => {
    let recognitionInstance: {
      onresult: ((ev: unknown) => void) | null;
      start: () => void;
      stop: () => void;
    } | null = null;
    class FakeSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((e: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      constructor() {
        recognitionInstance = this;
      }
    }
    window.SpeechRecognition = FakeSpeechRecognition as unknown as typeof window.SpeechRecognition;

    const emitTranscript = async (text: string, isFinal = true) => {
      await act(async () => {
        recognitionInstance?.onresult?.({
          resultIndex: 0,
          results: {
            length: 1,
            0: { isFinal, 0: { transcript: text } },
          },
        });
      });
    };

    render(
      <FloatingBar
        initialSettings={{
          onboarding_complete: true,
          voice_enabled: true,
          stt_engine: "web_speech",
          tts_enabled: true,
          tts_auto_speak: true,
        }}
      />,
    );

    // 1. Spoken question submits ask() and interrupts speech first
    await emitTranscript("how do I remove the background?");
    await waitFor(() => {
      expect(screen.getByTestId("step-counter")).toHaveTextContent("Step 1/2");
    });
    expect(mocks.invoke).toHaveBeenCalledWith("ask", expect.objectContaining({ query: "how do I remove the background?" }));
    mocks.invoke.mockClear();
    mocks.voiceEngine.speak.mockClear();

    // 2. "repeat" replays current step without calling ask()
    await emitTranscript("repeat");
    expect(mocks.invoke).not.toHaveBeenCalledWith("ask", expect.anything());
    expect(mocks.voiceEngine.speak).toHaveBeenCalledTimes(1);

    // 3. "magnify" enables magnifier locally without calling ask()
    await emitTranscript("magnify");
    expect(mocks.invoke).toHaveBeenCalledWith("toggle_magnify", {
      on: true,
      enabled: true,
      magnify: true,
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("ask", expect.anything());

    // 4. "next step" advances to step 2 locally without calling ask()
    await emitTranscript("next step");
    await waitFor(() => {
      expect(screen.getByTestId("step-counter")).toHaveTextContent("Step 2/2");
    });
    expect(mocks.invoke).toHaveBeenCalledWith("next_step");
    expect(mocks.invoke).not.toHaveBeenCalledWith("ask", expect.anything());

    // 5. "mute" mutes TTS locally without calling ask()
    await emitTranscript("mute");
    await waitFor(() => {
      expect(screen.getByTestId("tts-mute-toggle")).toHaveAttribute("aria-pressed", "false");
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("ask", expect.anything());

    // 6. "stop" clears overlay locally without calling ask()
    await emitTranscript("stop");
    await waitFor(() => {
      expect(screen.queryByTestId("response-block")).toBeNull();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("clear_overlay");
    expect(mocks.invoke).not.toHaveBeenCalledWith("ask", expect.anything());
  });

  it("runs Groq Whisper VAD loop on cloud STT and discards chunks if pausedForTts triggers", async () => {
    vi.useFakeTimers();

    let currentRmsSample = 0;
    const stopTrackMock = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: stopTrackMock }],
        })),
      },
    });

    class FakeAudioContext {
      state = "running";
      createMediaStreamSource = vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
      createAnalyser = vi.fn(() => ({
        fftSize: 64,
        getFloatTimeDomainData: (buf: Float32Array) => {
          buf.fill(currentRmsSample);
        },
      }));
      resume = vi.fn(async () => {});
      close = vi.fn(async () => {});
    }

    const recorderInstances: FakeMediaRecorder[] = [];
    class FakeMediaRecorder {
      state: "inactive" | "recording" = "inactive";
      ondataavailable: ((ev: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: MediaStream) {
        recorderInstances.push(this);
      }
      start = vi.fn(() => {
        this.state = "recording";
      });
      stop = vi.fn(() => {
        if (this.state === "inactive") return;
        this.state = "inactive";
        const chunk = {
          size: 4,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        } as unknown as Blob;
        // Wrap in real Blob-like object for chunks
        this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }) });
        void chunk;
        this.onstop?.();
      });
    }

    // Ensure Blob.prototype.arrayBuffer exists in jsdom
    if (typeof Blob.prototype.arrayBuffer !== "function") {
      Blob.prototype.arrayBuffer = function () {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.readAsArrayBuffer(this);
        });
      };
    }

    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;

    render(
      <FloatingBar
        initialSettings={{
          onboarding_complete: true,
          voice_enabled: true,
          stt_engine: "cloud",
          voice_conversation_mode: true,
          tts_enabled: true,
          tts_auto_speak: false,
        }}
      />,
    );

    // Flush getUserMedia promise
    await act(async () => {
      await Promise.resolve();
    });

    // Silence initially -> no recorder started yet
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(recorderInstances.length).toBe(0);

    // Speech onset (RMS 0.1 > 0.02 threshold)
    currentRmsSample = 0.1;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70);
    });
    expect(recorderInstances.length).toBe(1);
    expect(recorderInstances[0].state).toBe("recording");

    // 680ms of silence stops chunk and transcribes via Groq cloud STT (not stopped yet at 500ms)
    currentRmsSample = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(recorderInstances[0].stop).toHaveBeenCalledTimes(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(240);
    });
    expect(recorderInstances[0].stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.invoke).toHaveBeenCalledWith(
      "transcribe",
      expect.objectContaining({ engine: "cloud" }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      "ask",
      expect.objectContaining({ query: "how do I export" }),
    );

    // Second utterance interrupted by TTS speaking -> must discard without transcribing
    mocks.invoke.mockClear();
    currentRmsSample = 0.1;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70);
    });
    expect(recorderInstances.length).toBe(2);

    await act(async () => {
      mocks.voiceEngine.emitState({ status: "speaking", speaking: true });
    });
    expect(recorderInstances[1].stop).toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("transcribe", expect.anything());
  });

  it("toggles Live Call session, displays spoken whisper, routes follow-ups, and toggles Screen Day", async () => {
    const user = userEvent.setup();
    render(<FloatingBar initialSettings={{ onboarding_complete: true }} />);

    // Screen Day toggle
    const dayToggle = screen.getByTestId("screenday-toggle");
    expect(dayToggle).toHaveAttribute("aria-pressed", "false");
    await user.click(dayToggle);
    expect(mocks.invoke).toHaveBeenCalledWith("screenday_set_enabled", { enabled: true });
    await waitFor(() => {
      expect(dayToggle).toHaveAttribute("aria-pressed", "true");
    });

    // Live Call start
    const liveBtn = screen.getByTestId("live-call-toggle");
    await user.type(screen.getByTestId("bar-query-input"), "Export as PNG");
    await user.click(liveBtn);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "start_live_session",
      expect.objectContaining({ goal: "Export as PNG" }),
    );
    expect(await screen.findByTestId("instruction-line")).toHaveTextContent(
      "Click File in the menu bar",
    );
    expect(screen.getByTestId("spoken-whisper")).toHaveTextContent(
      "I highlighted File at the top left.",
    );
    expect(screen.getByTestId("step-counter")).toHaveTextContent("Live · Turn 1");

    // Submitting a follow-up while Live Call is active calls send_live_message
    const input = screen.getByTestId("bar-query-input");
    await user.clear(input);
    await user.type(input, "Where is Export As?{enter}");
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        "send_live_message",
        expect.objectContaining({ text: "Where is Export As?", sessionId: "live-sess-1" }),
      );
    });
    expect(await screen.findByTestId("instruction-line")).toHaveTextContent(
      "Click Export As",
    );

    // End Live Call
    await user.click(liveBtn);
    expect(mocks.invoke).toHaveBeenCalledWith("end_live_session", {
      sessionId: "live-sess-1",
      session_id: "live-sess-1",
    });
  });
});
