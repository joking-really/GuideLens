import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../types";

const mocks = vi.hoisted(() => {
  const listeners: Record<string, ((event: { payload: unknown }) => void)[]> =
    {};
  return {
    listeners,
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
    static async getByLabel() {
      return null;
    }
  },
}));

import { FloatingBar } from "../components/FloatingBar";

describe("FloatingBar", () => {
  beforeEach(() => {
    mocks.invoke.mockClear();
    for (const k of Object.keys(mocks.listeners)) {
      delete mocks.listeners[k];
    }
  });

  it("renders compact 480x52 drag bar, focuses input on bar-summoned, and cycles brain modes", async () => {
    const user = userEvent.setup();
    render(<FloatingBar initialSettings={{ onboarding_complete: true, brain_mode: "local_vlm" }} />);

    const bar = screen.getByTestId("floating-bar");
    expect(bar).toHaveAttribute("data-tauri-drag-region");
    expect(bar.className).toContain("w-[480px]");
    expect(bar.className).toContain("h-[52px]");

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

    // Cycle brains: Local -> BYO: Gemini -> Groq Pro -> Agent: Claude -> Auto
    await user.click(pill);
    expect(pill).toHaveTextContent("BYO: Gemini");

    await user.click(pill);
    expect(pill).toHaveTextContent("Groq Pro");

    await user.click(pill);
    expect(pill).toHaveTextContent("Agent: Claude");

    await user.click(pill);
    expect(pill).toHaveTextContent("Auto");
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

    delete window.SpeechRecognition;
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
});
