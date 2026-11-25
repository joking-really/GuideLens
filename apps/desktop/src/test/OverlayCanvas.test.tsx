import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepChangedPayload } from "../types";

const mocks = vi.hoisted(() => {
  const listeners: Record<string, ((event: { payload: unknown }) => void)[]> =
    {};
  return {
    listeners,
    invoke: vi.fn(async (cmd: string) => {
      if (cmd === "get_settings") {
        return { high_contrast: false, always_magnify: false };
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
    innerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
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

import { OverlayCanvas } from "../components/OverlayCanvas";

describe("OverlayCanvas", () => {
  beforeEach(() => {
    for (const k of Object.keys(mocks.listeners)) {
      delete mocks.listeners[k];
    }
  });

  it("renders empty overlay when confidence is < 0.5 (text-only fallback)", () => {
    const lowConfPayload: StepChangedPayload = {
      step: {
        step_number: 1,
        instruction_line: "Open Export menu",
        confidence: 0.3,
        rect_px: { x: 100, y: 100, w: 60, h: 24 },
        source: "none",
      },
      index: 0,
      total: 2,
    };

    render(<OverlayCanvas initialPayload={lowConfPayload} />);
    expect(screen.getByTestId("overlay-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("overlay-highlight-box")).toBeNull();
  });

  it("renders crisp monochrome white highlight box, compact step chip, and clears on overlay-cleared", async () => {
    render(<OverlayCanvas />);
    expect(screen.getByTestId("overlay-empty")).toBeInTheDocument();

    await act(async () => {
      mocks.emitMockEvent("step-changed", {
        step: {
          step_number: 1,
          instruction_line: "Click Object Selection Tool",
          confidence: 0.92,
          rect_px: { x: 40, y: 180, w: 32, h: 32 },
          source: "uia",
        },
        index: 0,
        total: 4,
        magnify: false,
        high_contrast: false,
      });
    });

    const box = screen.getByTestId("overlay-highlight-box");
    expect(box).toHaveStyle({
      left: "40px",
      top: "180px",
      width: "32px",
      height: "32px",
      borderColor: "rgba(255, 255, 255, 0.92)",
    });
    expect(screen.getByTestId("overlay-step-badge")).toHaveTextContent(
      "1 / 4",
    );
    expect(screen.getByTestId("companion-speech-bubble")).toHaveTextContent(
      "1 / 4",
    );
    expect(screen.queryByTestId("overlay-magnifier-lens")).toBeNull();

    await act(async () => {
      mocks.emitMockEvent("overlay-cleared", {});
    });

    expect(screen.getByTestId("overlay-empty")).toBeInTheDocument();
  });

  it("uses high-contrast #FACC15 accent and auto-activates 2.5x magnifier for <24x24px targets", async () => {
    render(<OverlayCanvas />);

    await act(async () => {
      mocks.emitMockEvent("step-changed", {
        step: {
          step_number: 2,
          instruction_line: "Click tiny keyframe diamond",
          confidence: 0.88,
          rect_px: { x: 250, y: 500, w: 14, h: 14 },
          source: "vlm",
        },
        index: 1,
        total: 3,
        magnify: false,
        high_contrast: true,
        capture_path: "C:\\captures\\shot.jpg",
      });
    });

    const box = screen.getByTestId("overlay-highlight-box");
    expect(box).toHaveAttribute("data-high-contrast", "true");
    expect(box).toHaveStyle({ borderColor: "#FACC15" });

    const lens = screen.getByTestId("overlay-magnifier-lens");
    expect(lens).toHaveAttribute("data-zoom", "2.5");
    expect(screen.getByTestId("magnifier-zoom-badge")).toHaveTextContent("2.5×");
  });

  it("renders wandering companion with Screen Day diary indicator on overlay-empty and stays click-through", async () => {
    render(<OverlayCanvas />);
    expect(screen.getByTestId("overlay-empty")).toBeInTheDocument();

    await act(async () => {
      mocks.emitMockEvent("overlay-companion", {
        mode: "wander",
        companion_id: "tech_nerd",
        emotion: "peeking",
        wander: true,
        x: null,
        y: null,
        bubble_text: "Recording Screen Day",
        screenday_recording: true,
      });
    });

    const emptyRoot = screen.getByTestId("overlay-empty");
    expect(emptyRoot.className).toContain("pointer-events-none");

    const sprite = screen.getByTestId("companion-sprite");
    expect(sprite).toHaveAttribute("data-companion", "tech_nerd");
    expect(sprite).toHaveAttribute("data-emotion", "peeking");
    expect(screen.getByTestId("screenday-companion-indicator")).toHaveTextContent("Diary");
    expect(screen.getByTestId("companion-speech-bubble")).toHaveTextContent("Recording Screen Day");
  });

  it("anchors companion speech bubble with action/shortcut badges and handles bonk & preview celebrate", async () => {
    render(<OverlayCanvas />);

    await act(async () => {
      mocks.emitMockEvent("step-changed", {
        step: {
          step_number: 1,
          instruction_line: "Open Export settings",
          confidence: 0.92,
          shortcut: "Ctrl+E",
          action_kind: "click",
          companion_emotion: "bonk",
          rect_px: { x: 420, y: 240, w: 96, h: 36 },
          source: "som",
        },
        index: 0,
        total: 2,
      });
    });

    const sprite = screen.getByTestId("companion-sprite");
    expect(sprite).toHaveAttribute("data-emotion", "bonk");
    expect(screen.getByTestId("companion-fx-bonk")).toBeInTheDocument();
    expect(screen.getByTestId("companion-shortcut-badge")).toHaveTextContent("Ctrl+E");
    expect(screen.getByTestId("companion-action-badge")).toHaveTextContent("Click");

    await act(async () => {
      mocks.emitMockEvent("overlay-cleared", {});
      mocks.emitMockEvent("overlay-companion", {
        mode: "preview",
        companion_id: "anime_guide",
        emotion: "celebrate",
        wander: false,
        x: null,
        y: null,
        bubble_text: "Goal complete!",
        screenday_recording: false,
      });
    });

    expect(screen.getByTestId("companion-sprite")).toHaveAttribute("data-companion", "anime_guide");
    expect(screen.getByTestId("companion-sprite")).toHaveAttribute("data-emotion", "celebrate");
    expect(screen.getByTestId("companion-fx-celebrate")).toBeInTheDocument();
  });
});
