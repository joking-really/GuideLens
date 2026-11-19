import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../types";

const mocks = vi.hoisted(() => {
  const listeners: Record<string, ((event: { payload: unknown }) => void)[]> =
    {};
  return {
    listeners,
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
  beforeEach(() => {
    mocks.invoke.mockClear();
    mocks.openUrl.mockClear();
    for (const k of Object.keys(mocks.listeners)) {
      delete mocks.listeners[k];
    }
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
      provider: "gemini",
      key: "AIza-secret-demo-key",
      apiKey: "AIza-secret-demo-key",
      api_key: "AIza-secret-demo-key",
    });
    // Key must NEVER remain in JS input state after save
    expect(keyInput.value).toBe("");
    expect(screen.getByTestId("api-key-status-msg")).toHaveTextContent(
      "Gemini key saved in Windows Credential Manager.",
    );

    // Ollama pull + progress event
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

    // Detected Agent CLI
    expect(screen.getByTestId("agent-cli-list")).toHaveTextContent("Detected");
  });

  it("shows Pro $19/mo & $190/yr checkout, usage meter, and SQLite session history", async () => {
    const user = userEvent.setup();
    render(<SettingsView initialSettings={{ ...DEFAULT_SETTINGS, onboarding_complete: true }} />);

    // Account tab
    await user.click(screen.getByTestId("tab-account"));
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

    // History tab
    await user.click(screen.getByTestId("tab-history"));
    const sessionBtn = await screen.findByTestId("history-item-sess-100");
    await user.click(sessionBtn);

    expect(
      await screen.findByTestId("history-session-detail"),
    ).toHaveTextContent("Click Object Selection Tool (W)");
  });
});
