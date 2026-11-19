#!/usr/bin/env node
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient, BridgeClientOptions } from "./bridge.js";
import { getAgentConfigInfo, writeAgentConfig } from "./install.js";
import { startStdioMcpServer } from "./server.js";
import {
  CoordsModeSchema,
  SUPPORTED_AGENTS,
  StepPlanInput,
  StepPlanSchema,
} from "./types.js";

export interface CliIo {
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

const defaultIo: CliIo = {
  stdout: (msg: string) => process.stdout.write(`${msg}\n`),
  stderr: (msg: string) => process.stderr.write(`${msg}\n`),
};

export function getHelpText(): string {
  return [
    "GuideLens CLI & MCP Bridge (guidelens)",
    "",
    "Usage:",
    "  guidelens capture [--out <file>]",
    "  guidelens highlight <x> <y> <width> <height> <step_label> <instruction_text> [--magnify] [--coords normalized|pixels]",
    '  guidelens command "<cmd>" "<explanation>"',
    "  guidelens guide <plan.json>",
    "  guidelens clear",
    "  guidelens mcp",
    `  guidelens install <${SUPPORTED_AGENTS.join("|")}> [--write] [--config <path>]`,
    "",
    "Options:",
    "  --bridge-file <path>   Override path to bridge.json (defaults to %LOCALAPPDATA%\\GuideLens\\bridge.json)",
    "  --help, -h             Show this help message",
  ].join("\n");
}

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (
          key === "magnify" ||
          key === "write" ||
          key === "help" ||
          next === undefined ||
          (next.startsWith("-") && isNaN(Number(next)))
        ) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1 && isNaN(Number(arg))) {
      const key = arg.slice(1);
      const next = args[i + 1];
      if (
        key === "w" &&
        next !== undefined &&
        !isNaN(Number(next))
      ) {
        flags["width"] = next;
        i++;
      } else if (
        key === "h" &&
        next !== undefined &&
        !isNaN(Number(next))
      ) {
        flags["height"] = next;
        i++;
      } else if (
        key === "m" ||
        key === "w" ||
        key === "h" ||
        next === undefined ||
        (next.startsWith("-") && isNaN(Number(next)))
      ) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo,
  bridgeOptions: BridgeClientOptions = {}
): Promise<number> {
  const { positional, flags } = parseArgs(argv);

  if (flags["help"] || flags["h"]) {
    io.stdout(getHelpText());
    return 0;
  }

  const subcommand = positional[0]?.toLowerCase();
  if (!subcommand) {
    io.stdout(getHelpText());
    return 0;
  }

  const effectiveBridgeOptions: BridgeClientOptions = {
    ...bridgeOptions,
    ...(typeof flags["bridge-file"] === "string"
      ? { bridgeFilePath: flags["bridge-file"] }
      : {}),
  };

  try {
    switch (subcommand) {
      case "mcp": {
        await startStdioMcpServer(effectiveBridgeOptions);
        return 0;
      }

      case "capture": {
        const client = new BridgeClient(effectiveBridgeOptions);
        const result = await client.capture();
        const outPath =
          typeof flags["out"] === "string"
            ? flags["out"]
            : typeof flags["o"] === "string"
              ? flags["o"]
              : undefined;

        if (outPath) {
          const resolvedOut = path.resolve(outPath);
          await fs.mkdir(path.dirname(resolvedOut), { recursive: true });
          const buffer = Buffer.from(result.image_base64, "base64");
          await fs.writeFile(resolvedOut, buffer);
          io.stdout(
            JSON.stringify(
              {
                saved_to: resolvedOut,
                image_path: result.image_path,
                active_app: result.active_app,
                window_title: result.window_title,
                monitor: result.monitor,
              },
              null,
              2
            )
          );
        } else {
          io.stdout(JSON.stringify(result, null, 2));
        }
        return 0;
      }

      case "highlight": {
        const rest = positional.slice(1);
        const xStr =
          typeof flags["x"] === "string" ? flags["x"] : rest[0];
        const yStr =
          typeof flags["y"] === "string" ? flags["y"] : rest[1];
        const wStr =
          typeof flags["width"] === "string" ? flags["width"] : rest[2];
        const hStr =
          typeof flags["height"] === "string" ? flags["height"] : rest[3];

        let stepLabel: string | undefined;
        let instructionText: string | undefined;

        if (typeof flags["step-label"] === "string") {
          stepLabel = flags["step-label"];
        } else if (typeof flags["step"] === "string") {
          stepLabel = flags["step"];
        } else if (typeof flags["label"] === "string") {
          stepLabel = flags["label"];
        }

        if (typeof flags["instruction-text"] === "string") {
          instructionText = flags["instruction-text"];
        } else if (typeof flags["instruction"] === "string") {
          instructionText = flags["instruction"];
        } else if (typeof flags["text"] === "string") {
          instructionText = flags["text"];
        }

        // Positional fallback: highlight x y width height step_label instruction_text
        if (!stepLabel && !instructionText) {
          if (rest.length >= 6) {
            stepLabel = rest[4];
            instructionText = rest.slice(5).join(" ");
          } else if (rest.length === 5) {
            stepLabel = "Step 1";
            instructionText = rest[4];
          }
        } else if (!stepLabel && rest.length >= 5) {
          stepLabel = rest[4];
        } else if (!instructionText && rest.length >= 5) {
          instructionText = rest[rest.length - 1];
        }

        if (
          xStr === undefined ||
          yStr === undefined ||
          wStr === undefined ||
          hStr === undefined ||
          !stepLabel ||
          !instructionText
        ) {
          throw new Error(
            "Usage: guidelens highlight <x> <y> <width> <height> <step_label> <instruction_text> [--magnify] [--coords normalized|pixels]"
          );
        }

        const magnify =
          flags["magnify"] === true ||
          flags["magnify"] === "true" ||
          flags["m"] === true;

        const coordsRaw =
          typeof flags["coords"] === "string" ? flags["coords"] : "normalized";
        const coords = CoordsModeSchema.parse(coordsRaw);

        const client = new BridgeClient(effectiveBridgeOptions);
        const res = await client.highlight({
          x: Number(xStr),
          y: Number(yStr),
          width: Number(wStr),
          height: Number(hStr),
          step_label: stepLabel,
          instruction_text: instructionText,
          magnify,
          coords,
        });
        io.stdout(JSON.stringify(res));
        return 0;
      }

      case "command":
      case "show_command":
      case "show-command": {
        const rest = positional.slice(1);
        const command =
          typeof flags["command"] === "string"
            ? flags["command"]
            : typeof flags["cmd"] === "string"
              ? flags["cmd"]
              : rest[0];
        const explanation =
          typeof flags["explanation"] === "string"
            ? flags["explanation"]
            : typeof flags["explain"] === "string"
              ? flags["explain"]
              : rest.slice(1).join(" ");

        if (!command || !explanation) {
          throw new Error(
            'Usage: guidelens command "<cmd>" "<explanation>"'
          );
        }

        const client = new BridgeClient(effectiveBridgeOptions);
        const res = await client.showCommand({ command, explanation });
        io.stdout(JSON.stringify(res));
        return 0;
      }

      case "guide": {
        const planTarget =
          typeof flags["plan"] === "string"
            ? flags["plan"]
            : positional[1];

        if (!planTarget) {
          throw new Error("Usage: guidelens guide <plan.json>");
        }

        let rawContent: string;
        if (planTarget.trim().startsWith("{")) {
          rawContent = planTarget;
        } else {
          rawContent = await fs.readFile(path.resolve(planTarget), "utf8");
        }

        const parsed = JSON.parse(rawContent) as Record<string, unknown>;
        const planCandidate =
          "plan" in parsed &&
          parsed.plan &&
          typeof parsed.plan === "object"
            ? (parsed.plan as StepPlanInput)
            : (parsed as unknown as StepPlanInput);

        const validatedPlan = StepPlanSchema.parse(planCandidate);
        const client = new BridgeClient(effectiveBridgeOptions);
        const res = await client.guide(validatedPlan);
        io.stdout(JSON.stringify(res));
        return 0;
      }

      case "clear": {
        const client = new BridgeClient(effectiveBridgeOptions);
        const res = await client.clear();
        io.stdout(JSON.stringify(res));
        return 0;
      }

      case "install": {
        const agentArg = positional[1];
        if (!agentArg) {
          throw new Error(
            `Usage: guidelens install <${SUPPORTED_AGENTS.join("|")}> [--write] [--config <path>]`
          );
        }

        const configPath =
          typeof flags["config"] === "string" ? flags["config"] : undefined;
        const shouldWrite =
          flags["write"] === true ||
          flags["w"] === true ||
          configPath !== undefined;

        if (shouldWrite) {
          const { info, writtenPath } = await writeAgentConfig(agentArg, {
            configPath,
          });
          io.stdout(info.snippet);
          io.stderr(`Wrote ${info.displayName} MCP config to ${writtenPath}`);
        } else {
          const info = getAgentConfigInfo(agentArg, { configPath });
          io.stdout(info.snippet);
        }
        return 0;
      }

      default:
        throw new Error(
          `Unknown command "${subcommand}". Run "guidelens --help" for usage.`
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(message);
    return 1;
  }
}

function isDirectEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    const entryPath = fsSync.realpathSync(path.resolve(process.argv[1]));
    const selfPath = fsSync.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32"
      ? entryPath.toLowerCase() === selfPath.toLowerCase()
      : entryPath === selfPath;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  });
}
