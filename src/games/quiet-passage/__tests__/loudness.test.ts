import { describe, expect, it } from 'vitest';
import {
  buildGaps,
  computeLoudnessEnvelope,
  findQuietWindows,
  analyseQuietPassageLevel,
  DEFAULT_LEVEL_CONFIG,
  type LevelConfig,
  type LoudnessEnvelope,
  type QuietWindow,
} from '../loudness';
import { decodedAudio } from '../../../engine/__tests__/synthetic-audio';
import { DEFAULT_PROFILE } from '../../../engine/calibration';
import type { CalibrationProfile } from '../../../engine/types';

const SAMPLE_RATE = 8000;

/** Constant-amplitude segments, not sine waves — RMS of a constant array is
 *  just the amplitude itself, which keeps the expected dB (and therefore the
 *  expected normalised level) exact rather than approximate. */
function constantSegments(segments: Array<{ seconds: number; amplitude: number }>): Float32Array {
  const total = segments.reduce((sum, s) => sum + Math.round(s.seconds * SAMPLE_RATE), 0);
  const samples = new Float32Array(total);
  let cursor = 0;
  for (const segment of segments) {
    const n = Math.round(segment.seconds * SAMPLE_RATE);
    samples.fill(segment.amplitude, cursor, cursor + n);
    cursor += n;
  }
  return samples;
}

/** Loud (0.5 amplitude, clamps to level 1 against `DEFAULT_PROFILE`), quiet
 *  (0.0005 amplitude, clamps to level 0), loud again — 3s / 2.5s / 3s, chosen
 *  so every segment boundary lands on an exact window edge at the default
 *  1000Hz analysis rate / 0.25s window (2000 raw samples per window). */
function loudQuietLoudAudio() {
  return decodedAudio(
    constantSegments([
      { seconds: 3, amplitude: 0.5 },
      { seconds: 2.5, amplitude: 0.0005 },
      { seconds: 3, amplitude: 0.5 },
    ]),
    SAMPLE_RATE,
  );
}

describe('computeLoudnessEnvelope', () => {
  it('covers the whole file at one level per window', () => {
    const envelope = computeLoudnessEnvelope(loudQuietLoudAudio(), DEFAULT_PROFILE);
    expect(envelope.duration).toBeCloseTo(8.5, 5);
    // 8.5s / 0.25s windows, all landing exactly since every segment boundary
    // above was chosen to divide evenly.
    expect(envelope.levels.length).toBe(34);
  });

  it('reads a loud segment louder than a quiet one', () => {
    const envelope = computeLoudnessEnvelope(loudQuietLoudAudio(), DEFAULT_PROFILE);
    const loudWindow = envelope.levels[0];
    const quietWindow = envelope.levels[16]; // squarely inside the quiet segment
    expect(loudWindow).toBeGreaterThan(quietWindow);
    expect(loudWindow).toBeCloseTo(1, 5); // clamped against DEFAULT_PROFILE.loudDb
    expect(quietWindow).toBeCloseTo(0, 5); // clamped against DEFAULT_PROFILE's floor
  });

  it('is empty for audio shorter than a single window', () => {
    const audio = decodedAudio(new Float32Array(10), SAMPLE_RATE);
    const envelope = computeLoudnessEnvelope(audio, DEFAULT_PROFILE);
    expect(envelope.levels.length).toBe(0);
  });

  it('normalises through whatever profile it is given, not a fixed scale', () => {
    // A player with a much louder measured ceiling should read the exact
    // same audio as quieter, relative to their own range.
    const generousProfile: CalibrationProfile = { ...DEFAULT_PROFILE, loudDb: 0 };
    const audio = loudQuietLoudAudio();
    const normal = computeLoudnessEnvelope(audio, DEFAULT_PROFILE);
    const generous = computeLoudnessEnvelope(audio, generousProfile);
    expect(generous.levels[0]).toBeLessThan(normal.levels[0]);
  });
});

describe('findQuietWindows', () => {
  function envelope(levels: number[], windowSeconds = 0.25): LoudnessEnvelope {
    return { levels: Float32Array.from(levels), windowSeconds, duration: levels.length * windowSeconds };
  }

  it('finds nothing in an empty envelope', () => {
    expect(findQuietWindows(envelope([]))).toEqual({ windows: [], thresholdLevel: 0 });
  });

  it('reports the requested percentile as the threshold', () => {
    // Ten windows, three quiet (0) and seven loud (1). Sorted: three 0s then
    // seven 1s; the 30th percentile (floor(0.3 * 9) = index 2) lands on the
    // last of those three zeros.
    const { thresholdLevel } = findQuietWindows(envelope([1, 0, 1, 0, 1, 1, 0, 1, 1, 1]));
    expect(thresholdLevel).toBe(0);
  });

  it('finds a contiguous run at/below threshold and reports its exact span', () => {
    const config: LevelConfig = { ...DEFAULT_LEVEL_CONFIG, minQuietSeconds: 0.5 };
    // 4 loud, 6 quiet (1.5s, above the lowered minQuietSeconds), 4 loud.
    const values = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1];
    const { windows } = findQuietWindows(envelope(values), config);
    expect(windows).toEqual([{ startSeconds: 1, endSeconds: 2.5 }]);
  });

  it('drops a run shorter than minQuietSeconds', () => {
    const config: LevelConfig = { ...DEFAULT_LEVEL_CONFIG, minQuietSeconds: 2 };
    // The same 1.5s quiet run as above, now below the 2s minimum.
    const values = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1];
    const { windows } = findQuietWindows(envelope(values), config);
    expect(windows).toEqual([]);
  });

  it('closes out a run that is still open at the very end of the track', () => {
    const config: LevelConfig = { ...DEFAULT_LEVEL_CONFIG, minQuietSeconds: 0.5 };
    const values = [1, 1, 0, 0, 0, 0];
    const { windows } = findQuietWindows(envelope(values), config);
    expect(windows).toEqual([{ startSeconds: 0.5, endSeconds: 1.5 }]);
  });

  it('clamps the threshold well below 1 for a uniformly loud envelope, rather than calling the loudest window quiet', () => {
    const config: LevelConfig = { ...DEFAULT_LEVEL_CONFIG, minQuietSeconds: 0.1 };
    const { windows, thresholdLevel } = findQuietWindows(envelope(new Array(20).fill(1)), config);
    expect(thresholdLevel).toBeLessThan(1);
    expect(windows).toEqual([]);
  });

  it('finds the true quiet stretch end to end, through computeLoudnessEnvelope', () => {
    const envelope = computeLoudnessEnvelope(loudQuietLoudAudio(), DEFAULT_PROFILE);
    const { windows, thresholdLevel } = findQuietWindows(envelope);
    expect(thresholdLevel).toBeCloseTo(0, 5);
    expect(windows).toEqual([{ startSeconds: 3, endSeconds: 5.5 }]);
  });
});

describe('buildGaps', () => {
  const windows: QuietWindow[] = [
    { startSeconds: 3, endSeconds: 5.5 },
    { startSeconds: 10, endSeconds: 12 },
    { startSeconds: 20, endSeconds: 22 },
  ];

  it('pads each window with lead-in and lead-out', () => {
    const gaps = buildGaps(windows, 30, DEFAULT_LEVEL_CONFIG);
    expect(gaps[0].startSeconds).toBeCloseTo(3 - DEFAULT_LEVEL_CONFIG.leadInSeconds, 5);
    expect(gaps[0].endSeconds).toBeCloseTo(5.5 + DEFAULT_LEVEL_CONFIG.leadOutSeconds, 5);
  });

  it('clamps padding to [0, duration]', () => {
    const nearEdges: QuietWindow[] = [{ startSeconds: 0.1, endSeconds: 29.9 }];
    const [gap] = buildGaps(nearEdges, 30, DEFAULT_LEVEL_CONFIG);
    expect(gap.startSeconds).toBe(0);
    expect(gap.endSeconds).toBe(30);
  });

  it('cycles lanes so consecutive gaps are never in the same lane', () => {
    const gaps = buildGaps(windows, 30, { ...DEFAULT_LEVEL_CONFIG, laneCount: 3 });
    expect(gaps.map((g) => g.lane)).toEqual([0, 1, 2]);
  });

  it('does not put every gap in the same lane over a longer run', () => {
    const many: QuietWindow[] = Array.from({ length: 5 }, (_, i) => ({
      startSeconds: i * 10,
      endSeconds: i * 10 + 2,
    }));
    const gaps = buildGaps(many, 100, { ...DEFAULT_LEVEL_CONFIG, laneCount: 3 });
    const distinctLanes = new Set(gaps.map((g) => g.lane));
    expect(distinctLanes.size).toBeGreaterThan(1);
  });
});

describe('analyseQuietPassageLevel', () => {
  it('produces one crossable gap in the quiet stretch, correctly padded', () => {
    const level = analyseQuietPassageLevel(loudQuietLoudAudio(), DEFAULT_PROFILE);
    expect(level.durationSeconds).toBeCloseTo(8.5, 5);
    expect(level.gaps).toHaveLength(1);
    expect(level.gaps[0].lane).toBe(0);
    expect(level.gaps[0].startSeconds).toBeCloseTo(3 - DEFAULT_LEVEL_CONFIG.leadInSeconds, 5);
    expect(level.gaps[0].endSeconds).toBeCloseTo(5.5 + DEFAULT_LEVEL_CONFIG.leadOutSeconds, 5);
    expect(level.quietLevelThreshold).toBeCloseTo(0, 5);
    expect(level.laneCount).toBe(DEFAULT_LEVEL_CONFIG.laneCount);
  });

  it('places no gap at all in an unrelentingly loud track', () => {
    const audio = decodedAudio(constantSegments([{ seconds: 5, amplitude: 0.5 }]), SAMPLE_RATE);
    const level = analyseQuietPassageLevel(audio, DEFAULT_PROFILE);
    expect(level.gaps).toEqual([]);
  });
});
