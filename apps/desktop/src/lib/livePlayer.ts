/**
 * Gapless Web Audio streaming player adapted from n4ze3m/tiny-voca (web/public/player.js).
 * Schedules each sentence buffer LEAD seconds ahead (or seamlessly after the prior buffer)
 * so consecutive sentences play without audible gaps or clipping.
 */

export const LEAD = 0.05;
export const LIVE_PLAYER_LEAD = LEAD;

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null;
  onended: ((this: unknown, ev?: unknown) => unknown) | null;
  connect(destination: unknown): unknown;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void> | void;
  createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): AudioBufferLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  close?: () => Promise<void> | void;
}

export class LivePlayer {
  static readonly LEAD = LEAD;

  private readonly context: AudioContextLike | null;
  private readonly onStateChange?: (playing: boolean) => void;
  private readonly sources = new Set<AudioBufferSourceNodeLike>();
  private open = false;
  private muted = false;
  private refused = false;
  private queued = 0;
  private next = 0;

  constructor(
    context: AudioContextLike | null = null,
    onStateChange?: (playing: boolean) => void,
  ) {
    this.context = context;
    this.onStateChange = onStateChange;
  }

  get playing(): boolean {
    return !this.muted && (this.open || this.sources.size > 0);
  }

  private notify(): void {
    this.onStateChange?.(this.playing);
  }

  private silence(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Source may have already finished playback
      }
    }
    this.sources.clear();
  }

  /** Starts a new utterance stream; call from user interaction or before queueing chunks. */
  begin(): void {
    this.silence();
    this.open = true;
    this.muted = false;
    this.refused = false;
    this.queued = 0;
    this.next = 0;

    if (!this.context) {
      this.open = false;
      this.refused = true;
      this.notify();
      return;
    }

    if (this.context.state !== "running") {
      try {
        Promise.resolve(this.context.resume()).catch(() => {
          this.refused = true;
        });
      } catch {
        this.refused = true;
      }
    }

    this.notify();
  }

  /** Schedules a sentence PCM chunk immediately after the previous chunk (or after LEAD). */
  add(samples: Float32Array, rate: number): void {
    if (this.muted || !samples.length || !this.context) {
      return;
    }

    const buffer = this.context.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      this.sources.delete(source);
      this.notify();
    };

    const when = Math.max(this.next, this.context.currentTime + LEAD);
    source.start(when);
    this.next = when + samples.length / rate;
    this.sources.add(source);
    this.queued += 1;
    this.notify();
  }

  /** Marks the stream finished; returns false if nothing audible was queued or autoplay failed. */
  end(): boolean {
    this.open = false;
    const played =
      this.muted ||
      (this.queued > 0 &&
        !(this.refused && this.context?.state !== "running"));
    if (!played) {
      this.silence();
    }
    this.notify();
    return played;
  }

  /** Immediately halts all active and scheduled sentence buffers and mutes trailing chunks. */
  stop(): void {
    this.muted = true;
    this.open = false;
    this.silence();
    this.notify();
  }
}

export function createLivePlayer(
  context: AudioContextLike | null = null,
  onStateChange?: (playing: boolean) => void,
): LivePlayer {
  return new LivePlayer(context, onStateChange);
}
