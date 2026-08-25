/**
 * Quiet Passage's one piece of new analysis: a loudness-over-time envelope for
 * a whole file, and the quiet-window/gap-placement pass built on top of it.
 *
 * This lives here, not in `engine/`, because nothing else in the project needs
 * it — same "small self-contained game module" convention as Overtone's
 * `normaliseBrightness` and Trackgen's own offline pass (`docs/roadmap.md`'s
 * "B5–B8" paragraph). It reuses `engine/beat-offline.ts`'s already-exported
 * `downmixAndDecimate` for the mono reduction, and `engine/analyser.ts`'s
 * `rms`/`toDecibels` for the loudness measurement itself — the same two
 * functions `Analyser.read()` uses for `Frame.db` every live frame, just run
 * here once per window instead of once per animation frame. No FFT: the
 * ideas.md brief is explicit this game needs "a windowed RMS envelope, not a
 * full spectral analysis" — `bands`/`centroid` play no role at all.
 *
 * **Everything is normalised through the player's own calibration profile**
 * (`normaliseLevel`), the same 0..1 scale `Frame.level` is already on. That is
 * what lets the live game (`game.ts`) compare a live `Frame.level` reading
 * directly against thresholds this offline pass derived — see `game.ts`'s doc
 * comment for why that agreement is the whole mechanism, not a coincidence.
 */
import { downmixAndDecimate, type DecodedAudio } from '../../engine/beat-offline';
import { rms, toDecibels } from '../../engine/analyser';
import { normaliseLevel } from '../../engine/calibration';
import type { CalibrationProfile } from '../../engine/types';

/** A whole track's loudness, sampled at `1 / windowSeconds` Hz, normalised to
 *  the player's own calibration — the same scale as `Frame.level`. */
export interface LoudnessEnvelope {
  levels: Float32Array;
  windowSeconds: number;
  /** Length of the source audio in seconds. */
  duration: number;
}

/** One contiguous stretch where the track stays at/below the quiet threshold
 *  for long enough to be worth crossing. */
export interface QuietWindow {
  startSeconds: number;
  endSeconds: number;
}

/** One opening in the hazard ceiling — a lane, and the time span it is open
 *  for. Wider than the `QuietWindow` it was built from (see
 *  `LevelConfig.leadInSeconds`/`leadOutSeconds`): real lead-in, not just an
 *  instant-on gap the moment the music happens to dip. */
export interface Gap {
  startSeconds: number;
  endSeconds: number;
  /** 0-based, `< laneCount`. */
  lane: number;
}

/** Everything the round needs, computed once before play starts. */
export interface QuietPassageLevel {
  durationSeconds: number;
  gaps: Gap[];
  /** Normalised loudness (`Frame.level`'s own 0..1 scale) at/below which a
   *  window counted as "quiet" for gap placement. Carried forward so the live
   *  game can gate lane-switch taps and the hazard zone on the exact same
   *  number — see `game.ts`. */
  quietLevelThreshold: number;
  laneCount: number;
}

export interface LevelConfig {
  /** Sample rate the file is decimated to before the RMS pass. Far below any
   *  spectral-analysis rate in this codebase (`beat-offline.ts`'s 22050,
   *  `sections.ts`'s own) because loudness needs no frequency resolution at
   *  all, only enough samples per window for a stable RMS. */
  analysisRateHz: number;
  /** Width of each non-overlapping RMS window, in seconds. Short enough that
   *  a quiet stretch's true boundaries are found within a fraction of a
   *  second, long enough that a single window is a stable loudness reading
   *  rather than a single waveform cycle. */
  windowSeconds: number;
  /** Fraction (0..1) of windows, sorted by loudness, that fall at/below the
   *  quiet threshold. Percentile-derived rather than a fixed dB value so the
   *  same config plays fair on a track mastered quiet and one mastered loud —
   *  "quiet" always means "quiet for *this* track". */
  quietPercentile: number;
  /** Minimum length, in seconds, of a contiguous run of quiet windows before
   *  it is trusted with a gap — short dips are real but not actually
   *  crossable (no time to notice, switch lane, and cross), so they are left
   *  as ordinary hazard rather than an unfairly tight gap. */
  minQuietSeconds: number;
  /** Extra seconds the placed gap opens *before* the quiet window it was
   *  built from actually starts — real lead-in, so a player has time to hear
   *  the quiet arriving and switch lanes before the gap itself needs to be
   *  survived, not just the instant the window crosses the threshold. */
  leadInSeconds: number;
  /** Extra seconds the gap stays open *after* the quiet window ends — a
   *  smaller trailing margin so a gap doesn't slam shut the instant the
   *  quietest moment passes. */
  leadOutSeconds: number;
  /** How many parallel lanes gaps are distributed across. */
  laneCount: number;
}

export const DEFAULT_LEVEL_CONFIG: LevelConfig = {
  analysisRateHz: 1000,
  windowSeconds: 0.25,
  quietPercentile: 0.3,
  // 1.4s of confirmed quiet, plus the lead-in below, gives a gap something
  // like 2s of real open time at its narrowest — enough to notice, switch
  // lane and cross at the world scale `index.ts` renders at.
  minQuietSeconds: 1.4,
  leadInSeconds: 0.6,
  leadOutSeconds: 0.3,
  laneCount: 3,
};

/** Windowed RMS-in-dB, normalised through the player's own calibration —
 *  the offline half of the "live and offline read the same signal" pairing
 *  `game.ts` relies on. */
export function computeLoudnessEnvelope(
  audio: DecodedAudio,
  profile: CalibrationProfile,
  config: LevelConfig = DEFAULT_LEVEL_CONFIG,
): LoudnessEnvelope {
  const duration = audio.length / audio.sampleRate;
  const decimation = Math.max(1, Math.round(audio.sampleRate / config.analysisRateHz));
  const rate = audio.sampleRate / decimation;
  const mono = downmixAndDecimate(audio, decimation);

  const windowSamples = Math.max(1, Math.round(config.windowSeconds * rate));
  const windowCount = Math.floor(mono.length / windowSamples);

  const levels = new Float32Array(Math.max(0, windowCount));
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowSamples;
    const window = mono.subarray(start, start + windowSamples);
    levels[w] = normaliseLevel(toDecibels(rms(window)), profile);
  }

  return { levels, windowSeconds: config.windowSeconds, duration };
}

/**
 * A degenerate track with essentially no dynamic range (uniformly loud, or
 * uniformly at any one level) makes the raw percentile threshold equal to
 * that one level itself — every window ties for "quietest", so a plain
 * percentile would call the *loudest* window "quiet" too. Left unguarded that
 * is actively dangerous, not just a wasted gap: `game.ts` derives its own
 * live hazard-zone boundary as `1 - quietLevelThreshold`, so a threshold of 1
 * collapses that boundary to 0 and the *entire* track becomes hazardous the
 * instant play starts, gap or no gap. Clamping the threshold well below 1
 * keeps a uniformly loud track from ever being called quiet at all (no gaps,
 * but also never any hazard risk, since a live level that never dips can
 * never chase `height` into a hazard zone either) — the honest outcome for a
 * track with nothing quiet in it, not a spurious one.
 */
const MAX_QUIET_LEVEL_THRESHOLD = 0.9;

/**
 * Contiguous stretches of the envelope at/below a percentile-derived
 * threshold, filtered to ones long enough to be worth crossing. The threshold
 * is returned alongside the windows because `game.ts` needs the exact same
 * number live, not just the windows it produced.
 */
export function findQuietWindows(
  envelope: LoudnessEnvelope,
  config: LevelConfig = DEFAULT_LEVEL_CONFIG,
): { windows: QuietWindow[]; thresholdLevel: number } {
  const { levels, windowSeconds, duration } = envelope;
  if (levels.length === 0) return { windows: [], thresholdLevel: 0 };

  const thresholdLevel = Math.min(percentile(levels, config.quietPercentile), MAX_QUIET_LEVEL_THRESHOLD);

  const windows: QuietWindow[] = [];
  let runStart: number | null = null;
  // One pass past the end so a run still open at the last window closes out.
  for (let i = 0; i <= levels.length; i++) {
    const quiet = i < levels.length && levels[i] <= thresholdLevel;
    if (quiet && runStart === null) runStart = i;
    if (!quiet && runStart !== null) {
      const startSeconds = runStart * windowSeconds;
      const endSeconds = Math.min(duration, i * windowSeconds);
      if (endSeconds - startSeconds >= config.minQuietSeconds) {
        windows.push({ startSeconds, endSeconds });
      }
      runStart = null;
    }
  }
  return { windows, thresholdLevel };
}

/**
 * One gap per quiet window, padded with lead-in/lead-out and spread across
 * lanes. Lanes cycle `index % laneCount` — the simplest assignment that
 * guarantees consecutive gaps are never in the same lane (for `laneCount >
 * 1`), which is all the brief actually requires ("not always the same
 * lane") — no need for anything audio-derived or random when a fixed
 * rotation already forces the lane-reading puzzle every time.
 */
export function buildGaps(
  windows: QuietWindow[],
  durationSeconds: number,
  config: LevelConfig = DEFAULT_LEVEL_CONFIG,
): Gap[] {
  return windows.map((window, index) => ({
    startSeconds: Math.max(0, window.startSeconds - config.leadInSeconds),
    endSeconds: Math.min(durationSeconds, window.endSeconds + config.leadOutSeconds),
    lane: index % config.laneCount,
  }));
}

/** Everything, end to end: decoded audio and a calibration profile in, a
 *  ready-to-play level out. */
export function analyseQuietPassageLevel(
  audio: DecodedAudio,
  profile: CalibrationProfile,
  config: LevelConfig = DEFAULT_LEVEL_CONFIG,
): QuietPassageLevel {
  const envelope = computeLoudnessEnvelope(audio, profile, config);
  const { windows, thresholdLevel } = findQuietWindows(envelope, config);
  const gaps = buildGaps(windows, envelope.duration, config);
  return {
    durationSeconds: envelope.duration,
    gaps,
    quietLevelThreshold: thresholdLevel,
    laneCount: config.laneCount,
  };
}

/** The value at `fraction` (0..1) through `values` sorted ascending — the
 *  simplest percentile that needs no interpolation, which is precise enough
 *  for a threshold that only ever gates a boolean "quiet enough or not". */
function percentile(values: Float32Array, fraction: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))));
  return sorted[index];
}
