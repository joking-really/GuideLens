declare module "*tiny-voca/tiny-voca.js" {
  export interface GGUFTensor {
    shape: number[];
    type: number;
    data: Float32Array;
  }

  export interface GGUFFile {
    meta: Record<string, unknown>;
    tensors: Record<string, GGUFTensor>;
    files: Record<string, Uint8Array>;
    keys: Record<string, Uint8Array>;
  }

  export interface TinyVocaConfig {
    channels: number;
    heads: number;
    encoder_layers: number;
    prosody_layers: number;
    acoustic_layers: number;
    max_tokens: number;
    max_frames: number;
    sample_rate: number;
    hop: number;
    synth_fft: number;
    synth_hop: number;
    harmonic_limit: number;
    cep_causal: number;
    cep_anti: number;
    noise_fft: number;
    noise_hop: number;
    noise_cep: number;
    pitch_reference_hz: number;
    f0_min: number;
    f0_max: number;
    speakers: string[];
  }

  export interface TinyVocaSynthesizeOptions {
    voice?: number | string;
    speed?: number;
    pitchShift?: number;
    pitchRange?: number;
    seed?: number;
    noise?: Float32Array | null;
  }

  export interface TinyVocaSynthesizeResult {
    audio: Float32Array;
    durations: Int32Array;
    f0: Float32Array;
  }

  export const spent: Record<string, number>;

  export function readGGUF(buffer: ArrayBuffer): GGUFFile;

  export function gaussianNoise(count: number, seed?: number): Float32Array;

  export class TinyVoca {
    readonly config: TinyVocaConfig;
    readonly voices: string[];
    readonly symbols: string[];
    constructor(file: GGUFFile);
    synthesize(
      ids: ArrayLike<number>,
      stress: ArrayLike<number>,
      options?: TinyVocaSynthesizeOptions,
    ): TinyVocaSynthesizeResult;
  }
}

declare module "*tiny-voca/text.js" {
  export interface TinyVocaUtterance {
    ids: number[];
    stress: number[];
    phonemes: string;
  }

  export interface PhonemizerLike {
    phonemize(text: string): {
      ids: number[];
      stress: number[];
      symbols: string[];
    };
  }

  export function utterancesOf(
    text: string,
    phonemizer: PhonemizerLike,
    limit: number,
  ): TinyVocaUtterance[];

  export function limited(audio: Float32Array): Float32Array;

  export function wav(audio: Float32Array, rate: number): ArrayBuffer;
}

declare module "*tiny-voca/dizione/engine.js" {
  import type { GGUFFile } from "*tiny-voca/tiny-voca.js";

  export interface PhonemizeResult {
    ids: number[];
    stress: number[];
    symbols: string[];
  }

  export class Phonemizer {
    phonemize(text: string): PhonemizeResult;
    pieces(text: string): unknown[];
  }

  export function fromGGUF(file: GGUFFile): Promise<Phonemizer>;
}
