/**
 * Trackgen's one new piece of analysis: a per-`Section` mean spectral centroid.
 *
 * `analyseSongStructure` (`engine/sections.ts`) hands back section boundaries in
 * seconds — where the music changes character — but says nothing about how
 * *bright* each section sounds, and that brightness is exactly what B5's biome
 * palette needs (`docs/ideas.md` B5: "one biome per section, coloured by that
 * chapter's own mean spectral brightness"). Nothing in the engine computes
 * that, and per the brief it does not belong there either — it is a one-off
 * composition of building blocks the engine already exports (`downmixAndDecimate`,
 * `Fft`, `hannWindow`), not new DSP, so it stays local to this game.
 *
 * The formula is exactly `Analyser.centroid()`'s live one —
 * `Σ(bin_hz * magnitude) / Σ(magnitude)`, the magnitude-weighted mean frequency
 * of the spectrum — just run offline over a handful of STFT windows per section
 * instead of once per live frame. "A handful" is deliberate: this doesn't need
 * to be frame-accurate the way the live analyser is, only accurate enough to
 * separate a dark verse from a bright chorus, so `WINDOWS_PER_SECTION` windows
 * spread evenly across a section and averaged is plenty.
 */
import { downmixAndDecimate, type DecodedAudio } from '../../engine/beat-offline';
import { Fft, hannWindow } from '../../engine/fft';
import type { Section } from '../../engine/sections';

/** Matches `sections.ts`'s own analysis rate — no reason for this pass to see a
 *  wider spectrum than the structure detector already decided was enough. */
const ANALYSIS_RATE_HZ = 22050;
/** ~93ms at the analysis rate, same window `sections.ts` uses for its own STFT
 *  — long enough for real frequency resolution, and reusing the same size means
 *  no new tuning question is introduced by this pass. */
const WINDOW = 2048;
/** Windows sampled per section, evenly spaced. A handful, per the brief — this
 *  is a brightness label for a whole chapter, not a frame-by-frame reading. */
const WINDOWS_PER_SECTION = 6;

/**
 * Mean spectral centroid in Hz, one entry per `sections[i]`, in order.
 *
 * Returns 0 for a section too short to hold even one window (only possible at
 * the ragged tail of a very short file) rather than throwing — same "never
 * fails on degenerate input" posture `sections.ts` and `beat-offline.ts` take.
 */
export function computeSectionBrightness(audio: DecodedAudio, sections: readonly Section[]): number[] {
  if (sections.length === 0) return [];

  const decimation = Math.max(1, Math.round(audio.sampleRate / ANALYSIS_RATE_HZ));
  const rate = audio.sampleRate / decimation;
  const mono = downmixAndDecimate(audio, decimation);
  if (mono.length < WINDOW) return sections.map(() => 0);

  const fft = new Fft(WINDOW);
  const window = hannWindow(WINDOW);
  const bins = WINDOW / 2 + 1;
  const re = new Float32Array(WINDOW);
  const im = new Float32Array(WINDOW);
  const magnitude = new Float32Array(bins);
  const maxStart = mono.length - WINDOW;

  return sections.map((section) => {
    const starts = windowStarts(section, rate, maxStart);
    if (starts.length === 0) return 0;
    let sum = 0;
    for (const start of starts) {
      for (let i = 0; i < WINDOW; i++) re[i] = mono[start + i] * window[i];
      im.fill(0);
      fft.magnitudes(re, im, magnitude);
      sum += windowCentroidHz(magnitude, rate);
    }
    return sum / starts.length;
  });
}

/** The magnitude-weighted mean frequency of one window's spectrum — the exact
 *  formula `Analyser.centroid()` uses live, bin 0 (DC) excluded same as there. */
function windowCentroidHz(magnitude: Float32Array, rate: number): number {
  let weighted = 0;
  let total = 0;
  for (let i = 1; i < magnitude.length; i++) {
    const hz = (i * rate) / WINDOW;
    weighted += hz * magnitude[i];
    total += magnitude[i];
  }
  return total > 0 ? weighted / total : 0;
}

/**
 * Evenly spaced window start sample indices across one section, clamped so
 * every window fits inside the decoded buffer. A section shorter than one
 * window still gets a single window, taken at its start and clamped — this
 * doesn't need to be exact, just present.
 */
function windowStarts(section: Section, rate: number, maxStart: number): number[] {
  const startSample = Math.round(section.startSeconds * rate);
  const endSample = Math.round(section.endSeconds * rate);
  const span = endSample - startSample;
  if (span <= 0 || startSample > maxStart) {
    return maxStart >= 0 ? [clamp(startSample, 0, maxStart)] : [];
  }

  const count = Math.max(1, Math.min(WINDOWS_PER_SECTION, Math.floor(span / WINDOW)));
  const slack = Math.max(0, span - WINDOW);
  const starts: number[] = [];
  for (let k = 0; k < count; k++) {
    const frac = count === 1 ? 0.5 : k / (count - 1);
    starts.push(clamp(Math.round(startSample + frac * slack), 0, maxStart));
  }
  return starts;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
