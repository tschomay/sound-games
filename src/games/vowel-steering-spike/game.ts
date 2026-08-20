/**
 * Vowel Steering (spike)'s rules, kept free of rendering and of the microphone
 * so the whole thing can be reasoned about (and tested) by feeding it numbers.
 *
 * This is A5 from `ideas.md`, and per the roadmap's Phase 5 entry it is
 * explicitly a *spike*, not a committed game: "Needs a spike before it gets
 * committed to." The mechanic is deliberately as simple as it can be while
 * still making the risk visible — a reticle chases two axes (pitch vertical,
 * vowel brightness horizontal) toward a sequence of targets — because the
 * point isn't to be fun, it's to make it possible to *feel and see* whether
 * moving pitch alone drags the horizontal reading with it. The live raw
 * readout (see index.ts) matters more here than in any other game on the
 * roster.
 */
import type { RoundPhase } from '../../engine/game';

/**
 * Fixed plausible Hz range for vowel brightness. There's no calibration step
 * for spectral centroid the way `PitchRange` gets one for pitch (see
 * `engine/calibration.ts`) — nobody has sung a scale of vowels into a
 * measurement step — so this is a reasoned guess, not a measurement: rough
 * literature figures for F2 (the formant that separates front vowels like
 * "ee" from back vowels like "oo") sit roughly in the 800–2500Hz band for an
 * adult voice, and spectral centroid (a whole-spectrum brightness average,
 * not a formant tracker) runs somewhat above and below that depending on
 * harmonic content. 500–3000Hz gives headroom on both ends without being so
 * wide that ordinary vowel variation gets compressed into a sliver of the
 * range. See the ADR for the full reasoning and the open question.
 */
export interface VowelRange {
  lowHz: number;
  highHz: number;
}

export const DEFAULT_VOWEL_RANGE: VowelRange = { lowHz: 500, highHz: 3000 };

/**
 * Hz to 0..1 across a vowel-brightness range, log-scaled the same way
 * `normalisePitch` scales Hz across a pitch range (`engine/calibration.ts`) —
 * a proportional change in brightness should feel the same size regardless of
 * where in the range it happens, and formant/brightness perception is
 * roughly logarithmic the same way pitch perception is. This function takes
 * only `hz` and `range`, never a pitch value, so nothing in its own math can
 * introduce a pitch dependency — any coupling that shows up between the two
 * axes has to come from the acoustic signal itself (a real effect the
 * roadmap already names), not from this formula. See the ADR's synthetic
 * analysis for how much of that real coupling this spike should expect.
 */
export function normaliseCentroid(hz: number, range: VowelRange = DEFAULT_VOWEL_RANGE): number {
  if (!(hz > 0)) return 0;
  const span = Math.log2(range.highHz / range.lowHz);
  if (!Number.isFinite(span) || span <= 0) return 0.5;
  return clamp01(Math.log2(hz / range.lowHz) / span);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export interface Target {
  x: number;
  y: number;
}

/**
 * Deterministic low-discrepancy sequence (a Weyl sequence: repeated addition
 * of an irrational number, mod 1) rather than real RNG, matching Sonar
 * Maze's precedent (`games/sonar-maze/game.ts`) of preferring reproducible
 * pseudo-randomness over `Math.random()` so rounds and tests are repeatable.
 * Two different irrationals for x and y keep the two axes from correlating
 * with each other.
 */
function targetPosition(index: number, margin: number): Target {
  const gx = fract(index * 0.6180339887498949); // golden ratio conjugate
  const gy = fract(index * 0.4142135623730951); // sqrt(2) - 1
  const span = 1 - 2 * margin;
  return { x: margin + gx * span, y: margin + gy * span };
}

function fract(value: number): number {
  return value - Math.floor(value);
}

export interface Config {
  /** Seconds a round lasts once started. */
  roundDuration: number;
  /** How fast the reticle chases the raw axis readings. Higher is twitchier —
   *  same exponential-chase pattern Hum Flyer uses, so jitter frame to frame
   *  doesn't read as the reticle vibrating. */
  responsiveness: number;
  /** Distance (in the 0..1 field) within which the reticle counts as on a target. */
  targetRadius: number;
  /** Field margin so targets never spawn flush against an edge. */
  targetMargin: number;
  vowelRange: VowelRange;
}

export const DEFAULT_CONFIG: Config = {
  roundDuration: 40,
  responsiveness: 9,
  targetRadius: 0.09,
  targetMargin: 0.14,
  vowelRange: DEFAULT_VOWEL_RANGE,
};

/** What the game needs from a Frame — nothing more, so tests need no audio. */
export interface Input {
  voiced: boolean;
  pitchNorm: number | null;
  /** Raw centroid in Hz — normalised inside the rules via `normaliseCentroid`,
   *  same split as pitch: the engine hands over Hz, the game (or calibration,
   *  for pitch) decides how to map it to 0..1. */
  centroid: number;
}

export class VowelSteeringSpike {
  phase: RoundPhase = 'ready';
  score = 0;
  elapsed = 0;

  /** Reticle position, 0..1 field coordinates. x is vowel brightness, y is pitch. */
  reticleX = 0.5;
  reticleY = 0.5;

  /** Last raw axis readings — held through silence, same reasoning as Voice
   *  Line Rider holding the last pitch through a silent gap, so a breath
   *  mid-round doesn't snap the reticle to the field's centre. Exposed
   *  directly (rather than only the chased reticle position) because the
   *  live numeric readout is the entire point of this spike. */
  lastPitchNorm: number | null = null;
  lastVowelNorm: number | null = null;

  target: Target;
  /** Set on the frame a target is hit, for the hit effect. Decays to zero. */
  celebration = 0;

  private targetIndex = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.target = targetPosition(0, config.targetMargin);
    this.reset();
  }

  reset(): void {
    this.phase = 'ready';
    this.score = 0;
    this.elapsed = 0;
    this.reticleX = 0.5;
    this.reticleY = 0.5;
    this.lastPitchNorm = null;
    this.lastVowelNorm = null;
    this.celebration = 0;
    this.targetIndex = 0;
    this.target = targetPosition(0, this.config.targetMargin);
  }

  get timeRemaining(): number {
    return Math.max(0, this.config.roundDuration - this.elapsed);
  }

  update(dt: number, input: Input): void {
    this.celebration = Math.max(0, this.celebration - dt * 3);

    if (this.phase === 'ready') {
      // A round starts on your first hummed note, same as Hum Flyer and Voice
      // Line Rider — no button, the voice is the controller.
      if (input.voiced && input.pitchNorm !== null) {
        this.phase = 'playing';
        this.readInput(input);
        // Snap rather than chase on the very first frame, so the round
        // doesn't open with the reticle visibly sliding in from the centre.
        this.reticleX = this.lastVowelNorm ?? 0.5;
        this.reticleY = this.lastPitchNorm ?? 0.5;
      }
      return;
    }
    if (this.phase !== 'playing') return;

    this.elapsed += dt;
    if (this.elapsed >= this.config.roundDuration) {
      this.phase = 'over';
      return;
    }

    this.readInput(input);
    this.chase(dt);
    this.checkHit();
  }

  private readInput(input: Input): void {
    if (!input.voiced || input.pitchNorm === null) return;
    this.lastPitchNorm = input.pitchNorm;
    this.lastVowelNorm = normaliseCentroid(input.centroid, this.config.vowelRange);
  }

  private chase(dt: number): void {
    if (this.lastPitchNorm === null || this.lastVowelNorm === null) return;
    const blend = 1 - Math.exp(-this.config.responsiveness * dt);
    this.reticleX += (this.lastVowelNorm - this.reticleX) * blend;
    this.reticleY += (this.lastPitchNorm - this.reticleY) * blend;
  }

  private checkHit(): void {
    const dx = this.reticleX - this.target.x;
    const dy = this.reticleY - this.target.y;
    if (Math.sqrt(dx * dx + dy * dy) > this.config.targetRadius) return;

    this.score++;
    this.celebration = 1;
    this.targetIndex++;
    this.target = targetPosition(this.targetIndex, this.config.targetMargin);
  }
}
