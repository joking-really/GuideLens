import type { KnownCompanionId, TinyVocaVoice } from "../types";

export type VisibleCompanionId = Exclude<KnownCompanionId, "none">;

export interface CompanionPersonaMeta {
  id: KnownCompanionId;
  name: string;
  label: string;
  tagline: string;
  description: string;
  accentColor: string;
  secondaryColor: string;
  /** Default tiny-voca speaker ID ("M2" | "F2") */
  defaultVoice: TinyVocaVoice;
  /** Persona pitch lift in semitones per design spec (+1.5, 0.0, +2.5, 0.0) */
  defaultPitch: number;
  /** Normalized tiny-voca pitchShift parameter (-0.3..0.3) matching VoiceStudio */
  defaultPitchShift: number;
  /** Default tiny-voca speaking speed multiplier */
  defaultSpeed: number;
  idleWhisper: string;
}

export const COMPANION_PERSONAS: Record<KnownCompanionId, CompanionPersonaMeta> = {
  pixel_cat: {
    id: "pixel_cat",
    name: "Mochi",
    label: "Mochi — Pixel Cat",
    tagline: "Playful pixel cat",
    description:
      "Curious desktop calico who leaps between buttons, naps by your taskbar, and purrs through tricky workflows.",
    accentColor: "#F472B6",
    secondaryColor: "#FBBF24",
    defaultVoice: "F2",
    defaultPitch: 1.5,
    defaultPitchShift: 0.09,
    defaultSpeed: 1.06,
    idleWhisper: "Keeping an eye on your screen!",
  },
  tech_nerd: {
    id: "tech_nerd",
    name: "Byte",
    label: "Byte — Tech Nerd",
    tagline: "Witty pixel hacker",
    description:
      "Sharp-eyed hacker sprite with a cyan holo visor, instant keyboard shortcuts, and a floating terminal deck.",
    accentColor: "#38BDF8",
    secondaryColor: "#22D3EE",
    defaultVoice: "M2",
    defaultPitch: 0.0,
    defaultPitchShift: 0.0,
    defaultSpeed: 1.08,
    idleWhisper: "Ready to trace the next control.",
  },
  anime_guide: {
    id: "anime_guide",
    name: "Sora",
    label: "Sora — Anime Spirit",
    tagline: "Expressive chibi spirit",
    description:
      "Star-crested chibi guide packed with anime sparks, celebratory confetti, and dramatic reactions when things go sideways.",
    accentColor: "#A78BFA",
    secondaryColor: "#FDE047",
    defaultVoice: "F2",
    defaultPitch: 2.5,
    defaultPitchShift: 0.15,
    defaultSpeed: 1.04,
    idleWhisper: "Sparkle mode armed and watching!",
  },
  minimal_orb: {
    id: "minimal_orb",
    name: "Flow",
    label: "Flow — Minimal Orb",
    tagline: "Luminous geometric orb",
    description:
      "Calm floating glass sphere with reactive cyan rings for distraction-free visual guidance.",
    accentColor: "#2DD4BF",
    secondaryColor: "#38BDF8",
    defaultVoice: "M2",
    defaultPitch: 0.0,
    defaultPitchShift: 0.0,
    defaultSpeed: 1.02,
    idleWhisper: "Observing quietly.",
  },
  none: {
    id: "none",
    name: "Hidden",
    label: "Hidden",
    tagline: "Stealth mode",
    description: "Hide the overlay companion while keeping highlights and guidance active.",
    accentColor: "#94A3B8",
    secondaryColor: "#64748B",
    defaultVoice: "M2",
    defaultPitch: 0.0,
    defaultPitchShift: 0.0,
    defaultSpeed: 1.0,
    idleWhisper: "",
  },
};

export const VISIBLE_COMPANION_IDS: readonly VisibleCompanionId[] = [
  "pixel_cat",
  "tech_nerd",
  "anime_guide",
  "minimal_orb",
];

export const VISIBLE_COMPANIONS: ReadonlyArray<CompanionPersonaMeta> =
  VISIBLE_COMPANION_IDS.map((id) => COMPANION_PERSONAS[id]);

export function getCompanionPersona(
  id: string | null | undefined,
): CompanionPersonaMeta {
  if (id && Object.prototype.hasOwnProperty.call(COMPANION_PERSONAS, id)) {
    return COMPANION_PERSONAS[id as KnownCompanionId];
  }
  return COMPANION_PERSONAS.pixel_cat;
}
