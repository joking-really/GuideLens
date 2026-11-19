import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BridgeAuthError,
  BridgeClient,
  BridgeHttpError,
  GUIDELENS_TOOLS,
  GuideLensNotRunningError,
  createGuideLensMcpServer,
  getDefaultBridgeFilePath,
  handleToolCall,
  runCli,
} from "../src/index.js";

interface RecordedRequest {
  method: string;
  url: string;
  authHeader: string | undefined;
  body: unknown;
}

describe("guidelens-mcp bridge, MCP tools, and CLI", () => {
  const TEST_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const FAKE_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

  let server: http.Server;
  let port = 0;
  let tempDir = "";
  let bridgeFilePath = "";
  let recordedRequests: RecordedRequest[] = [];
  let nextStatusOverride: number | null = null;
  let nextBodyOverride: unknown = null;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "guidelens-mcp-test-"));
    bridgeFilePath = path.join(tempDir, "bridge.json");

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let parsedBody: unknown = null;
        if (rawBody.length > 0) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            parsedBody = rawBody;
          }
        }

        const authHeader = req.headers["authorization"];
        recordedRequests.push({
          method: req.method ?? "GET",
          url: req.url ?? "/",
          authHeader,
          body: parsedBody,
        });

        if (authHeader !== `Bearer ${TEST_TOKEN}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized bearer token" }));
          return;
        }

        if (nextStatusOverride !== null) {
          const status = nextStatusOverride;
          const body = nextBodyOverride ?? { error: "Simulated bridge failure" };
          nextStatusOverride = null;
          nextBodyOverride = null;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(typeof body === "string" ? body : JSON.stringify(body));
          return;
        }

        res.setHeader("Content-Type", "application/json");

        if (req.method === "GET" && req.url === "/v1/health") {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
          return;
        }

        if (req.method === "POST" && req.url === "/v1/capture") {
          res.writeHead(200);
          res.end(
            JSON.stringify({
              image_path: "C:\\Users\\mit\\AppData\\Local\\GuideLens\\captures\\cap_01.jpg",
              image_base64: FAKE_JPEG_BASE64,
              active_app: "Photoshop.exe",
              window_title: "Untitled-1 @ 100% (RGB/8)",
              monitor: { x: 0, y: 0, w: 2560, h: 1440, scale: 1.25 },
            })
          );
          return;
        }

        if (
          req.method === "POST" &&
          (req.url === "/v1/highlight" ||
            req.url === "/v1/show_command" ||
            req.url === "/v1/guide" ||
            req.url === "/v1/clear")
        ) {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          port = addr.port;
        }
        resolve();
      });
    });

    await fs.writeFile(
      bridgeFilePath,
      JSON.stringify({ port, token: TEST_TOKEN, pid: process.pid }),
      "utf8"
    );
  });

  beforeEach(() => {
    recordedRequests = [];
    nextStatusOverride = null;
    nextBodyOverride = null;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("BridgeClient HTTP contract & authentication", () => {
    it("sends Bearer token from bridge.json and parses /v1/health and /v1/capture", async () => {
      const client = new BridgeClient({ bridgeFilePath });

      const health = await client.health();
      expect(health).toEqual({ ok: true, version: "0.1.0" });

      const capture = await client.capture();
      expect(capture.active_app).toBe("Photoshop.exe");
      expect(capture.image_base64).toBe(FAKE_JPEG_BASE64);
      expect(capture.monitor).toEqual({
        x: 0,
        y: 0,
        w: 2560,
        h: 1440,
        scale: 1.25,
      });

      expect(recordedRequests).toHaveLength(2);
      expect(recordedRequests[0]?.authHeader).toBe(`Bearer ${TEST_TOKEN}`);
      expect(recordedRequests[1]?.authHeader).toBe(`Bearer ${TEST_TOKEN}`);
      expect(recordedRequests[1]?.url).toBe("/v1/capture");
      expect(recordedRequests[1]?.body).toEqual({});
    });

    it("sends exact highlight payload matching decisions.md §5", async () => {
      const client = new BridgeClient({ bridgeFilePath });
      const res = await client.highlight({
        x: 18,
        y: 240,
        width: 28,
        height: 28,
        step_label: "Step 1 of 3",
        instruction_text: "Click the Object Selection Tool in the left toolbar, or press W.",
        magnify: true,
        coords: "normalized",
      });

      expect(res).toEqual({ ok: true });
      expect(recordedRequests).toHaveLength(1);
      expect(recordedRequests[0]?.url).toBe("/v1/highlight");
      expect(recordedRequests[0]?.body).toEqual({
        x: 18,
        y: 240,
        width: 28,
        height: 28,
        coords: "normalized",
        step_label: "Step 1 of 3",
        instruction_text: "Click the Object Selection Tool in the left toolbar, or press W.",
        magnify: true,
      });
    });

    it("rejects unauthorized token with BridgeAuthError (401)", async () => {
      const badClient = new BridgeClient({
        config: { port, token: "wrong-token" },
      });

      await expect(badClient.capture()).rejects.toBeInstanceOf(BridgeAuthError);
    });

    it("throws GuideLensNotRunningError ('Start GuideLens first') when bridge.json is missing or app is unreachable", async () => {
      const missingClient = new BridgeClient({
        bridgeFilePath: path.join(tempDir, "nonexistent-bridge.json"),
      });

      await expect(missingClient.capture()).rejects.toThrow(
        /Start GuideLens first/
      );
      await expect(missingClient.clear()).rejects.toBeInstanceOf(
        GuideLensNotRunningError
      );

      // Unreachable port
      const closedPortClient = new BridgeClient({
        config: { port: 1, token: TEST_TOKEN },
        timeoutMs: 1000,
      });
      await expect(closedPortClient.highlight({
        x: 10,
        y: 10,
        width: 20,
        height: 20,
        step_label: "Step 1",
        instruction_text: "Click here.",
      })).rejects.toThrow(/Start GuideLens first/);
    });

    it("throws BridgeHttpError on 500 server error", async () => {
      nextStatusOverride = 500;
      nextBodyOverride = { error: "Capture subsystem failure" };

      const client = new BridgeClient({ bridgeFilePath });
      await expect(client.capture()).rejects.toBeInstanceOf(BridgeHttpError);
    });

    it("throws GuideLensNotRunningError on malformed bridge.json and resolves default %LOCALAPPDATA% path", async () => {
      const badJsonPath = path.join(tempDir, "bad-bridge.json");
      await fs.writeFile(badJsonPath, "{not-json", "utf8");
      const badClient = new BridgeClient({ bridgeFilePath: badJsonPath });
      await expect(badClient.health()).rejects.toThrow(/Start GuideLens first/);

      expect(
        getDefaultBridgeFilePath({
          LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
        })
      ).toBe(path.join("C:\\Users\\demo\\AppData\\Local", "GuideLens", "bridge.json"));

      expect(
        getDefaultBridgeFilePath({
          GUIDELENS_BRIDGE_FILE: "D:\\custom\\bridge.json",
          LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
        })
      ).toBe("D:\\custom\\bridge.json");
    });
  });

  describe("MCP Tools (capture_screen, highlight, show_command, guide, clear)", () => {
    it("exposes all 5 required MCP tools", () => {
      const toolNames = GUIDELENS_TOOLS.map((t) => t.name);
      expect(toolNames).toEqual([
        "capture_screen",
        "highlight",
        "show_command",
        "guide",
        "clear",
      ]);
    });

    it("capture_screen returns MCP image content + metadata text", async () => {
      const client = new BridgeClient({ bridgeFilePath });
      const result = await handleToolCall("capture_screen", {}, client);

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(2);

      const imageContent = result.content[0];
      expect(imageContent).toEqual({
        type: "image",
        data: FAKE_JPEG_BASE64,
        mimeType: "image/jpeg",
      });

      const textContent = result.content[1];
      expect(textContent?.type).toBe("text");
      if (textContent?.type === "text") {
        const meta = JSON.parse(textContent.text) as Record<string, unknown>;
        expect(meta.active_app).toBe("Photoshop.exe");
        expect(meta.window_title).toBe("Untitled-1 @ 100% (RGB/8)");
        expect(meta.monitor).toEqual({
          x: 0,
          y: 0,
          w: 2560,
          h: 1440,
          scale: 1.25,
        });
      }
    });

    it("highlight, show_command, guide, and clear send valid payloads via MCP tool handler", async () => {
      const client = new BridgeClient({ bridgeFilePath });

      const hlRes = await handleToolCall(
        "highlight",
        {
          x: 100,
          y: 200,
          width: 50,
          height: 30,
          step_label: "Step 1",
          instruction_text: "Click Export in the top-right corner.",
        },
        client
      );
      expect(hlRes.isError).toBeUndefined();
      expect(recordedRequests.at(-1)?.body).toEqual({
        x: 100,
        y: 200,
        width: 50,
        height: 30,
        coords: "normalized",
        step_label: "Step 1",
        instruction_text: "Click Export in the top-right corner.",
        magnify: false,
      });

      const cmdRes = await handleToolCall(
        "show_command",
        {
          command: "git reset --soft HEAD~1",
          explanation: "Undo last commit while keeping changes staged.",
        },
        client
      );
      expect(cmdRes.isError).toBeUndefined();
      expect(recordedRequests.at(-1)?.url).toBe("/v1/show_command");
      expect(recordedRequests.at(-1)?.body).toEqual({
        command: "git reset --soft HEAD~1",
        explanation: "Undo last commit while keeping changes staged.",
      });

      const plan = {
        mode: "guide" as const,
        total_steps: 2,
        steps: [
          {
            step_number: 1,
            instruction_line: "Click the Object Selection Tool, or press W.",
            target_name: "Object Selection Tool",
            control_type: "Button",
            bbox: [18, 240, 28, 28] as [number, number, number, number],
            confidence: 0.92,
            shortcut: "W",
            terminal_command: null,
            explanation: null,
          },
          {
            step_number: 2,
            instruction_line: "Click Select Subject in the options bar.",
            target_name: "Select Subject",
            control_type: "Button",
            bbox: [420, 48, 110, 28] as [number, number, number, number],
            confidence: 0.88,
            shortcut: null,
            terminal_command: null,
            explanation: null,
          },
        ],
      };

      const guideRes = await handleToolCall("guide", { plan }, client);
      expect(guideRes.isError).toBeUndefined();
      expect(recordedRequests.at(-1)?.url).toBe("/v1/guide");
      expect(recordedRequests.at(-1)?.body).toEqual({ plan });

      const clearRes = await handleToolCall("clear", {}, client);
      expect(clearRes.isError).toBeUndefined();
      expect(recordedRequests.at(-1)?.url).toBe("/v1/clear");
    });

    it("returns isError with 'Start GuideLens first' when GuideLens is not running", async () => {
      const offlineClient = new BridgeClient({
        bridgeFilePath: path.join(tempDir, "missing.json"),
      });

      const res = await handleToolCall("capture_screen", {}, offlineClient);
      expect(res.isError).toBe(true);
      expect(res.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Start GuideLens first"),
      });
    });

    it("enforces <= 140 character limit on instruction_text and instruction_line", async () => {
      const client = new BridgeClient({ bridgeFilePath });
      const tooLong = "A".repeat(141);

      const res = await handleToolCall(
        "highlight",
        {
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          step_label: "Step 1",
          instruction_text: tooLong,
        },
        client
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("<= 140 characters"),
      });
    });

    it("serves full MCP JSON-RPC protocol via @modelcontextprotocol/sdk Server + Client", async () => {
      const { server: mcpServer } = createGuideLensMcpServer({
        bridgeFilePath,
      });
      const mcpClient = new Client(
        { name: "vitest-client", version: "1.0.0" },
        { capabilities: {} }
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();

      await Promise.all([
        mcpServer.connect(serverTransport),
        mcpClient.connect(clientTransport),
      ]);

      try {
        const listed = await mcpClient.listTools();
        expect(listed.tools.map((t) => t.name)).toEqual([
          "capture_screen",
          "highlight",
          "show_command",
          "guide",
          "clear",
        ]);

        const capRes = await mcpClient.callTool({
          name: "capture_screen",
          arguments: {},
        });
        expect(capRes.isError).toBeFalsy();
        const capContent = capRes.content as Array<Record<string, unknown>>;
        expect(capContent[0]).toEqual({
          type: "image",
          data: FAKE_JPEG_BASE64,
          mimeType: "image/jpeg",
        });

        const hlRes = await mcpClient.callTool({
          name: "highlight",
          arguments: {
            x: 120,
            y: 340,
            width: 80,
            height: 40,
            step_label: "Step 1 of 2",
            instruction_text: "Click Export Media in the File menu.",
            magnify: true,
          },
        });
        expect(hlRes.isError).toBeFalsy();
        expect(recordedRequests.at(-1)?.authHeader).toBe(`Bearer ${TEST_TOKEN}`);
        expect(recordedRequests.at(-1)?.url).toBe("/v1/highlight");

        const clearRes = await mcpClient.callTool({
          name: "clear",
          arguments: {},
        });
        expect(clearRes.isError).toBeFalsy();
        expect(recordedRequests.at(-1)?.url).toBe("/v1/clear");
      } finally {
        await mcpClient.close();
        await mcpServer.close();
      }
    });
  });

  describe("CLI (guidelens capture, highlight, command, guide, clear, install)", () => {
    function createTestIo() {
      const out: string[] = [];
      const err: string[] = [];
      return {
        out,
        err,
        io: {
          stdout: (msg: string) => out.push(msg),
          stderr: (msg: string) => err.push(msg),
        },
      };
    }

    it("runs `guidelens capture --out <file>` and writes decoded JPEG image", async () => {
      const { out, err, io } = createTestIo();
      const outFile = path.join(tempDir, "captured.jpg");

      const code = await runCli(["capture", "--out", outFile], io, {
        bridgeFilePath,
      });
      expect(code).toBe(0);
      expect(err).toHaveLength(0);

      const fileBytes = await fs.readFile(outFile);
      expect(fileBytes.toString("base64")).toBe(FAKE_JPEG_BASE64);

      const printed = JSON.parse(out[0] ?? "{}") as { saved_to: string };
      expect(printed.saved_to).toBe(outFile);
    });

    it("runs `guidelens highlight`, `guidelens command`, `guidelens guide`, and `guidelens clear`", async () => {
      const { err, io } = createTestIo();

      expect(
        await runCli(
          [
            "highlight",
            "15",
            "25",
            "50",
            "60",
            "Step 1 of 2",
            "Click the Layers panel tab.",
            "--magnify",
            "--coords",
            "pixels",
          ],
          io,
          { bridgeFilePath }
        )
      ).toBe(0);

      expect(recordedRequests.at(-1)?.body).toEqual({
        x: 15,
        y: 25,
        width: 50,
        height: 60,
        coords: "pixels",
        step_label: "Step 1 of 2",
        instruction_text: "Click the Layers panel tab.",
        magnify: true,
      });

      expect(
        await runCli(
          [
            "command",
            "git status -sb",
            "Show short branch and working-tree status.",
          ],
          io,
          { bridgeFilePath }
        )
      ).toBe(0);
      expect(recordedRequests.at(-1)?.body).toEqual({
        command: "git status -sb",
        explanation: "Show short branch and working-tree status.",
      });

      const planFile = path.join(tempDir, "plan.json");
      const samplePlan = {
        mode: "guide",
        total_steps: 1,
        steps: [
          {
            step_number: 1,
            instruction_line: "Click the Save button, or press Ctrl+S.",
            target_name: "Save",
            control_type: "Button",
            bbox: [10, 10, 40, 24],
            confidence: 0.95,
            shortcut: "Ctrl+S",
            terminal_command: null,
            explanation: null,
          },
        ],
      };
      await fs.writeFile(planFile, JSON.stringify(samplePlan), "utf8");

      expect(
        await runCli(["guide", planFile], io, { bridgeFilePath })
      ).toBe(0);
      expect(recordedRequests.at(-1)?.url).toBe("/v1/guide");
      expect(recordedRequests.at(-1)?.body).toEqual({ plan: samplePlan });

      expect(await runCli(["clear"], io, { bridgeFilePath })).toBe(0);
      expect(recordedRequests.at(-1)?.url).toBe("/v1/clear");
      expect(err).toHaveLength(0);
    });

    it("runs `guidelens install <claude|codex|gemini|antigravity|hermes>` printing and writing configs", async () => {
      for (const agent of [
        "claude",
        "codex",
        "gemini",
        "antigravity",
        "hermes",
      ] as const) {
        const { out, err, io } = createTestIo();
        const cfgFile = path.join(
          tempDir,
          `config-${agent}.${agent === "codex" ? "toml" : "json"}`
        );

        const code = await runCli(
          ["install", agent, "--write", "--config", cfgFile],
          io
        );
        expect(code).toBe(0);
        expect(out[0]).toContain("guidelens");
        expect(err[0]).toContain(cfgFile);

        const diskContent = await fs.readFile(cfgFile, "utf8");
        if (agent === "codex") {
          expect(diskContent).toContain("[mcp_servers.guidelens]");
          expect(diskContent).toContain('command = "guidelens"');
        } else {
          const parsed = JSON.parse(diskContent) as {
            mcpServers: { guidelens: { command: string; args: string[] } };
          };
          expect(parsed.mcpServers.guidelens).toEqual({
            command: "guidelens",
            args: ["mcp"],
          });
        }
      }
    });

    it("supports named highlight flags, install print-only + merge preservation, and offline error exit code", async () => {
      const { out, err, io } = createTestIo();

      // Named flags for highlight
      expect(
        await runCli(
          [
            "highlight",
            "--x",
            "50",
            "--y",
            "80",
            "--width",
            "40",
            "--height",
            "20",
            "--step-label",
            "Step 2",
            "--instruction-text",
            "Click Render.",
            "--magnify",
          ],
          io,
          { bridgeFilePath }
        )
      ).toBe(0);
      expect(recordedRequests.at(-1)?.body).toEqual({
        x: 50,
        y: 80,
        width: 40,
        height: 20,
        coords: "normalized",
        step_label: "Step 2",
        instruction_text: "Click Render.",
        magnify: true,
      });

      // Print-only install
      out.length = 0;
      err.length = 0;
      expect(await runCli(["install", "claude"], io)).toBe(0);
      expect(JSON.parse(out[0] ?? "{}")).toEqual({
        mcpServers: {
          guidelens: { command: "guidelens", args: ["mcp"] },
        },
      });
      expect(err).toHaveLength(0);

      // Merge into existing JSON config without clobbering existing servers
      const existingJson = path.join(tempDir, "existing-claude.json");
      await fs.writeFile(
        existingJson,
        JSON.stringify({
          theme: "dark",
          mcpServers: { other: { command: "other-mcp", args: [] } },
        }),
        "utf8"
      );
      expect(
        await runCli(["install", "claude", "--write", "--config", existingJson], io)
      ).toBe(0);
      const mergedJson = JSON.parse(await fs.readFile(existingJson, "utf8")) as {
        theme: string;
        mcpServers: Record<string, unknown>;
      };
      expect(mergedJson.theme).toBe("dark");
      expect(mergedJson.mcpServers.other).toEqual({
        command: "other-mcp",
        args: [],
      });
      expect(mergedJson.mcpServers.guidelens).toEqual({
        command: "guidelens",
        args: ["mcp"],
      });

      // Merge into existing TOML config (CRLF) without clobbering sibling sections
      const existingToml = path.join(tempDir, "existing-codex.toml");
      await fs.writeFile(
        existingToml,
        'model = "o3"\r\n\r\n[mcp_servers.guidelens]\r\ncommand = "old"\r\nargs = []\r\n\r\n[mcp_servers.other]\r\ncommand = "other"\r\n',
        "utf8"
      );
      expect(
        await runCli(["install", "codex", "--write", "--config", existingToml], io)
      ).toBe(0);
      const mergedToml = await fs.readFile(existingToml, "utf8");
      expect(mergedToml).toContain('model = "o3"');
      expect(mergedToml).toContain('command = "guidelens"');
      expect(mergedToml).toContain("[mcp_servers.other]");

      // Offline error path returns exit code 1 with "Start GuideLens first"
      err.length = 0;
      const offlineCode = await runCli(["clear"], io, {
        bridgeFilePath: path.join(tempDir, "does-not-exist.json"),
      });
      expect(offlineCode).toBe(1);
      expect(err.join("\n")).toContain("Start GuideLens first");
    });
  });
});
