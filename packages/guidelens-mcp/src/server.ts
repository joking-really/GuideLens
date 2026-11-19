import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { BridgeClient, BridgeClientOptions } from "./bridge.js";
import {
  GuideInputSchema,
  HighlightInputSchema,
  ShowCommandInputSchema,
  StepPlanSchema,
} from "./types.js";

export const GUIDELENS_TOOLS: Tool[] = [
  {
    name: "capture_screen",
    description:
      "Capture the active Windows monitor screenshot and foreground window metadata from GuideLens. Returns the screenshot as MCP image content (image/jpeg) plus JSON metadata (image_path, active_app, window_title, monitor geometry & DPI scale).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "highlight",
    description:
      "Render a glowing highlight bounding box, step badge, and concise 1-line instruction (<=140 chars) on the user's live Windows screen via GuideLens overlay. Coordinates default to normalized 0-1000 relative to the active monitor.",
    inputSchema: {
      type: "object",
      properties: {
        x: {
          type: "number",
          description:
            "Top-left X coordinate (0-1000 normalized by default, or physical pixels when coords='pixels').",
        },
        y: {
          type: "number",
          description:
            "Top-left Y coordinate (0-1000 normalized by default, or physical pixels when coords='pixels').",
        },
        width: {
          type: "number",
          description:
            "Bounding box width (0-1000 normalized by default, or physical pixels when coords='pixels').",
        },
        height: {
          type: "number",
          description:
            "Bounding box height (0-1000 normalized by default, or physical pixels when coords='pixels').",
        },
        step_label: {
          type: "string",
          description: "Short step badge label (e.g., 'Step 1 of 3' or '1').",
        },
        instruction_text: {
          type: "string",
          description:
            "Concise 1-line plain-English instruction shown in the floating bar (max 140 characters).",
        },
        magnify: {
          type: "boolean",
          description:
            "Optional. When true, displays a 2.5x circular magnifier lens over the highlighted target.",
          default: false,
        },
        coords: {
          type: "string",
          enum: ["normalized", "pixels"],
          description:
            "Coordinate space: 'normalized' (0-1000 relative to active monitor, default) or 'pixels' (physical screen pixels).",
          default: "normalized",
        },
      },
      required: [
        "x",
        "y",
        "width",
        "height",
        "step_label",
        "instruction_text",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "show_command",
    description:
      "Display a one-click copyable terminal command box with a concise 1-line plain-English explanation in the GuideLens floating bar.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Exact CLI/terminal command for the user to copy and run.",
        },
        explanation: {
          type: "string",
          description:
            "Concise 1-line plain-English explanation of what the command does (max 140 characters).",
        },
      },
      required: ["command", "explanation"],
      additionalProperties: false,
    },
  },
  {
    name: "guide",
    description:
      "Send a complete multi-step StepPlan to GuideLens. GuideLens renders step 1 immediately and automatically advances as the user clicks inside each highlighted bounding box.",
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "object",
          description: "The StepPlan object conforming to the GuideLens StepPlan contract.",
          properties: {
            mode: {
              type: "string",
              enum: ["guide", "explain", "terminal"],
              description: "Guidance mode.",
            },
            total_steps: {
              type: "number",
              description: "Total number of steps in the plan.",
            },
            steps: {
              type: "array",
              description: "Ordered list of guidance steps.",
              items: {
                type: "object",
                properties: {
                  step_number: { type: "number" },
                  instruction_line: {
                    type: "string",
                    description: "1-line instruction (<= 140 characters).",
                  },
                  target_name: { type: ["string", "null"] },
                  control_type: { type: ["string", "null"] },
                  bbox: {
                    type: ["array", "null"],
                    items: { type: "number" },
                    minItems: 4,
                    maxItems: 4,
                    description: "Optional [x, y, w, h] in 0-1000 normalized coordinates.",
                  },
                  confidence: { type: "number" },
                  shortcut: { type: ["string", "null"] },
                  terminal_command: { type: ["string", "null"] },
                  explanation: { type: ["string", "null"] },
                },
                required: ["step_number", "instruction_line"],
              },
            },
          },
          required: ["mode", "total_steps", "steps"],
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
  },
  {
    name: "clear",
    description:
      "Dismiss any active GuideLens screen highlights, magnifier lenses, and floating bar instructions.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  bridge: BridgeClient
): Promise<CallToolResult> {
  const safeArgs = args ?? {};

  try {
    switch (name) {
      case "capture_screen": {
        const capture = await bridge.capture();
        const metadata = {
          image_path: capture.image_path,
          active_app: capture.active_app,
          window_title: capture.window_title,
          monitor: capture.monitor,
        };
        return {
          content: [
            {
              type: "image",
              data: capture.image_base64,
              mimeType: "image/jpeg",
            },
            {
              type: "text",
              text: JSON.stringify(metadata, null, 2),
            },
          ],
        };
      }

      case "highlight": {
        const input = HighlightInputSchema.parse(safeArgs);
        const res = await bridge.highlight(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: res.ok,
                highlighted: {
                  x: input.x,
                  y: input.y,
                  width: input.width,
                  height: input.height,
                  coords: input.coords,
                  step_label: input.step_label,
                  instruction_text: input.instruction_text,
                  magnify: input.magnify,
                },
              }),
            },
          ],
        };
      }

      case "show_command": {
        const input = ShowCommandInputSchema.parse(safeArgs);
        const res = await bridge.showCommand(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: res.ok,
                command: input.command,
                explanation: input.explanation,
              }),
            },
          ],
        };
      }

      case "guide": {
        const rawPlan =
          "plan" in safeArgs && safeArgs.plan !== undefined
            ? GuideInputSchema.parse(safeArgs).plan
            : StepPlanSchema.parse(safeArgs);
        const res = await bridge.guide(rawPlan);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: res.ok,
                mode: rawPlan.mode,
                total_steps: rawPlan.total_steps,
              }),
            },
          ],
        };
      }

      case "clear": {
        const res = await bridge.clear();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: res.ok }),
            },
          ],
        };
      }

      default:
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown GuideLens tool: ${name}`,
            },
          ],
        };
    }
  } catch (err) {
    const message =
      err instanceof ZodError
        ? `Invalid tool arguments for ${name}: ${formatZodError(err)}`
        : err instanceof Error
          ? err.message
          : String(err);

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: message,
        },
      ],
    };
  }
}

export function createGuideLensMcpServer(
  options: BridgeClientOptions = {}
): { server: Server; bridge: BridgeClient } {
  const bridge = new BridgeClient(options);

  const server = new Server(
    {
      name: "guidelens-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: GUIDELENS_TOOLS,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return handleToolCall(
      request.params.name,
      request.params.arguments as Record<string, unknown> | undefined,
      bridge
    );
  });

  return { server, bridge };
}

export async function startStdioMcpServer(
  options: BridgeClientOptions = {}
): Promise<Server> {
  const { server } = createGuideLensMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
