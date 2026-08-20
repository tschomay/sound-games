import { describe, expect, it } from 'vitest';
import {
  VowelSteeringSpike,
  DEFAULT_CONFIG,
  DEFAULT_VOWEL_RANGE,
  normaliseCentroid,
  type Config,
  type Input,
} from '../game';

const DT = 1 / 60;

function humming(pitchNorm: number, centroid: number): Input {
  return { voiced: true, pitchNorm, centroid };
}

const silence: Input = { voiced: false, pitchNorm: null, centroid: 0 };

function run(game: VowelSteeringSpike, input: Input, frames: number): void {
  for (let i = 0; i < frames; i++) game.update(DT, input);
}

const FAST: Config = { ...DEFAULT_CONFIG, roundDuration: 1 };

describe('normaliseCentroid', () => {
  it('maps the bottom of the range to 0 and the top to 1', () => {
    expect(normaliseCentroid(DEFAULT_VOWEL_RANGE.lowHz)).toBeCloseTo(0, 5);
    expect(normaliseCentroid(DEFAULT_VOWEL_RANGE.highHz)).toBeCloseTo(1, 5);
  });

  it('is log-scaled: the geometric mean of the range sits at 0.5', () => {
    const mid = Math.sqrt(DEFAULT_VOWEL_RANGE.lowHz * DEFAULT_VOWEL_RANGE.highHz);
    expect(normaliseCentroid(mid)).toBeCloseTo(0.5, 5);
  });

  it('clamps outside the range instead of extrapolating', () => {
    expect(normaliseCentroid(1)).toBe(0);
    expect(normaliseCentroid(100000)).toBe(1);
  });

  it('rejects non-positive Hz safely rather than producing NaN/Infinity', () => {
    expect(normaliseCentroid(0)).toBe(0);
    expect(normaliseCentroid(-50)).toBe(0);
  });

  it("is a pure function of Hz alone — it never sees a pitch value, so its own\n" +
    '   formula cannot itself introduce a pitch dependency (see the ADR: any\n' +
    '   coupling the spike shows has to come from the acoustic signal, not this math)', () => {
    // Same centroid Hz, called in isolation, always normalises identically —
    // there is no hidden pitch parameter for it to vary with.
    const a = normaliseCentroid(1200);
    const b = normaliseCentroid(1200);
    expect(a).toBe(b);
  });
});

/**
 * Synthetic technical analysis (see the ADR and roadmap Phase 5): this can't
 * resolve whether the two axes *feel* independent — that needs a human on a
 * real microphone — but it can check for a real, computable acoustic
 * coupling the normalisation math should be honest about rather than hide.
 *
 * For a harmonic-rich voiced sound, spectral centroid is a weighted average
 * of harmonic frequencies k*f0 (k = 1, 2, 3, ...), so it can never fall below
 * the fundamental itself: centroid = f0 * (sum of a_k * k) / (sum of a_k) >=
 * f0 * 1 = f0, since every k >= 1. That means at high pitch, the *lowest*
 * centroid a voice can physically produce rises right along with pitch — a
 * real acoustic floor, not a bug in `normaliseCentroid`. This test builds a
 * synthetic harmonic spectrum at a few pitches across the calibrated range
 * and confirms the floor behaves exactly as that reasoning predicts, so the
 * ADR's writeup is checked arithmetic rather than a guess.
 */
describe('synthetic acoustic coupling check (informs the ADR, does not resolve it)', () => {
  function harmonicCentroid(f0: number, harmonicCount: number, rolloff: number): number {
    let weighted = 0;
    let total = 0;
    for (let k = 1; k <= harmonicCount; k++) {
      // A simple decaying-harmonics model (roughly how a hummed vowel's
      // energy actually falls off with harmonic number) — the exact rolloff
      // shape isn't the point, only that centroid is a harmonic-weighted
      // average and so is bounded below by f0.
      const amplitude = Math.pow(rolloff, k - 1);
      weighted += f0 * k * amplitude;
      total += amplitude;
    }
    return weighted / total;
  }

  it('centroid never falls below the fundamental, for any rolloff shape', () => {
    const rolloffs = [0.3, 0.6, 0.9];
    const pitches = [110, 220, 440];
    for (const f0 of pitches) {
      for (const rolloff of rolloffs) {
        const centroid = harmonicCentroid(f0, 12, rolloff);
        expect(centroid).toBeGreaterThanOrEqual(f0 - 1e-9);
      }
    }
  });

  it('the reachable minimum vowelNorm rises with pitch — real bleed the roadmap already expects', () => {
    // Same "brightest possible" harmonic shape (fast rolloff = energy
    // concentrated near f0, the darkest a voice can sound) at low vs. high
    // pitch. If the floor were pitch-independent, both would normalise the
    // same; per the reasoning above they should not.
    const darkAtLowPitch = normaliseCentroid(harmonicCentroid(110, 12, 0.3));
    const darkAtHighPitch = normaliseCentroid(harmonicCentroid(440, 12, 0.3));
    expect(darkAtHighPitch).toBeGreaterThan(darkAtLowPitch);
  });

  it('at a high enough pitch the fundamental alone can sit inside the vowel range, ' +
    'meaning "as dark as possible" stops being reachable at 0', () => {
    // A soprano-range note (~500Hz) is already at DEFAULT_VOWEL_RANGE.lowHz —
    // no harmonic-only sound can have a centroid below its own f0, so the
    // darkest reachable vowelNorm at that pitch is bounded well above 0.
    // This is the concrete version of the roadmap's "the centroid moves with
    // pitch" risk, not a hypothetical.
    const highNote = 494; // roughly a B4, plausible top of a calibrated hum range
    const darkest = normaliseCentroid(harmonicCentroid(highNote, 12, 0.3));
    expect(darkest).toBeGreaterThan(0.05);
  });
});

describe('VowelSteeringSpike', () => {
  it('stays ready until the first hummed note', () => {
    const game = new VowelSteeringSpike(FAST);
    run(game, silence, 120);
    expect(game.phase).toBe('ready');
    expect(game.score).toBe(0);
  });

  it('starts on the first hummed note and snaps the reticle to the reading, not the field centre', () => {
    const game = new VowelSteeringSpike(FAST);
    game.update(DT, humming(0.9, 2800));
    expect(game.phase).toBe('playing');
    expect(game.reticleY).toBeCloseTo(0.9, 5);
    expect(game.lastVowelNorm).not.toBeNull();
  });

  it('holds the last reading through a silent gap instead of snapping to the centre', () => {
    const game = new VowelSteeringSpike(FAST);
    game.update(DT, humming(0.7, 1500));
    const heldPitch = game.lastPitchNorm;
    const heldVowel = game.lastVowelNorm;
    run(game, silence, 10);
    expect(game.lastPitchNorm).toBe(heldPitch);
    expect(game.lastVowelNorm).toBe(heldVowel);
  });

  it('chases the reticle toward the held reading over time rather than snapping every frame', () => {
    const game = new VowelSteeringSpike(FAST);
    game.update(DT, humming(0.1, 500)); // starts near the bottom-left
    game.update(DT, humming(0.95, 2900)); // reading jumps far away in one frame
    // One frame later the reticle should have moved partway, not all the way.
    expect(game.reticleY).toBeGreaterThan(0.1);
    expect(game.reticleY).toBeLessThan(0.95);
  });

  it('scores a hit when the reticle settles on the target and advances to a new one', () => {
    const game = new VowelSteeringSpike(FAST);
    const firstTarget = game.target; // deterministic: { x: 0.14, y: 0.14 } at defaults
    // A reading right at the target's own coordinates, held steady, means the
    // reticle snaps onto it on the very first ('ready') frame and should
    // register a hit on the first 'playing' frame that follows.
    const vowelHzAtTarget =
      DEFAULT_VOWEL_RANGE.lowHz *
      Math.pow(2, firstTarget.x * Math.log2(DEFAULT_VOWEL_RANGE.highHz / DEFAULT_VOWEL_RANGE.lowHz));
    const input = humming(firstTarget.y, vowelHzAtTarget);
    game.update(DT, input);
    run(game, input, 5);
    expect(game.score).toBe(1);
    expect(game.target).not.toEqual(firstTarget);
  });

  it('ends the round after roundDuration regardless of score', () => {
    const game = new VowelSteeringSpike(FAST);
    game.update(DT, humming(0.5, 1200));
    run(game, humming(0.5, 1200), 120); // well past FAST.roundDuration (1s)
    expect(game.phase).toBe('over');
  });

  it('target positions are deterministic, so rounds and tests are reproducible', () => {
    const a = new VowelSteeringSpike(FAST);
    const b = new VowelSteeringSpike(FAST);
    expect(a.target).toEqual(b.target);
  });
});
