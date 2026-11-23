import {
  BRAIN_LABELS,
  type AskError,
  type ResolvedStep,
  type Step,
  type StepMode,
} from "../types";

export type VoiceCommand =
  | "next_step"
  | "repeat"
  | "magnify_on"
  | "magnify_off"
  | "stop_clear"
  | "mute_tts";

const CADENCE_PREFIX_RE =
  /^(first|second|third|fourth|next|then|finally|lastly|now|step\s+\d+)\b/i;

const HIGHLIGHT_MENTION_RE =
  /\b(highlight(ed|ing)?|outlined?|box(ed)?|circled?|marked|on\s+(your\s+)?screen)\b/i;

const LOWERCASE_AFTER_CADENCE_RE =
  /^(click|open|select|choose|press|type|run|paste|copy|drag|hover|scroll|check|uncheck|enable|disable|toggle|look|go|head|navigate|switch|enter|save|close|tap|use|wait|watch|move|double|right|hold|release|set|pick|confirm|the|this|that|it|you|here)\b/i;

const THIRD_PERSON_VERB_RE =
  /^(moves|deletes|removes|installs|updates|creates|lists|shows|prints|opens|closes|starts|stops|restarts|resets|undoes|reverts|builds|runs|pushes|pulls|fetches|checks|displays|clears|kills|finds|searches|exports|imports|copies|sets|gets|adds|drops|cleans)\b/i;

const CLI_CODE_RE =
  /(?:^|\s)(?:--?[a-z0-9-]+|\|\|?|&&|>>?|~\/|\.\/)|^(?:git|npm|pnpm|yarn|npx|pip|python|cargo|docker|kubectl|curl|wget|cd|ls|rm|mv|cp|mkdir|chmod|sudo|powershell|pwsh|bash|sh)\s+\S+/i;

const QUESTION_START_RE =
  /^(how|what|why|where|when|who|which|does|is|are|was|were|will|do)\b/;

function looksLikeCliSnippet(snippet: string): boolean {
  return CLI_CODE_RE.test(snippet.trim());
}

function expandShortcut(shortcut: string): string {
  return shortcut
    .replace(/\bCtrl\b/gi, "Control")
    .replace(/\bCmd\b/gi, "Command")
    .replace(/\bEsc\b/gi, "Escape")
    .replace(/\bDel\b/gi, "Delete")
    .replace(/\bPgUp\b/gi, "Page Up")
    .replace(/\bPgDn\b/gi, "Page Down")
    .replace(/\bWin\b/gi, "Windows")
    .replace(/\s*\+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanTextForSpeech(
  raw: string,
  terminalCommand?: string | null,
): string {
  let text = raw;

  if (terminalCommand && terminalCommand.trim().length >= 4) {
    text = text.replace(new RegExp(escapeRegExp(terminalCommand.trim()), "g"), "");
  }

  // Strip script/style elements completely before stripping any HTML tags
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, " ");

  // Convert markdown links [label](url) -> label, then strip raw URLs
  text = text.replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]+\)/gi, "$1");
  text = text.replace(/https?:\/\/\S+/gi, "");
  text = text.replace(/\bwww\.\S+/gi, "");

  // Handle fenced code blocks and inline code backticks
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`([^`]+)`/g, (_, inner: string) =>
    looksLikeCliSnippet(inner) ? "" : inner,
  );

  // Strip common markdown tokens
  text = text
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,!?;:]|$)/g, "$1$2");

  // Convert breadcrumb arrows and ampersands into natural spoken pauses
  text = text.replace(/\s*(?:->|=>|→|➜|▸|›)\s*/g, ", then ");
  text = text.replace(/\s+>\s+/g, ", then ");
  text = text.replace(/\s+&\s+/g, " and ");

  // Make keyboard shortcuts natural to speak
  text = text.replace(
    /\b(?:Ctrl|Cmd|Alt|Shift|Win|Esc|Del|PgUp|PgDn)(?:\s*\+\s*[A-Za-z0-9]+)+\b/gi,
    (match) => expandShortcut(match),
  );

  // Remove stray punctuation leftovers after stripping
  text = text
    .replace(/\(\s*\)/g, " ")
    .replace(/\[\s*\]/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.,!?;:])\1+/g, "$1")
    .replace(/^[,;:\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

function ensureSentenceEnding(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function lowerFirstIfSafe(text: string): string {
  const firstWordMatch = text.match(/^[A-Za-z]+/);
  if (!firstWordMatch) return text;
  const word = firstWordMatch[0];
  // Preserve all-caps acronyms (UI, API, URL) unless it's a lowercase-safe word
  if (word.length > 1 && word === word.toUpperCase()) {
    return text;
  }
  return text[0].toLowerCase() + text.slice(1);
}

function applyMultiStepCadence(
  text: string,
  index: number,
  total: number,
): string {
  if (!text || total <= 1 || CADENCE_PREFIX_RE.test(text)) {
    return text;
  }

  const body = LOWERCASE_AFTER_CADENCE_RE.test(text)
    ? lowerFirstIfSafe(text)
    : text;

  if (index <= 0) {
    return `First, ${body}`;
  }
  if (index >= total - 1) {
    return `Finally, ${body}`;
  }
  return `Next, ${body}`;
}

export function formatStepForSpeech(
  step: ResolvedStep | Step,
  ctx: { mode: StepMode; index: number; total: number; hasHighlight: boolean },
): string {
  const preferredSpoken =
    typeof step.spoken_text === "string" && step.spoken_text.trim().length > 0
      ? cleanTextForSpeech(step.spoken_text, step.terminal_command)
      : "";

  if (preferredSpoken) {
    let spoken = applyMultiStepCadence(preferredSpoken, ctx.index, ctx.total);
    if (
      ctx.index === 0 &&
      ctx.hasHighlight &&
      ctx.mode !== "terminal" &&
      !HIGHLIGHT_MENTION_RE.test(spoken)
    ) {
      spoken = `${spoken.replace(/[.!?…]+$/, "")}. I highlighted it on your screen.`;
    }
    return ensureSentenceEnding(spoken);
  }

  if (ctx.mode === "terminal" || Boolean(step.terminal_command)) {
    const rawExplanation = step.explanation || step.instruction_line || "";
    const cleaned = cleanTextForSpeech(rawExplanation, step.terminal_command);

    let sentence: string;
    if (!cleaned || looksLikeCliSnippet(cleaned)) {
      sentence =
        "I put the command in the bar for you to copy and run in your terminal.";
    } else if (/^(this command|the command|use|run|paste|copy)\b/i.test(cleaned)) {
      sentence = ensureSentenceEnding(cleaned);
    } else if (THIRD_PERSON_VERB_RE.test(cleaned)) {
      sentence = ensureSentenceEnding(
        `The command in the bar ${lowerFirstIfSafe(cleaned)}`,
      );
    } else {
      sentence = `I put the command in the bar. ${ensureSentenceEnding(cleaned)}`;
    }

    return ensureSentenceEnding(
      applyMultiStepCadence(sentence, ctx.index, ctx.total),
    );
  }

  const baseInstruction = cleanTextForSpeech(step.instruction_line || "");
  const cleanExplanation =
    ctx.mode === "explain" && step.explanation
      ? cleanTextForSpeech(step.explanation)
      : "";

  let body = baseInstruction;
  if (
    cleanExplanation &&
    cleanExplanation.toLowerCase() !== baseInstruction.toLowerCase()
  ) {
    body = body
      ? `${ensureSentenceEnding(body)} ${cleanExplanation}`
      : cleanExplanation;
  }

  if (!body && step.target_name) {
    body = `Click ${cleanTextForSpeech(step.target_name)}`;
  }

  if (!body) {
    return "Follow the step shown on your screen.";
  }

  if (step.shortcut && step.shortcut.trim()) {
    const spokenShortcut = expandShortcut(step.shortcut);
    if (
      spokenShortcut &&
      !body.toLowerCase().includes(spokenShortcut.toLowerCase()) &&
      !body.toLowerCase().includes(step.shortcut.trim().toLowerCase())
    ) {
      body = `${body.replace(/[.!?…]+$/, "")}, or press ${spokenShortcut}`;
    }
  }

  body = applyMultiStepCadence(body, ctx.index, ctx.total);

  if (
    ctx.index === 0 &&
    ctx.hasHighlight &&
    !HIGHLIGHT_MENTION_RE.test(body)
  ) {
    body = `${body.replace(/[.!?…]+$/, "")}. I highlighted it on your screen.`;
  }

  return ensureSentenceEnding(body);
}

function fallbackBrainName(err: AskError): string | null {
  const first = err.fallbacks?.[0];
  if (!first) return null;
  return BRAIN_LABELS[first] ?? first;
}

export function formatErrorForSpeech(err: AskError): string {
  const fallback = fallbackBrainName(err);
  const fallbackHint = fallback ? ` You can switch to ${fallback}.` : "";

  switch (err.code) {
    case "timeout":
      return `That took too long to answer.${fallbackHint}`;
    case "rate_limited":
      return `We hit a rate limit right now.${fallbackHint}`;
    case "quota":
      return "Your monthly Pro quota is used up. You can switch to Local or your own API key.";
    case "not_pro":
      return "That cloud model needs a Pro plan. You can upgrade in Settings or switch to Local.";
    case "unauthenticated":
      return "Please sign in under Settings to use Groq Pro.";
    case "unavailable":
      return err.brain === "local_vlm"
        ? "Ollama doesn't seem to be running right now. Check Settings or switch brains."
        : `That brain isn't available right now.${fallbackHint}`;
    case "invalid_response":
      return "I couldn't read that answer clearly. Please try asking again.";
    case "unknown":
    default: {
      const cleaned = cleanTextForSpeech(err.message || "");
      if (cleaned && cleaned.length <= 140) {
        return ensureSentenceEnding(cleaned);
      }
      return "Something went wrong. Please try again.";
    }
  }
}

const MUTE_COMMANDS = new Set([
  "mute",
  "mute voice",
  "mute tts",
  "mute audio",
  "mute speech",
  "quiet",
  "be quiet",
  "silence",
  "stop talking",
  "stop speaking",
  "shut up",
  "turn off voice",
  "turn off speech",
  "turn off tts",
]);

const NEXT_STEP_COMMANDS = new Set([
  "next",
  "next step",
  "go next",
  "continue",
  "go on",
  "proceed",
  "move on",
  "forward",
  "skip",
  "step forward",
  "go to next step",
  "next one",
]);

const REPEAT_COMMANDS = new Set([
  "repeat",
  "repeat that",
  "repeat step",
  "say again",
  "say that again",
  "again",
  "one more time",
  "what did you say",
  "pardon",
  "read that again",
  "can you repeat",
  "can you repeat that",
  "could you repeat",
  "could you repeat that",
]);

const MAGNIFY_ON_COMMANDS = new Set([
  "magnify",
  "magnify on",
  "turn on magnify",
  "enable magnify",
  "zoom in",
  "zoom",
  "closer",
  "bigger",
  "show magnifier",
]);

const MAGNIFY_OFF_COMMANDS = new Set([
  "magnify off",
  "turn off magnify",
  "disable magnify",
  "unmagnify",
  "zoom out",
  "hide magnifier",
  "normal size",
]);

const STOP_CLEAR_COMMANDS = new Set([
  "stop",
  "cancel",
  "close",
  "done",
  "finished",
  "finish",
  "clear",
  "clear overlay",
  "exit",
  "never mind",
  "nevermind",
  "dismiss",
  "all done",
  "i'm done",
  "im done",
]);

export function matchVoiceCommand(
  transcript: string,
  hasActiveStep: boolean,
): VoiceCommand | null {
  const rawTrimmed = transcript.trim();
  if (!rawTrimmed) {
    return null;
  }

  let normalized = rawTrimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  // Strip polite wake/filler prefixes and trailing courtesy words
  normalized = normalized
    .replace(/^(?:hey\s+guidelens|guidelens|ok|okay|please)\s+/i, "")
    .replace(/\s+(?:please|now)$/i, "")
    .trim();

  if (!normalized) {
    return null;
  }

  if (MUTE_COMMANDS.has(normalized)) {
    return "mute_tts";
  }

  if (!hasActiveStep) {
    return null;
  }

  // Allow explicit "what did you say" idiom, otherwise never intercept real questions
  if (normalized === "what did you say") {
    return "repeat";
  }

  if (rawTrimmed.endsWith("?") && !REPEAT_COMMANDS.has(normalized)) {
    return null;
  }

  if (QUESTION_START_RE.test(normalized)) {
    return null;
  }

  if (NEXT_STEP_COMMANDS.has(normalized)) {
    return "next_step";
  }
  if (REPEAT_COMMANDS.has(normalized)) {
    return "repeat";
  }
  if (MAGNIFY_ON_COMMANDS.has(normalized)) {
    return "magnify_on";
  }
  if (MAGNIFY_OFF_COMMANDS.has(normalized)) {
    return "magnify_off";
  }
  if (STOP_CLEAR_COMMANDS.has(normalized)) {
    return "stop_clear";
  }

  return null;
}
