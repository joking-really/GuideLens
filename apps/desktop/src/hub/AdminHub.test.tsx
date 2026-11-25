import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      speed: 12,
      summary: "12x",
      parts: "",
      lines: [],
    }));
    dispose = vi.fn();
  }

  const copilotEngine = new MockTinyVocaClient();

  const sampleDayDetail = {
    summary: {
      day_key: "2026-11-24",
      folder_path: "C:\\Users\\test\\AppData\\Local\\GuideLens\\days\\2026-11-24",
      frame_count: 2,
      total_bytes: 98304,
      session_count: 1,
      projects: ["GuideLens"],
      meetings: ["Zoom Standup"],
      summary_md: "## Daily Summary\nShipped v2 Live Copilot.",
      graph_md_path: "C:\\Users\\test\\AppData\\Local\\GuideLens\\days\\2026-11-24\\day-graph.md",
      updated_at: 1732440000,
    },
    frames: [
      {
        id: "f1",
        day_key: "2026-11-24",
        captured_at: 1732436400,
        image_path: "C:\\Users\\test\\AppData\\Local\\GuideLens\\days\\2026-11-24\\frames\\090000.jpg",
        active_app: "Code.exe",
        window_title: "AdminHub.tsx - GuideLens - Visual Studio Code",
        project_name: "GuideLens",
        meeting_name: null,
        ocr_excerpt: "export const AdminHub",
        dhash: "001122",
        file_bytes: 49152,
      },
      {
        id: "f2",
        day_key: "2026-11-24",
        captured_at: 1732440000,
        image_path: "C:\\Users\\test\\AppData\\Local\\GuideLens\\days\\2026-11-24\\frames\\100000.jpg",
        active_app: "Zoom.exe",
        window_title: "Zoom Meeting - Sprint Sync",
        project_name: "GuideLens",
        meeting_name: "Zoom Standup",
        ocr_excerpt: "Q4 Latency Targets: <200ms grounding",
        dhash: "aabbcc",
        file_bytes: 49152,
      },
    ],
    project_groups: [
      {
        name: "GuideLens",
        frame_count: 2,
        apps: ["Code.exe", "Zoom.exe"],
      },
    ],
    meeting_groups: [
      {
        name: "Zoom Standup",
        started_at: 1732439600,
        ended_at: 1732440000,
        frame_count: 1,
        screen_topics: ["Q4 Latency Targets: <200ms grounding"],
      },
    ],
    sessions: [],
    day_graph_md: "```mermaid\nflowchart LR\nDay --> GuideLens\n```",
    day_diary_md: "# 2026-11-24 Diary\nWorked on GuideLens.",
  };

  let kgState = {
    nodes: [
      {
        id: "n-app",
        node_type: "app",
        app_exe: "Code.exe",
        label: "VS Code",
        metadata_json: null,
        hit_count: 14,
        updated_at: 1732440000,
      },
      {
        id: "n-ctrl",
        node_type: "control",
        app_exe: "Code.exe",
        label: "Run and Debug",
        metadata_json: null,
        hit_count: 9,
        updated_at: 1732440000,
      },
    ],
    edges: [
      {
        id: "e-1",
        from_node: "n-app",
        to_node: "n-ctrl",
        relation: "contains",
        intent: "Start debugger",
        control_name: "Run and Debug",
        control_type: "Button",
        shortcut: "F5",
        norm_bbox: [10, 200, 40, 40],
        success_count: 9,
        updated_at: 1732440000,
      },
    ],
    sessions: [
      {
        session_id: "sg-1",
        day_key: "2026-11-24",
        active_app: "Code.exe",
        goal: "Configure VS Code launch.json",
        graph_md_path: "C:\\Users\\test\\AppData\\Local\\GuideLens\\days\\2026-11-24\\sessions\\launch.graph.md",
        node_count: 2,
        edge_count: 1,
        completed: true,
        created_at: 1732440000,
      },
    ],
    master_md_path: "C:\\Users\\test\\AppData\\Local\\GuideLens\\memory\\knowledge-graph.md",
  };

  return {
    listeners,
    copilotEngine,
    MockTinyVocaClient,
    sampleDayDetail,
    resetKg() {
      kgState = {
        ...kgState,
        nodes: [...kgState.nodes],
      };
    },
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "get_settings":
          return { ...DEFAULT_SETTINGS, onboarding_complete: true };
        case "set_settings":
          return null;
        case "list_api_key_providers":
          return ["openrouter"];
        case "ollama_status":
          return { running: true, models: ["qwen2.5vl:3b"], install_url: "https://ollama.com/download" };
        case "detect_agents":
          return [
            { id: "claude", installed: true, path: "C:\\bin\\claude.exe" },
            { id: "copilot", installed: true, path: "C:\\bin\\gh.exe" },
          ];
        case "auth_status":
          return { logged_in: false, email: null, tier: "free", status: "inactive", usage: 10, limit: 1500 };
        case "history_list":
          return [];
        case "get_live_session":
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
        case "start_live_session":
          return {
            session_id: "live-99",
            status: "guiding",
            goal: String(args?.goal ?? ""),
            companion_id: "pixel_cat",
            current_step: {
              step_number: 1,
              instruction_line: "Click the Debug sidebar icon",
              confidence: 0.95,
              rect_px: { x: 12, y: 180, w: 36, h: 36 },
              source: "som",
            },
            current_monitor: null,
            turn_count: 1,
            turns: [],
            graph_md_path: null,
            started_at: 1732440000,
          };
        case "end_live_session":
          return {
            session_id: "live-99",
            status: "completed",
            goal: "Done",
            companion_id: "pixel_cat",
            current_step: null,
            current_monitor: null,
            turn_count: 1,
            turns: [],
            graph_md_path: null,
            started_at: 1732440000,
          };
        case "screenday_status":
          return {
            enabled: false,
            interval_sec: 15,
            today_key: "2026-11-24",
            today_frames: 2,
            today_bytes: 98304,
            last_captured_at: 1732440000,
            current_project: "GuideLens",
            current_meeting: "Zoom Standup",
            skipped_private: false,
          };
        case "screenday_set_enabled":
          return {
            enabled: Boolean(args?.enabled),
            interval_sec: 15,
            today_key: "2026-11-24",
            today_frames: 2,
            today_bytes: 98304,
            last_captured_at: 1732440000,
            current_project: "GuideLens",
            current_meeting: "Zoom Standup",
            skipped_private: false,
          };
        case "screenday_list_days":
          return [sampleDayDetail.summary];
        case "screenday_get_day":
          return sampleDayDetail;
        case "screenday_generate_summary":
          return sampleDayDetail;
        case "get_latency_stats":
          return {
            count: 2,
            average: {
              capture_ms: 12,
              grounding_ms: 34,
              memory_ms: 2,
              llm_ms: 210,
              total_ms: 258,
            },
            recent: [
              { capture_ms: 14, grounding_ms: 36, memory_ms: 2, llm_ms: 220, total_ms: 272 },
              { capture_ms: 10, grounding_ms: 32, memory_ms: 2, llm_ms: 200, total_ms: 244 },
            ],
          };
        case "get_knowledge_graph":
          return kgState;
        case "list_session_graphs":
          return kgState.sessions;
        case "read_graph_markdown":
          return "---\nsession_id: sg-1\n---\n```mermaid\nflowchart LR\nCode --> RunDebug\n```";
        case "delete_memory_node": {
          const targetId = String(args?.nodeId ?? args?.id ?? "");
          kgState = {
            ...kgState,
            nodes: kgState.nodes.filter((n) => n.id !== targetId),
          };
          return null;
        }
        case "test_brain_connection":
          return {
            ok: true,
            brain: String(args?.brain ?? "byo_api"),
            provider: args?.provider ?? "openrouter",
            model: args?.model ?? "google/gemma-3-27b-it",
            latency_ms: 142,
            message: "OpenRouter responded cleanly",
          };
        case "preview_companion":
          return null;
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
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
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

vi.mock("../lib/tinyVocaClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/tinyVocaClient")>(
    "../lib/tinyVocaClient",
  );
  return {
    ...actual,
    TinyVocaClient: mocks.MockTinyVocaClient,
    getCopilotVoiceEngine: () => mocks.copilotEngine,
  };
});

import App from "../App";
import { AdminHub } from "./AdminHub";

describe("AdminHub Control Center", () => {
  beforeEach(() => {
    mocks.invoke.mockClear();
    mocks.copilotEngine.speak.mockClear();
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("renders minimalist AdminHub Overview on /hub route with calm header, Live Session, Screen Day, and 3-column metrics", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/hub");
    render(<App />);

    expect(await screen.findByTestId("panel-overview")).toBeInTheDocument();
    expect(await screen.findByTestId("topbar-status-summary")).toHaveTextContent("258ms");
    expect(screen.getByTestId("panel-overview")).toHaveTextContent("Avg Response");
    expect(screen.getByTestId("panel-overview")).toHaveTextContent("258 ms");
    expect(screen.getByTestId("panel-overview")).toHaveTextContent("Frames Today");
    expect(screen.getByTestId("panel-overview")).toHaveTextContent("Learned Paths");

    // Cluttered 5-pill header & duplicate history link & unauthenticated account block are removed
    expect(screen.queryByTestId("topbar-test-peek-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tab-history")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tab-account")).not.toBeInTheDocument();

    // Start & stop Live Session
    await user.type(screen.getByTestId("live-goal-input"), "Debug Rust build");
    await user.click(screen.getByTestId("start-live-session-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("live-session-status-badge")).toHaveTextContent("guiding");
    });
    expect(screen.getByTestId("panel-overview")).toHaveTextContent("Click the Debug sidebar icon");

    await user.click(screen.getByTestId("end-live-session-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("live-session-status-badge")).toHaveTextContent("completed");
    });

    // Screen Day toggle + Capture Now
    await user.click(screen.getByTestId("overview-screenday-toggle"));
    expect(mocks.invoke).toHaveBeenCalledWith("screenday_set_enabled", { enabled: true });
  });

  it("navigates across Diary, Knowledge Graph, Companions & Voice, Brains segmented sub-tabs, and Settings", async () => {
    const user = userEvent.setup();
    render(
      <AdminHub
        initialSettings={{ ...DEFAULT_SETTINGS, onboarding_complete: true }}
        initialTab="overview"
      />,
    );

    // 1. Diary tab: projects, meetings OCR topics, .graph.md modal, Generate Summary, collapsible Guided History
    await user.click(screen.getByTestId("tab-diary"));
    expect(await screen.findByTestId("screenday-projects-section")).toHaveTextContent("GuideLens");
    expect(screen.getByTestId("screenday-meetings-section")).toHaveTextContent(
      "Q4 Latency Targets: <200ms grounding",
    );
    expect(screen.queryByTestId("history-session-list")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("toggle-guided-history-btn"));
    expect(screen.getByTestId("panel-history")).toHaveTextContent("Guided Session History");

    await user.click(screen.getByTestId("open-day-graph-modal-btn"));
    expect(screen.getByRole("dialog")).toHaveTextContent("flowchart LR");
    await user.click(screen.getByLabelText("Close Preview"));

    await user.click(screen.getByTestId("generate-nightly-wrapup-btn"));
    expect(mocks.invoke).toHaveBeenCalledWith("screenday_generate_summary", {
      dayKey: "2026-11-24",
      day_key: "2026-11-24",
    });

    // 2. Knowledge Graph tab: SVG nodes, inspector, deleteMemoryNode, .graph.md viewer
    await user.click(screen.getByTestId("tab-graph"));
    const nodeCtrl = await screen.findByTestId("kg-node-n-ctrl");
    expect(screen.getByTestId("graph-markdown-viewer")).toHaveTextContent("Code --> RunDebug");

    await act(async () => {
      fireEvent.click(nodeCtrl);
    });
    expect(screen.getByTestId("kg-node-inspector")).toHaveTextContent("Run and Debug");

    await user.click(screen.getByTestId("kg-delete-node-btn"));
    expect(mocks.invoke).toHaveBeenCalledWith("delete_memory_node", {
      nodeId: "n-ctrl",
      node_id: "n-ctrl",
      id: "n-ctrl",
    });

    // 3. Companions & Voice tab: 4 personas, stage reaction buttons, companion_wander
    await user.click(screen.getByTestId("tab-companions"));
    await user.click(screen.getByTestId("companion-card-anime_guide"));
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_settings",
      expect.objectContaining({
        s: expect.objectContaining({ companion_id: "anime_guide" }),
      }),
    );

    await user.click(screen.getByTestId("companion-react-bonk"));
    expect(mocks.invoke).toHaveBeenCalledWith(
      "preview_companion",
      expect.objectContaining({ companionId: "anime_guide", emotion: "bonk" }),
    );

    await user.click(screen.getByTestId("companion-wander-toggle"));
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_settings",
      expect.objectContaining({
        s: expect.objectContaining({ companion_wander: false }),
      }),
    );

    // 4. Models & Agents tab: 3 segmented sub-tabs, OpenRouter preset, CLI list, Local & Routing, Test Connection
    await user.click(screen.getByTestId("tab-brains"));
    await user.click(screen.getByTestId("openrouter-preset-google/gemma-3-27b-it"));
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_settings",
      expect.objectContaining({
        s: expect.objectContaining({
          byo_provider: "openrouter",
          byo_model: "google/gemma-3-27b-it",
        }),
      }),
    );

    await user.click(screen.getByTestId("brains-subtab-clis"));
    expect(screen.getByTestId("agent-cli-list")).toHaveTextContent("Detected");

    await user.click(screen.getByTestId("brains-subtab-local"));
    expect(screen.getByTestId("ollama-running-badge")).toHaveTextContent("Running");

    await user.click(screen.getByTestId("test-brain-connection-btn"));
    expect(await screen.findByTestId("connection-test-result")).toHaveTextContent("142 ms");

    // 5. Settings (Privacy & System) tab: excluded apps chip, interval slider
    await user.click(screen.getByTestId("tab-privacy"));
    await user.type(screen.getByTestId("excluded-app-input"), "1password.exe");
    await user.click(screen.getByTestId("add-excluded-app-btn"));
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_settings",
      expect.objectContaining({
        s: expect.objectContaining({
          screenday_excluded_apps: ["1password.exe"],
        }),
      }),
    );

    fireEvent.change(screen.getByTestId("screenday-interval-slider"), {
      target: { value: "30" },
    });
    expect(screen.getByTestId("screenday-interval-value")).toHaveTextContent("30s");
  }, 15000);
});
