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

  interface MockClientRecord {
    speak: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    benchmark: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
  }

  const createdClients: MockClientRecord[] = [];

  class MockTinyVocaClient {
    private state: MockVoiceState = {
      status: "idle",
      speaking: false,
      voices: ["M2", "F2"],
      sampleRate: 24000,
      modelBytes: 0,
      loadMs: 0,
      error: null,
    };
    private subscribers = new Set<(s: MockVoiceState) => void>();

    private emit(patch: Partial<MockVoiceState>) {
      this.state = { ...this.state, ...patch };
      const snap = this.getState();
      for (const cb of this.subscribers) {
        cb(snap);
      }
    }

    getState(): MockVoiceState {
      return { ...this.state, voices: [...this.state.voices] };
    }

    subscribe(cb: (s: MockVoiceState) => void): () => void {
      this.subscribers.add(cb);
      return () => {
        this.subscribers.delete(cb);
      };
    }

    load = vi.fn(async () => {
      this.emit({ status: "ready", loadMs: 88, modelBytes: 7988384 });
    });

    speak = vi.fn(
      async (
        _text: string,
        opts: {
          voice: "M2" | "F2";
          speed?: number;
          pitchShift?: number;
          onSentence?: (info: {
            index: number;
            total: number;
            phonemes: string;
          }) => void;
        },
      ) => {
        this.emit({ status: "speaking", speaking: true, loadMs: 88 });
        opts.onSentence?.({
          index: 0,
          total: 1,
          phonemes: "<bos> k l ɪ k ð ɪ ɛ k s p ɔːɹ t . <eos>",
        });
        this.emit({ status: "ready", speaking: false, loadMs: 88 });
        return {
          cancelled: false,
          audio: new Float32Array([0.05, -0.05, 0.1, -0.1]),
          sampleRate: 24000,
          durationSec: 1.25,
          workSec: 0.09,
          realtimeFactor: 13.8,
          phonemes: ["<bos> k l ɪ k ð ɪ ɛ k s p ɔːɹ t . <eos>"],
        };
      },
    );

    stop = vi.fn(() => {
      this.emit({ status: "ready", speaking: false });
    });

    benchmark = vi.fn(async () => {
      this.emit({ status: "ready", loadMs: 88 });
      return {
        speed: 14.2,
        summary: "18.4 s of audio in 1.30 s = 14.2 times real time",
        parts: "matmul 62%, conv 28%, other 10%",
        lines: [
          "sentence 0 M2: 1.50 s in 0.10 s = 15.0x",
          "sentence 0 F2: 1.52 s in 0.11 s = 13.8x",
        ],
      };
    });

    dispose = vi.fn(() => {
      this.subscribers.clear();
    });

    constructor() {
      createdClients.push(this);
    }
  }

  const copilotEngine = new MockTinyVocaClient();

  return {
    listeners,
    createdClients,
    MockTinyVocaClient,
    copilotEngine,
    openUrl: vi.fn(async () => {}),
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "get_settings":
          return { ...DEFAULT_SETTINGS, onboarding_complete: true };
        case "set_settings":
          return null;
        case "list_api_key_providers":
          return ["openai"];
        case "set_api_key":
        case "delete_api_key":
          return null;
        case "ollama_status":
          return {
            running: true,
            models: ["qwen2.5vl:3b"],
            install_url: "https://ollama.com/download",
          };
        case "ollama_pull":
          return null;
        case "detect_agents":
          return [
            { id: "claude", installed: true, path: "C:\\bin\\claude.exe" },
            { id: "codex", installed: false, path: null },
          ];
        case "auth_status":
          return {
            logged_in: true,
            email: "sara@example.com",
            tier: "free",
            status: "inactive",
            usage: 42,
            limit: 1500,
          };
        case "billing_checkout":
          return {
            url:
              args?.plan === "annual"
                ? "https://checkout.stripe.test/annual"
                : "https://checkout.stripe.test/monthly",
          };
        case "history_list":
          return [
            {
              id: "sess-100",
              active_app: "Photoshop.exe",
              user_query: "How do I remove background?",
              brain_used: "groq_pro",
              created_at: 1731900000,
              step_count: 2,
            },
          ];
        case "history_get":
          return {
            session: {
              id: "sess-100",
              active_app: "Photoshop.exe",
              user_query: "How do I remove background?",
              brain_used: "groq_pro",
              created_at: 1731900000,
              step_count: 1,
            },
            steps: [
              {
                step_number: 1,
                instruction_line: "Click Object Selection Tool (W)",
                bbox: [40, 180, 32, 32],
                terminal_command: null,
                screenshot_path: null,
                completed: true,
              },
            ],
          };
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

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: mocks.openUrl,
}));

vi.mock("../lib/tinyVocaClient", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/tinyVocaClient")>(
      "../lib/tinyVocaClient",
    );
  return {
    ...actual,
    TinyVocaClient: mocks.MockTinyVocaClient,
    getCopilotVoiceEngine: () => mocks.copilotEngine,
  };
});

import { OnboardingView } from "../components/OnboardingView";
import { SettingsView } from "../components/SettingsView";

describe("OnboardingView", () => {
  beforeEach(() => {
    mocks.invoke.mockClear();
  });

  it("displays privacy disclaimer and requires consent before finishing onboarding", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();

    render(
      <OnboardingView
        settings={{ ...DEFAULT_SETTINGS, onboarding_complete: false }}
        onComplete={onComplete}
      />,
    );

    expect(screen.getByTestId("privacy-disclaimer-banner")).toHaveTextContent(
      /close sensitive windows/i,
    );

    const finishBtn = screen.getByTestId("onboarding-finish-btn");
    expect(finishBtn).toBeDisabled();

    await user.click(screen.getByTestId("privacy-accept-checkbox"));
    expect(finishBtn).toBeEnabled();

    await user.click(finishBtn);
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ onboarding_complete: true }),
      );
    });
  });
});

describe("SettingsView", () => {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  beforeEach(() => {
    mocks.invoke.mockClear();
    mocks.openUrl.mockClear();
    mocks.createdClients.length = 0;
    for (const k of Object.keys(mocks.listeners)) {
      delete mocks.listeners[k];
    }
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("stores BYO API keys via set_api_key, clears input state, pulls Ollama models, and lists agents", async () => {
    const user = userEvent.setup();
    render(<SettingsView initialSettings={{ ...DEFAULT_SETTINGS, onboarding_complete: true }} />);

    // OpenAI pre-configured badge from list_api_key_providers
    expect(await screen.findByTestId("provider-badge-openai")).toHaveTextContent(
      "Saved (••••)",
    );

    const keyInput = screen.getByTestId("api-key-input") as HTMLInputElement;
    expect(keyInput).toHaveAttribute("type", "password");

    await user.type(keyInput, "AIza-secret-demo-key");
    await user.click(screen.getByTestId("save-api-key-btn"));

    expect(mocks.invoke).toHaveBeenCalledWith("set_api_key", {
      provider: "groq",
      key: "AIza-secret-demo-key",
      apiKey: "AIza-secret-demo-key",
      api_key: "AIza-secret-demo-key",
    });
    // Key must NEVER remain in JS input state after save
    expect(keyInput.value).toBe("");
    expect(screen.getByTestId("api-key-status-msg")).toHaveTextContent(
      "Groq key saved in Windows Credential Manager.",
    );

    // Local & Routing sub-tab: Ollama pull + progress event
    await user.click(screen.getByTestId("brains-subtab-local"));
    await user.click(screen.getByTestId("ollama-pull-btn"));
    expect(mocks.invoke).toHaveBeenCalledWith("ollama_pull", {
      model: "qwen2.5vl:3b",
    });

    await act(async () => {
      mocks.emitMockEvent("ollama-pull-progress", {
        model: "qwen2.5vl:3b",
        pct: 64,
      });
    });
    expect(screen.getByTestId("ollama-pull-progress")).toHaveTextContent("64%");

    // Subscription CLIs sub-tab: Detected Agent CLI
    await user.click(screen.getByTestId("brains-subtab-clis"));
    expect(screen.getByTestId("agent-cli-list")).toHaveTextContent("Detected");
  });

  it("shows Pro $19/mo & $190/yr checkout, usage meter, and SQLite session history", async () => {
    const user = userEvent.setup();
    render(<SettingsView initialSettings={{ ...DEFAULT_SETTINGS, onboarding_complete: true }} />);

    // Settings / Privacy tab (contains Cloud Account & Pro Billing)
    await user.click(screen.getByTestId("tab-privacy"));
    expect(await screen.findByTestId("usage-count-text")).toHaveTextContent(
      "42 / 1500 requests",
    );

    await user.click(screen.getByTestId("upgrade-monthly-btn"));
    expect(mocks.invoke).toHaveBeenCalledWith("billing_checkout", {
      plan: "monthly",
      tier: "pro_monthly",
    });
    await waitFor(() => {
      expect(mocks.openUrl).toHaveBeenCalledWith(
        "https://checkout.stripe.test/monthly",
      );
    });

    // Daily Diary tab -> Guided Session History collapsible section
    await user.click(screen.getByTestId("tab-diary"));
    await user.click(screen.getByTestId("toggle-guided-history-btn"));
    const sessionBtn = await screen.findByTestId("history-item-sess-100");
    await user.click(sessionBtn);

    expect(
      await screen.findByTestId("history-session-detail"),
    ).toHaveTextContent("Click Object Selection Tool (W)");
  });

  it("renders Voice Studio tab, persists voice/speed/pitch/STT settings, and runs playground speak, WAV export, and benchmark", async () => {
    const user = userEvent.setup();
    const createObjectUrlMock = vi.fn(() => "blob:tiny-voca-test");
    const revokeObjectUrlMock = vi.fn();
    URL.createObjectURL = createObjectUrlMock;
    URL.revokeObjectURL = revokeObjectUrlMock;
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const { unmount } = render(
      <SettingsView initialSettings={{ ...DEFAULT_SETTINGS, onboarding_complete: true }} />,
    );

    // Privacy tab has quick shortcut button to Voice Studio
    await user.click(screen.getByTestId("tab-privacy"));
    await user.click(screen.getByTestId("open-voice-studio-btn"));
    expect(screen.getByTestId("panel-voice")).toBeInTheDocument();
    expect(screen.getByTestId("voice-studio")).toHaveTextContent(
      "tiny-voca Local Voice Engine · 4.5M params · 8.0 MB Offline · 24 kHz",
    );

    // Toggle voice guidance, auto-speak, hands-free conversation mode
    await user.click(screen.getByTestId("tts-auto-speak-toggle"));
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_settings",
      expect.objectContaining({
        s: expect.objectContaining({ tts_auto_speak: false }),
      }),
    );

    await user.click(screen.getByTestId("voice-conversation-mode-toggle"));
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_settings",
      expect.objectContaining({
        s: expect.objectContaining({ voice_conversation_mode: false }),
      }),
    );

    await user.click(screen.getByTestId("tts-enabled-toggle"));
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_settings",
      expect.objectContaining({
        s: expect.objectContaining({ tts_enabled: false }),
      }),
    );

    // Switch persona to F2
    await user.click(screen.getByTestId("tts-voice-F2"));
    expect(screen.getByTestId("voice-studio-active-voice")).toHaveTextContent(
      "Voice: F2",
    );

    // Adjust speaking speed and pitch shift sliders
    fireEvent.change(screen.getByTestId("tts-speed-slider"), {
      target: { value: "1.25" },
    });
    expect(screen.getByTestId("tts-speed-value")).toHaveTextContent("1.25×");

    fireEvent.change(screen.getByTestId("tts-pitch-slider"), {
      target: { value: "-0.15" },
    });
    expect(screen.getByTestId("tts-pitch-value")).toHaveTextContent("-0.15");

    // Select Cloud STT engine
    await user.selectOptions(screen.getByTestId("voice-studio-stt-select"), "cloud");
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "set_settings",
      expect.objectContaining({
        s: expect.objectContaining({
          tts_voice: "F2",
          tts_speed: 1.25,
          tts_pitch_shift: -0.15,
          stt_engine: "cloud",
        }),
      }),
    );

    // Playground: preset chip -> Play Sample -> phoneme log -> Save as WAV -> Measure Speed
    const saveWavBtn = screen.getByTestId("voice-studio-save-wav-btn");
    expect(saveWavBtn).toBeDisabled();

    await user.click(screen.getByTestId("voice-preset-welcome"));
    expect(
      (screen.getByTestId("voice-studio-textarea") as HTMLTextAreaElement).value,
    ).toContain("Welcome to GuideLens Voice Studio");

    const client = mocks.createdClients[mocks.createdClients.length - 1];
    await user.click(screen.getByTestId("voice-studio-play-btn"));

    await waitFor(() => {
      expect(client.speak).toHaveBeenCalledWith(
        expect.stringContaining("Welcome to GuideLens Voice Studio"),
        expect.objectContaining({
          voice: "F2",
          speed: 1.25,
          pitchShift: -0.15,
        }),
      );
    });
    expect(screen.getByTestId("voice-studio-log")).toHaveTextContent(
      "<bos> k l ɪ k",
    );
    expect(saveWavBtn).toBeEnabled();

    await user.click(saveWavBtn);
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    const createdBlob = (createObjectUrlMock.mock.calls[0] as unknown[])[0] as Blob;
    expect(createdBlob.type).toBe("audio/wav");
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    anchorClickSpy.mockRestore();

    await user.click(screen.getByTestId("voice-studio-benchmark-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("voice-studio-benchmark-results")).toHaveTextContent(
        "14.2 times real time",
      );
    });
    expect(screen.getByTestId("voice-studio-benchmark-results")).toHaveTextContent(
      "sentence 0 M2: 1.50 s in 0.10 s = 15.0x",
    );

    unmount();
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });
});
