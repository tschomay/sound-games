/**
 * Section-brightness tests.
 *
 * Same honest framing as `engine/__tests__/sections.test.ts`: every track here
 * is a synthetic, internally stationary concatenation of pure tones, built
 * with the same "known ground truth" technique — a tone's own frequency is
 * (approximately) its true mean spectral centroid, which real music's blend
 * of harmonics, noise and percussion never is this cleanly. What this
 * establishes is that the pass *measures what it claims to* — a low tone
 * reads far darker than a high one, and a section spanning both lands between
 * them because more than one window was actually sampled across it — not any
 * accuracy claim on real music.
 */
import { describe, expect, it } from 'vitest';
import { computeSectionBrightness } from '../sectionBrightness';
import type { DecodedAudio } from '../../../engine/beat-offline';
import type { Section } from '../../../engine/sections';

/** Wrap raw mono samples in the slice of `DecodedAudio` the analysis reads —
 *  the same minimal shape `engine/__tests__/synthetic-audio.ts`'s own
 *  `decodedAudio` uses, kept as a local copy per this codebase's convention. */
function decodedAudio(samples: Float32Array, sampleRate: number): DecodedAudio {
  return {
    sampleRate,
    length: samples.length,
    numberOfChannels: 1,
    getChannelData: () => samples,
  };
}

/** A minimal, valid `Section` — tests only override what they care about. */
function section(overrides: Partial<Section> & { startSeconds: number; endSeconds: number }): Section {
  return {
    index: 0,
    intensity: 0.5,
    loudnessDb: -10,
    boundaryStrength: 0,
    isDrop: false,
    startBeat: null,
    beatCount: null,
    durationSeconds: overrides.endSeconds - overrides.startSeconds,
    ...overrides,
  };
}

/** A track built from concatenated pure tones, each held for its own span,
 *  with one `Section` per tone spanning exactly that tone's time range. */
function toneTrack(
  specs: { hz: number; seconds: number }[],
  sampleRate = 44100,
): { audio: DecodedAudio; sections: Section[] } {
  const total = specs.reduce((sum, spec) => sum + spec.seconds, 0);
  const samples = new Float32Array(Math.round(total * sampleRate));
  const sections: Section[] = [];
  let cursor = 0;
  specs.forEach((spec, index) => {
    const from = Math.round(cursor * sampleRate);
    const to = Math.min(samples.length, Math.round((cursor + spec.seconds) * sampleRate));
    for (let i = from; i < to; i++) {
      samples[i] = 0.5 * Math.sin((2 * Math.PI * spec.hz * i) / sampleRate);
    }
    sections.push(section({ index, startSeconds: cursor, endSeconds: cursor + spec.seconds }));
    cursor += spec.seconds;
  });
  return { audio: decodedAudio(samples, sampleRate), sections };
}

describe('computeSectionBrightness', () => {
  it('returns an empty array for an empty section list', () => {
    const { audio } = toneTrack([{ hz: 440, seconds: 2 }]);
    expect(computeSectionBrightness(audio, [])).toEqual([]);
  });

  it('reads a low-tone section as much darker than a high-tone section', () => {
    const { audio, sections } = toneTrack([
      { hz: 200, seconds: 2 },
      { hz: 4000, seconds: 2 },
    ]);
    const [low, high] = computeSectionBrightness(audio, sections);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low * 5);
  });

  it('centres roughly on its own tone for a stationary single-tone section', () => {
    const { audio, sections } = toneTrack([{ hz: 1000, seconds: 3 }]);
    const [centroid] = computeSectionBrightness(audio, sections);
    // Loose tolerance: a windowed FFT on a finite buffer, not an idealised
    // infinite tone, so some leakage-driven drift off 1000Hz is expected.
    expect(centroid).toBeGreaterThan(700);
    expect(centroid).toBeLessThan(1400);
  });

  it('averages across multiple windows spread over the section, not just its first instant', () => {
    const { audio } = toneTrack([
      { hz: 200, seconds: 2 },
      { hz: 6000, seconds: 2 },
    ]);
    const whole = section({ startSeconds: 0, endSeconds: 4 });
    const lowHalf = section({ startSeconds: 0, endSeconds: 2 });
    const highHalf = section({ startSeconds: 2, endSeconds: 4 });

    const [blended] = computeSectionBrightness(audio, [whole]);
    const [lowOnly] = computeSectionBrightness(audio, [lowHalf]);
    const [highOnly] = computeSectionBrightness(audio, [highHalf]);

    // If only the section's first instant were sampled, `blended` would equal
    // `lowOnly` exactly; landing strictly between the two halves' own means is
    // only possible if windows from both halves were actually averaged.
    expect(blended).toBeGreaterThan(lowOnly);
    expect(blended).toBeLessThan(highOnly);
  });

  it('returns 0 rather than throwing for a buffer too short to hold one window', () => {
    const tiny = decodedAudio(new Float32Array(8), 44100);
    const tinySection = section({ startSeconds: 0, endSeconds: 8 / 44100 });
    expect(computeSectionBrightness(tiny, [tinySection])).toEqual([0]);
  });

  it('returns one value per section, in section order', () => {
    const { audio, sections } = toneTrack([
      { hz: 300, seconds: 1.5 },
      { hz: 1200, seconds: 1.5 },
      { hz: 5000, seconds: 1.5 },
    ]);
    const result = computeSectionBrightness(audio, sections);
    expect(result).toHaveLength(3);
    expect(result[0]).toBeLessThan(result[1]);
    expect(result[1]).toBeLessThan(result[2]);
  });
});
