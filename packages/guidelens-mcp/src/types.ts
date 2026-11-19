import { z } from "zod";

export const CoordsModeSchema = z.enum(["normalized", "pixels"]);
export type CoordsMode = z.infer<typeof CoordsModeSchema>;

export const PlanModeSchema = z.enum(["guide", "explain", "terminal"]);
export type PlanMode = z.infer<typeof PlanModeSchema>;

export const BBoxSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
export type BBox = z.infer<typeof BBoxSchema>;

export const StepSchema = z.object({
  step_number: z.number().int().min(1),
  instruction_line: z
    .string()
    .min(1, "instruction_line must not be empty")
    .max(140, "instruction_line must be <= 140 characters"),
  target_name: z.string().nullable().optional(),
  control_type: z.string().nullable().optional(),
  bbox: BBoxSchema.nullable().optional(),
  confidence: z.number().min(0).max(1).default(1.0),
  shortcut: z.string().nullable().optional(),
  terminal_command: z.string().nullable().optional().default(null),
  explanation: z.string().nullable().optional().default(null),
});
export type Step = z.infer<typeof StepSchema>;
export type StepInput = z.input<typeof StepSchema>;

export const StepPlanSchema = z.object({
  mode: PlanModeSchema,
  total_steps: z.number().int().min(1),
  steps: z.array(StepSchema).min(1, "steps must contain at least one step"),
});
export type StepPlan = z.infer<typeof StepPlanSchema>;
export type StepPlanInput = z.input<typeof StepPlanSchema>;

export const HighlightInputSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive("width must be > 0"),
  height: z.number().finite().positive("height must be > 0"),
  step_label: z.string().min(1, "step_label is required"),
  instruction_text: z
    .string()
    .min(1, "instruction_text is required")
    .max(140, "instruction_text must be <= 140 characters"),
  magnify: z.boolean().optional().default(false),
  coords: CoordsModeSchema.optional().default("normalized"),
});
export type HighlightInput = z.input<typeof HighlightInputSchema>;
export type HighlightPayload = z.infer<typeof HighlightInputSchema>;

export const ShowCommandInputSchema = z.object({
  command: z.string().min(1, "command is required"),
  explanation: z
    .string()
    .min(1, "explanation is required")
    .max(140, "explanation must be <= 140 characters"),
});
export type ShowCommandInput = z.infer<typeof ShowCommandInputSchema>;

export const GuideInputSchema = z.object({
  plan: StepPlanSchema,
});
export type GuideInput = z.input<typeof GuideInputSchema>;

export const BridgeConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().trim().min(1, "token must not be empty"),
  pid: z.number().int().optional(),
});
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export const MonitorInfoSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  scale: z.number(),
});
export type MonitorInfo = z.infer<typeof MonitorInfoSchema>;

export const CaptureResponseSchema = z.object({
  image_path: z.string(),
  image_base64: z.string(),
  active_app: z.string(),
  window_title: z.string(),
  monitor: MonitorInfoSchema,
});
export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const OkResponseSchema = z.object({
  ok: z.boolean(),
});
export type OkResponse = z.infer<typeof OkResponseSchema>;

export type SupportedAgent =
  | "claude"
  | "codex"
  | "gemini"
  | "antigravity"
  | "hermes";

export const SUPPORTED_AGENTS: readonly SupportedAgent[] = [
  "claude",
  "codex",
  "gemini",
  "antigravity",
  "hermes",
] as const;
