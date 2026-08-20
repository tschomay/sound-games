/**
 * Voice Line Rider's rules, kept free of rendering and of the microphone so the
 * whole thing can be reasoned about (and tested) by feeding it numbers.
 *
 * Unlike every other game so far, this one has two genuinely different modes
 * layered under the shared `RoundPhase` vocabulary (`engine/game.ts`):
 * `'recording'`, where a few seconds of hummed pitch become a fixed terrain
 * line, and `'replaying'`, where a marble rolls down that line under gravity —
 * no further microphone input needed. Both live inside `phase === 'playing'`,
 * exposed as `mode`, the same way Sonar Maze layers `crashed`/`caught`
 * alongside `phase` rather than inventing a new shared phase for one game.
 * `update(dt, input)` simply ignores `input` while replaying: the whole point
 * of "recorded then replayed" is that detection latency stops mattering once
 * the terrain is fixed, so there's nothing to gain from also reading the mic.
 */
import type { RoundPhase } from '../../engine/game';

export interface Config {
  /** Seconds of humming captured before replay starts. */
  recordDuration: number;
  /** Seconds between contour samples — sets how finely the terrain resolves. */
  sampleInterval: number;
  /** How strongly the marble accelerates downhill per unit of slope. */
  gravity: number;
  /** Exponential velocity damping per second — without this the marble would
   *  roll back and forth in a valley forever and the round would never end. */
  friction: number;
  /** Below this speed (world units/s) the marble counts as settled. */
  settleSpeed: number;
  /** Seconds the marble must stay under `settleSpeed` before the round ends. */
  settleHold: number;
  /** Safety cap on replay length in case the marble never settles. */
  maxReplayDuration: number;
  /** Where the goal sits, as a fraction of the recorded contour's length. */
  goalFraction: number;
  /** How close (in contour-sample units) counts as reaching the goal. */
  goalRadius: number;
}

export const DEFAULT_CONFIG: Config = {
  recordDuration: 4,
  sampleInterval: 0.05,
  gravity: 6,
  friction: 1.2,
  settleSpeed: 0.05,
  settleHold: 0.4,
  maxReplayDuration: 15,
  goalFraction: 0.82,
  goalRadius: 2.5,
};

/** Points lost per contour-sample unit of distance from the goal at rest —
 *  decoupled from the actual recorded contour length so the "reached the
 *  goal" score threshold (see index.ts) stays exact regardless of small
 *  variance in how many samples a real round happens to capture. */
export const SCORE_PER_UNIT = 10;
export const MAX_SCORE = 1000;

export type Mode = 'recording' | 'replaying';

/** What the game needs from a Frame — nothing more, so tests need no audio. */
export interface Input {
  voiced: boolean;
  pitchNorm: number | null;
}

export class VoiceLineRider {
  phase: RoundPhase = 'ready';
  mode: Mode = 'recording';
  /** The captured pitch contour, 0..1 per sample, one sample per
   *  `config.sampleInterval` seconds of recording. Fixed once replay starts. */
  contour: number[] = [];
  /** Seconds of humming captured so far, for the recording-progress readout. */
  elapsed = 0;

  /** Marble position, in contour-sample units (0 at the start of the line). */
  marbleX = 0;
  marbleVX = 0;
  /** Where the goal sits, in the same units as `marbleX`. Set once recording
   *  ends, since it's a fraction of the contour's final length. */
  goalX = 0;
  /** Set true the instant the marble settles within `config.goalRadius` of
   *  the goal, for the render's celebratory flash — decays like every other
   *  game's `celebration` field. */
  celebration = 0;

  private lastHeight = 0.5;
  private replayElapsed = 0;
  private settledTime = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  reset(): void {
    this.phase = 'ready';
    this.mode = 'recording';
    this.contour = [];
    this.elapsed = 0;
    this.marbleX = 0;
    this.marbleVX = 0;
    this.goalX = 0;
    this.celebration = 0;
    this.lastHeight = 0.5;
    this.replayElapsed = 0;
    this.settledTime = 0;
  }

  /** How far into the goal the marble currently sits, live during replay and
   *  frozen once the round is over (nothing updates `marbleX` after that).
   *  Zero before there's a contour to measure against. */
  get score(): number {
    if (this.mode !== 'replaying') return 0;
    const distance = Math.abs(this.marbleX - this.goalX);
    return Math.max(0, Math.round(MAX_SCORE - distance * SCORE_PER_UNIT));
  }

  /** Whether the marble is currently within goal range — true throughout a
   *  replay the instant it drifts close enough, not only at settle. */
  get reached(): boolean {
    if (this.mode !== 'replaying') return false;
    return Math.abs(this.marbleX - this.goalX) <= this.config.goalRadius;
  }

  /** Terrain height at a given contour position, linearly interpolated
   *  between the two nearest samples. Used by the render for the marble's Y
   *  and internally would be redundant with `slopeAt`, so it isn't. */
  heightAt(x: number): number {
    if (this.contour.length === 0) return 0.5;
    const max = this.contour.length - 1;
    if (max === 0) return this.contour[0];
    const clamped = Math.min(max, Math.max(0, x));
    const i0 = Math.min(max - 1, Math.floor(clamped));
    const frac = clamped - i0;
    return this.contour[i0] + (this.contour[i0 + 1] - this.contour[i0]) * frac;
  }

  update(dt: number, input: Input): void {
    if (this.phase === 'ready') {
      // A round starts when you start humming, same as Hum Flyer — the first
      // sample is whatever note you opened on.
      if (input.voiced && input.pitchNorm !== null) {
        this.phase = 'playing';
        this.mode = 'recording';
        this.lastHeight = input.pitchNorm;
        this.contour.push(input.pitchNorm);
        this.elapsed = 0;
      }
      return;
    }
    if (this.phase !== 'playing') return;

    if (this.mode === 'recording') {
      this.recordSample(dt, input);
    } else {
      this.updateReplay(dt);
    }
  }

  private recordSample(dt: number, input: Input): void {
    this.elapsed += dt;
    // Silence mid-hum holds the last pitch rather than dropping to zero — a
    // breath shouldn't carve a cliff into the terrain.
    const height = input.voiced && input.pitchNorm !== null ? input.pitchNorm : this.lastHeight;
    this.lastHeight = height;

    const target = Math.floor(this.elapsed / this.config.sampleInterval) + 1;
    while (this.contour.length < target) this.contour.push(height);

    if (this.elapsed >= this.config.recordDuration) {
      this.mode = 'replaying';
      this.goalX = this.config.goalFraction * (this.contour.length - 1);
    }
  }

  private updateReplay(dt: number): void {
    const { gravity, friction, settleSpeed, settleHold, maxReplayDuration } = this.config;

    // A bead-on-a-wire approximation: the slope's pull on the marble, rather
    // than full incline-plane trig — plenty accurate for a hummed contour and
    // much cheaper than resolving a proper normal force.
    const slope = this.slopeAt(this.marbleX);
    this.marbleVX += -gravity * slope * dt;
    // Exponential damping stays stable across any frame rate, unlike
    // `velocity *= 1 - friction * dt`, which can overshoot into a sign flip
    // at a low frame rate.
    this.marbleVX *= Math.exp(-friction * dt);
    this.marbleX += this.marbleVX * dt;

    const max = this.contour.length - 1;
    if (this.marbleX <= 0) {
      this.marbleX = 0;
      this.marbleVX = 0;
    } else if (this.marbleX >= max) {
      this.marbleX = max;
      this.marbleVX = 0;
    }

    this.replayElapsed += dt;
    if (Math.abs(this.marbleVX) < settleSpeed) {
      this.settledTime += dt;
    } else {
      this.settledTime = 0;
    }

    if (this.settledTime >= settleHold || this.replayElapsed >= maxReplayDuration) {
      this.phase = 'over';
      this.celebration = this.reached ? 1 : 0;
    }
  }

  /** dh/dx of the segment `x` sits in — spacing between samples is always 1
   *  unit, so the raw height difference is already the slope. */
  private slopeAt(x: number): number {
    if (this.contour.length < 2) return 0;
    const max = this.contour.length - 1;
    const clamped = Math.min(max, Math.max(0, x));
    const i0 = Math.min(max - 1, Math.floor(clamped));
    return this.contour[i0 + 1] - this.contour[i0];
  }
}
