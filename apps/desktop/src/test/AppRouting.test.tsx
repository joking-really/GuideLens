import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../types";

const mocks = vi.hoisted(() => {
  const listeners: Record<string, ((ev: { payload: unknown }) => void)[]> = {};

  class MockTinyVocaClient {
    getState() {
      return {
        status: "idle" as const,
        speaking: false,
        voices: ["M2" as const, "F2" as const],
        sampleRate: 24000,
        modelBytes: 0,
        loadMs: 0,
        error: null,
      };
    }
    subscribe() {
      return () => {};
    }
    load = vi.fn(async () => {});
    speak = vi.fn(async () => ({
      cancelled: false,
      audio: new Float32Array(0),
      sampleRate: 24000,
      durationSec: 0,
      workSec: 0,
      realtimeFactor: 0,
      phonemes: [],
    }));
    stop = vi.fn();
    benchmark = vi.fn(async () => ({
      speed: 10,
      summary: "10x",
      parts: "",
      lines: [],
    }));
    dispose = vi.fn();
  }

  const copilotEngine = new MockTinyVocaClient();

  return {
    listeners,
    MockTinyVocaClient,
    copilotEngine,
    invoke: vi.fn(async (cmd: string) => {
      switch (cmd) {
        case "get_settings":
          return { ...DEFAULT_SETTINGS, onboarding_complete: true };
        case "list_api_key_providers":
          return [];
        case "ollama_status":
          return { running: false, models: [], install_url: "https://ollama.com/download" };
        case "detect_agents":
          return [];
        case "auth_status":
          return { logged_in: false, email: null, tier: "free", status: "inactive", usage: 0, limit: 1500 };
        case "history_list":
          return [];
        default:
          return null;
      }
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
    static async getByLabel() {
      return null;
    }
  },
}));

vi.mock("../lib/tinyVocaClient", () => ({
  TinyVocaClient: mocks.MockTinyVocaClient,
  getCopilotVoiceEngine: () => mocks.copilotEngine,
  encodeWavBlob: () => new Blob([], { type: "audio/wav" }),
}));

import App from "../App";
import { normalizeAskResponse, parseAskError } from "../lib/ipc";
import { clampInstruction } from "../types";

describe("App routing and IPC helpers", () => {
  beforeEach(() => {
    mocks.invoke.mockClear();
    for (const k of Object.keys(mocks.listeners)) {
      delete mocks.listeners[k];
    }
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("renders FloatingBar on route /", async () => {
    window.history.pushState({}, "", "/");
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("floating-bar")).toBeInTheDocument();
      expect(mocks.invoke).toHaveBeenCalledWith("get_settings");
    });
  });

  it("renders OverlayCanvas on route /overlay", async () => {
    window.history.pushState({}, "", "/overlay");
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("overlay-empty")).toBeInTheDocument();
      expect(mocks.invoke).toHaveBeenCalledWith("get_settings");
    });
  });

  it("renders SettingsView on route /settings?tab=history", async () => {
    window.history.pushState({}, "", "/settings?tab=history");
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("settings-view")).toBeInTheDocument();
    });
    expect(screen.getByTestId("panel-history")).toBeInTheDocument();
  });

  it("renders SettingsView Voice Studio on route /settings?tab=voice", async () => {
    window.history.pushState({}, "", "/settings?tab=voice");
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("settings-view")).toBeInTheDocument();
    });
    expect(screen.getByTestId("panel-voice")).toBeInTheDocument();
    expect(screen.getByTestId("voice-studio")).toBeInTheDocument();
  });

  it("switches active tab via settings-route event even when Settings window is already mounted", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/settings?tab=voice");
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("panel-voice")).toBeInTheDocument();
    });

    // User locally switches to privacy tab
    await user.click(screen.getByTestId("tab-privacy"));
    expect(screen.getByTestId("panel-privacy")).toBeInTheDocument();

    // Emitting settings-route { route: "/settings", tab: "voice" } jumps back to Voice Studio
    await act(async () => {
      mocks.emitMockEvent("settings-route", {
        route: "/settings",
        tab: "voice",
      });
    });
    expect(screen.getByTestId("panel-voice")).toBeInTheDocument();

    // Emitting settings-route { route: "/settings", tab: "history" } jumps to History
    await act(async () => {
      mocks.emitMockEvent("settings-route", {
        route: "/settings",
        tab: "history",
      });
    });
    expect(screen.getByTestId("panel-history")).toBeInTheDocument();
  });

  it("renders OnboardingView on route /onboarding and switches to /settings?tab=voice on settings-route event", async () => {
    window.history.pushState({}, "", "/onboarding");
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-view")).toBeInTheDocument();
    });

    await act(async () => {
      mocks.emitMockEvent("settings-route", {
        route: "/settings",
        tab: "voice",
      });
    });
    expect(screen.getByTestId("panel-voice")).toBeInTheDocument();
  });

  it("clamps instructions to 140 chars and parses structured/plain AskErrors", () => {
    const longText = "A".repeat(200);
    expect(clampInstruction(longText).length).toBe(140);

    const parsedJson = parseAskError(
      JSON.stringify({
        code: "rate_limited",
        brain: "groq_pro",
        message: "Rate limit hit",
        fallbacks: ["local_vlm"],
      }),
    );
    expect(parsedJson.code).toBe("rate_limited");
    expect(parsedJson.brain).toBe("groq_pro");

    const parsedPlain = parseAskError("Groq gateway timed out (504)");
    expect(parsedPlain.code).toBe("timeout");
    expect(parsedPlain.brain).toBe("groq_pro");

    const normalized = normalizeAskResponse({
      session_id: "s1",
      brain: "local_vlm",
      plan: {
        mode: "guide",
        total_steps: 1,
        steps: [
          {
            step_number: 1,
            instruction_line: "  Click   Export  ",
            bbox: [100, 200, 50, 50],
            confidence: 0.9,
          },
        ],
      },
      monitor: { x: 0, y: 0, w: 1000, h: 1000, scale: 1 },
    });
    expect(normalized.resolved_steps[0].rect_px).toEqual({
      x: 100,
      y: 200,
      w: 50,
      h: 50,
    });
  });
});
