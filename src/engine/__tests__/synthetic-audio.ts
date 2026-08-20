/**
 * Synthetic signals for the beat-tracker tests.
 *
 * Neither tracker needs real audio to be checked for correctness, and there is
 * no real audio to be had here anyway — jsdom has no Web Audio (see
 * `fake-audio-context.ts` for the same problem solved for `Analyser`). What both
 * trackers do need is a signal whose true tempo and true beat instants are known
 * exactly, so a recovered BPM can be compared against a number rather than
 * against a judgement. Everything below is deterministic: the "noise" is a
 * seeded PRNG so a failing test fails the same way twice.
 */
import type { DecodedAudio } from '../beat-offline';

/** Small, fast, deterministic PRNG. Real `Math.random` would make the beat
 *  tests flaky in exactly the way a DSP test must not be. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ClickTrackOptions {
  bpm: number;
  durationSeconds: number;
  sampleRate?: number;
  /** Seconds before the first click. */
  startSeconds?: number;
  /** Uniform ±jitter applied to each click's position, simulating a human. */
  jitterSeconds?: number;
  /** Extra clicks this fraction of a beat after each beat (0.5 = eighth notes). */
  offbeatAt?: number;
  /** Amplitude of those extra clicks relative to the beat clicks. */
  offbeatAmplitude?: number;
  /** Amplitude of the constant background hiss. */
  noiseFloor?: number;
  seed?: number;
}

/** The exact beat instants a `clickTrack` with these options was built from,
 *  jitter included. */
export function clickTimes(options: ClickTrackOptions): number[] {
  const { bpm, durationSeconds } = options;
  const start = options.startSeconds ?? 0.5;
  const jitter = options.jitterSeconds ?? 0;
  const random = mulberry32(options.seed ?? 1);
  const period = 60 / bpm;
  const times: number[] = [];
  for (let t = start; t < durationSeconds; t += period) {
    times.push(t + (jitter > 0 ? (random() * 2 - 1) * jitter : 0));
  }
  return times;
}

/**
 * A percussive click track as decoded audio. Each click is a short exponentially
 * decaying noise burst — broadband, so spectral flux sees it the way it sees a
 * real kick drum, and brief, so its position in time is unambiguous.
 */
export function clickTrack(options: ClickTrackOptions): DecodedAudio {
  const sampleRate = options.sampleRate ?? 44100;
  const noiseFloor = options.noiseFloor ?? 0.001;
  const random = mulberry32((options.seed ?? 1) + 7919);
  const length = Math.round(options.durationSeconds * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) samples[i] = (random() * 2 - 1) * noiseFloor;

  for (const at of clickTimes(options)) addClick(samples, sampleRate, at, 0.9, random);
  if (options.offbeatAt !== undefined) {
    const period = 60 / options.bpm;
    for (const at of clickTimes(options)) {
      addClick(
        samples,
        sampleRate,
        at + period * options.offbeatAt,
        0.9 * (options.offbeatAmplitude ?? 0.4),
        random,
      );
    }
  }

  return decodedAudio(samples, sampleRate);
}

const CLICK_SECONDS = 0.03;
const CLICK_DECAY = 0.006;

function addClick(
  samples: Float32Array,
  sampleRate: number,
  at: number,
  amplitude: number,
  random: () => number,
): void {
  const start = Math.round(at * sampleRate);
  const count = Math.round(CLICK_SECONDS * sampleRate);
  for (let i = 0; i < count; i++) {
    const index = start + i;
    if (index < 0 || index >= samples.length) continue;
    const decay = Math.exp(-i / sampleRate / CLICK_DECAY);
    samples[index] += amplitude * decay * (random() * 2 - 1);
  }
}

/** Wrap raw mono samples in the slice of `AudioBuffer` the analysis reads. */
export function decodedAudio(samples: Float32Array, sampleRate: number): DecodedAudio {
  return {
    sampleRate,
    length: samples.length,
    numberOfChannels: 1,
    getChannelData: () => samples,
  };
}

/** Uniform noise with no periodic structure at all — a track with no beat. */
export function noiseAudio(durationSeconds: number, sampleRate = 44100, seed = 3): DecodedAudio {
  const random = mulberry32(seed);
  const samples = new Float32Array(Math.round(durationSeconds * sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = (random() * 2 - 1) * 0.3;
  return decodedAudio(samples, sampleRate);
}

export function silentAudio(durationSeconds: number, sampleRate = 44100): DecodedAudio {
  return decodedAudio(new Float32Array(Math.round(durationSeconds * sampleRate)), sampleRate);
}
