/**
 * Offline whole-file beat tracking — the good one.
 *
 * The roadmap's Phase 6 says to "budget for the offline path to be the good
 * one", and this is why: with the whole decoded track in hand there is no
 * causality constraint at all. We can measure the tempo using every beat in the
 * file at once and then fit a single rigid grid to all of them, which is a far
 * better-conditioned problem than the causal tracker's "guess from the last
 * eight seconds" (see `beat-causal.ts`). The result is a `BeatGrid` computed
 * once, before playback starts, that `BeatGridReader` then answers per-frame
 * `BeatReading` queries from with no further analysis.
 *
 * Three stages:
 *
 * 1. **Onset envelope.** A log-compressed spectral-flux curve at 100 Hz across
 *    the whole file, conceptually the same measurement `onset.ts` makes per
 *    frame, but computed here from the buffer's own samples with our own STFT
 *    (`fft.ts`) rather than from a live `AnalyserNode`.
 * 2. **Tempo.** Autocorrelation of that envelope, scored through a comb that
 *    rewards energy on a candidate's beats and penalises energy exactly between
 *    them, which is what stops a steady pulse being read at half tempo.
 * 3. **Phase and refinement.** A single-frequency DFT of the envelope at the
 *    candidate beat rate, searched over a narrow band around the coarse tempo.
 *    Its magnitude scores how well the whole track's onsets line up on that
 *    grid, and its argument *is* the grid's phase — so one measurement gives
 *    both, at a precision limited by the length of the track rather than by the
 *    10ms envelope hop.
 *
 * See ADR-0010 for why each of those was chosen and where it is expected to
 * struggle on real music.
 */
import { Fft, hannWindow } from './fft';
import {
  DEFAULT_TEMPO_RANGE,
  bpmToPeriod,
  clamp01,
  periodToBpm,
  tempoPrior,
  type BeatReader,
  type BeatReading,
  type TempoRange,
} from './beat';

/**
 * The part of `AudioBuffer` this module actually reads. A real decoded
 * `AudioBuffer` from `createFileSource` satisfies it structurally; so does a
 * plain object a test builds, which is the point — none of the analysis below
 * needs a browser.
 */
export interface DecodedAudio {
  readonly sampleRate: number;
  /** Samples per channel. */
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** A spectral-flux curve over a whole track, sampled at `1 / hopSeconds` Hz. */
export interface OnsetEnvelope {
  values: Float32Array;
  hopSeconds: number;
  /** When `values[0]` happened, in seconds — the centre of the first window. */
  firstFrameSeconds: number;
  /** Length of the source audio in seconds, which outlives the last frame. */
  duration: number;
}

/** A whole track's beat positions, computed once before playback. */
export interface BeatGrid {
  bpm: number;
  /** Seconds per beat — `60 / bpm`, kept alongside it to avoid re-deriving. */
  period: number;
  /** Seconds from the start of the track to the first beat, in `[0, period)`. */
  offset: number;
  /**
   * Every beat instant in the track, ascending. Materialised for look-ahead —
   * drawing a grid, telegraphing an upcoming beat — but the grid is uniform by
   * construction, so `offset` and `period` are the source of truth and
   * `BeatGridReader` works from those.
   */
  beats: number[];
  /** 0..1, how strongly the track's onsets agree with this grid. */
  confidence: number;
  duration: number;
}

export interface OfflineBeatOptions extends Partial<TempoRange> {
  /**
   * Below this, the track is reported as having no findable beat rather than a
   * bad guess. It is the fraction of the envelope's energy that lands coherently
   * on *some* pulse, so it is scale-free: a click track scores near 1, unpitched
   * noise scores around `1/sqrt(frames)`, and real music with a drum kit lands
   * somewhere in the middle.
   */
  minPulseStrength?: number;
}

/** Analysis rate the file is decimated to before the STFT. Above the 8kHz flux
 *  ceiling by enough margin that the crude box-filter decimation below cannot
 *  alias anything we count into the band we count it in. */
const ANALYSIS_RATE_HZ = 22050;
/** ~23ms at the analysis rate. Short on purpose: frequency resolution barely
 *  matters for flux, but window length is what limits how precisely an onset can
 *  be placed in time, and grid phase accuracy comes directly out of that. */
const WINDOW = 512;
const HOP_SECONDS = 0.01;
/** Same reasoning as `onset.ts`: transient energy is mostly below this and the
 *  top of the spectrum is mostly hiss. */
const FLUX_MAX_HZ = 8000;
/** Magnitudes are compressed as log(1 + C·m). Without it a loud chorus dominates
 *  the envelope and a quiet verse contributes nothing to the tempo estimate. */
const LOG_COMPRESSION = 1000;
/** Half-width of the moving average subtracted from the envelope, in seconds.
 *  Removing a *local* mean rather than the global one is what makes the
 *  autocorrelation measure beats instead of measuring the track's arrangement. */
const DETREND_SECONDS = 0.15;
/** A tempo cannot be argued from less audio than this. */
const MIN_ANALYSIS_SECONDS = 3;

/** Spectral flux across the whole file. Exposed separately from the tempo
 *  analysis so a caller (or a test) can supply an envelope by other means. */
export function computeOnsetEnvelope(audio: DecodedAudio): OnsetEnvelope {
  const decimation = Math.max(1, Math.round(audio.sampleRate / ANALYSIS_RATE_HZ));
  const rate = audio.sampleRate / decimation;
  const hop = Math.max(1, Math.round(rate * HOP_SECONDS));
  const duration = audio.length / audio.sampleRate;
  const mono = downmixAndDecimate(audio, decimation);

  const frameCount = mono.length >= WINDOW ? Math.floor((mono.length - WINDOW) / hop) + 1 : 0;
  const envelope: OnsetEnvelope = {
    values: new Float32Array(Math.max(0, frameCount)),
    hopSeconds: hop / rate,
    // A window's flux is attributed to its centre: the flux peak for a click
    // appears as the click passes through the middle of the Hann taper, not as
    // it enters the window's edge where the taper has zeroed it out.
    firstFrameSeconds: WINDOW / 2 / rate,
    duration,
  };
  if (frameCount === 0) return envelope;

  const fft = new Fft(WINDOW);
  const window = hannWindow(WINDOW);
  const bins = WINDOW / 2 + 1;
  const maxBin = Math.min(bins, Math.ceil((FLUX_MAX_HZ * WINDOW) / rate));
  const re = new Float32Array(WINDOW);
  const im = new Float32Array(WINDOW);
  const magnitude = new Float32Array(bins);
  const previous = new Float32Array(bins);

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hop;
    for (let i = 0; i < WINDOW; i++) re[i] = mono[start + i] * window[i];
    im.fill(0);
    fft.magnitudes(re, im, magnitude);

    let flux = 0;
    for (let i = 0; i < maxBin; i++) {
      const compressed = Math.log1p(LOG_COMPRESSION * magnitude[i]);
      const delta = compressed - previous[i];
      if (delta > 0) flux += delta;
      previous[i] = compressed;
    }
    // Frame 0 has no predecessor, so its "flux" is just the whole spectrum
    // appearing at once — a false onset at t=0 that would anchor the grid to the
    // start of the file rather than to the music.
    envelope.values[frame] = frame === 0 ? 0 : flux / maxBin;
  }
  return envelope;
}

/** Mono, box-filtered down by `decimation`. Shared with `sections.ts`, which
 *  needs the same reduction before its own STFT and should not carry a second
 *  copy of it. */
export function downmixAndDecimate(audio: DecodedAudio, decimation: number): Float32Array {
  const n = Math.floor(audio.length / decimation);
  const mono = new Float32Array(n);
  const channels = Math.max(1, audio.numberOfChannels);
  for (let channel = 0; channel < channels; channel++) {
    const data = audio.getChannelData(channel);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const base = i * decimation;
      for (let k = 0; k < decimation; k++) sum += data[base + k];
      mono[i] += sum / (decimation * channels);
    }
  }
  return mono;
}

/**
 * Find the beat grid in an onset envelope. Returns `null` when the envelope has
 * no coherent pulse — silence, applause, spoken word — rather than inventing a
 * tempo for it.
 */
export function analyseEnvelope(
  envelope: OnsetEnvelope,
  options: OfflineBeatOptions = {},
): BeatGrid | null {
  const minBpm = options.minBpm ?? DEFAULT_TEMPO_RANGE.minBpm;
  const maxBpm = options.maxBpm ?? DEFAULT_TEMPO_RANGE.maxBpm;
  const minPulseStrength = options.minPulseStrength ?? 0.1;
  const { hopSeconds } = envelope;
  const frames = envelope.values.length;
  if (frames * hopSeconds < MIN_ANALYSIS_SECONDS) return null;

  const detrended = detrend(envelope.values, Math.round(DETREND_SECONDS / hopSeconds));
  if (detrended === null) return null;

  const minLag = Math.max(2, Math.floor(bpmToPeriod(maxBpm) / hopSeconds));
  const maxLag = Math.ceil(bpmToPeriod(minBpm) / hopSeconds);
  if (maxLag >= frames) return null;

  // Autocorrelation proposes, the grid fit disposes. The autocorrelation alone
  // cannot tell a tempo from twice or half of it — every multiple of a period is
  // also a period, as far as it is concerned — so instead of trying to make it,
  // it hands over every periodicity it can see and each one is then fitted as an
  // actual beat grid and scored on how well it explains the track (`gridFit`).
  const proposals = proposeTempos(detrended, minLag, maxLag);
  let best: Candidate | null = null;
  let runnerUp = 0;
  for (const proposal of proposals) {
    // A proposal is quantised to whole envelope frames (10ms, which at 128 BPM is
    // already 2.7 BPM of slop) and carries no phase, so both are refined against
    // the full envelope over ±4% — comfortably wider than the proposal's own
    // error and narrow enough that no half- or double-tempo candidate can sneak
    // into the search and quietly replace the one being tested.
    const lag = refinePeriod(
      detrended,
      Math.max(minLag, proposal * 0.96),
      Math.min(maxLag, proposal * 1.04),
      frames,
    );
    const offsetFraction = fitPhase(detrended, lag);
    const fit = gridFit(detrended, lag, offsetFraction);
    const score = fit.pulseStrength * tempoPrior(periodToBpm(lag * hopSeconds));
    if (best === null || score > best.score) {
      if (best !== null) runnerUp = Math.max(runnerUp, best.score);
      best = { lag, offsetFraction, score, pulseStrength: fit.pulseStrength };
    } else {
      runnerUp = Math.max(runnerUp, score);
    }
  }
  if (best === null || best.pulseStrength < minPulseStrength) return null;

  const period = best.lag * hopSeconds;
  const rawOffset = envelope.firstFrameSeconds + best.offsetFraction * best.lag * hopSeconds;
  const offset = ((rawOffset % period) + period) % period;

  // Indexed rather than accumulated, so `beats[k]` is exactly the instant
  // `BeatGridReader` computes for beat `k` from `offset` and `period`.
  const beats: number[] = [];
  for (let k = 0; offset + k * period <= envelope.duration; k++) beats.push(offset + k * period);

  return {
    bpm: periodToBpm(period),
    period,
    offset,
    beats,
    confidence: gridConfidence(best.pulseStrength, clamp01(1 - runnerUp / best.score)),
    duration: envelope.duration,
  };
}

interface Candidate {
  lag: number;
  offsetFraction: number;
  score: number;
  pulseStrength: number;
}

/** Everything, end to end: decoded audio in, beat grid (or `null`) out. */
export function analyseBeatGrid(
  audio: DecodedAudio,
  options: OfflineBeatOptions = {},
): BeatGrid | null {
  return analyseEnvelope(computeOnsetEnvelope(audio), options);
}

/**
 * Subtract a moving average and half-wave rectify, then scale to a 0..1 peak.
 * Returns `null` for an envelope with no energy at all.
 *
 * Autocorrelation measures the periodicity of a signal *about its mean*; an
 * un-detrended flux envelope is entirely positive, so its mean swamps the beat
 * structure and every lag correlates with every other. Removing a local mean
 * also flattens the difference between a dense chorus and a sparse verse, so
 * both contribute their beats to the tempo estimate on equal terms.
 */
function detrend(values: Float32Array, radius: number): Float32Array | null {
  const n = values.length;
  const out = new Float32Array(n);
  const span = Math.max(1, radius);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const wantLo = Math.max(0, i - span);
    const wantHi = Math.min(n - 1, i + span);
    while (hi < wantHi) sum += values[++hi];
    while (lo < wantLo) sum -= values[lo++];
    const mean = sum / (hi - lo + 1);
    const value = values[i] - mean;
    out[i] = value > 0 ? value : 0;
    if (out[i] > peak) peak = out[i];
  }
  if (peak <= 0) return null;
  for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}

/** How many periodicities to put forward for grid fitting. Four covers a
 *  periodicity, its double, its half and one oddity (a track with strong
 *  eighth-notes also peaks at three-eighths of a bar); more than that is paying
 *  a full refinement pass for candidates that never win. */
const MAX_PROPOSALS = 4;
/** Proposals scoring worse than this share of the best one are not worth
 *  fitting. */
const PROPOSAL_FLOOR = 0.35;

/**
 * Every periodicity in the envelope worth fitting a grid to, as lags in envelope
 * frames, best first.
 *
 * Scoring is a harmonic sum of the autocorrelation — a lag counts for what it
 * scores at itself plus, at declining weight, at its first few multiples, which
 * is what separates a genuine periodicity from a lucky single correlation. No
 * attempt is made here to resolve half- and double-tempo: it can't be done from
 * the autocorrelation (every multiple of a period is also a period by its
 * measure) and pretending otherwise is where the octave errors come from. Both
 * survive as proposals and the grid fit decides between them. The best proposal's
 * own double and half are added explicitly, so the octave question is always put,
 * even on material where the autocorrelation happens not to peak at one of them.
 */
function proposeTempos(envelope: Float32Array, minLag: number, maxLag: number): number[] {
  const frames = envelope.length;
  const acfLags = Math.min(frames - 1, maxLag * 4);
  const acf = new Float32Array(acfLags + 1);
  for (let lag = 0; lag <= acfLags; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < frames; i++) sum += envelope[i] * envelope[i + lag];
    // Normalising by the overlap rather than by the frame count keeps long lags
    // comparable with short ones instead of tapering them toward zero, which
    // would bias every track toward the fastest tempo in range.
    acf[lag] = sum / (frames - lag);
  }
  if (acf[0] <= 0) return [];

  const scores = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let k = 1; k <= 4 && k * lag <= acfLags; k++) score += acf[k * lag] / k;
    scores[lag] = score;
  }

  const peaks: number[] = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (scores[lag] > scores[lag - 1] && scores[lag] >= scores[lag + 1]) peaks.push(lag);
  }
  if (peaks.length === 0) return [];
  peaks.sort((a, b) => scores[b] - scores[a]);

  const chosen: number[] = [];
  const floor = scores[peaks[0]] * PROPOSAL_FLOOR;
  for (const lag of peaks) {
    if (chosen.length >= MAX_PROPOSALS) break;
    if (scores[lag] < floor) break;
    // Peaks are a frame apart at worst; anything within a few percent of one
    // already chosen is the same periodicity seen twice.
    if (chosen.some((other) => Math.abs(lag - other) / other < 0.04)) continue;
    chosen.push(lag);
  }

  for (const octave of [chosen[0] / 2, chosen[0] * 2]) {
    if (octave < minLag || octave > maxLag) continue;
    if (chosen.some((other) => Math.abs(octave - other) / other < 0.04)) continue;
    chosen.push(Math.round(octave));
  }
  return chosen;
}

/** How close to a beat an onset has to be to count as landing on it, as a
 *  fraction of the beat period. ±5% of a beat is 23ms at 128 BPM — around the
 *  point where a listener stops hearing a hit as being "on" the beat. */
const CAPTURE_TOLERANCE = 0.05;
/** A grid fitted to fewer beats than this is not evidence of anything. */
const MIN_FITTED_BEATS = 4;
/** Weight of the second harmonic in the period search. Including it sharpens the
 *  peak (a harmonic of a periodicity is narrower in period than the fundamental)
 *  and, more importantly, keeps the search working on material whose offbeats are
 *  nearly as strong as its beats, where the fundamental component is small. It is
 *  safe here and nowhere else: the search band is already pinned to ±4% of one
 *  proposal, so no half- or double-tempo candidate is in reach to be confused by
 *  it. */
const SECOND_HARMONIC_WEIGHT = 0.5;

/**
 * Pin a proposed period down against the whole envelope at once, in frames.
 *
 * Candidates are scored with a two-harmonic DFT of the envelope at the candidate
 * beat rate — the frequency-domain form of sliding a comb of impulses over the
 * track and asking how much energy it catches. Precision comes from the length of
 * the track: an error of δ in the period displaces the last beat of an N-beat
 * track by N·δ, so the sum decoheres as soon as that reaches a fraction of a beat.
 * That is why this is worth doing offline — a whole track's worth of beats is a
 * far longer lever than the eight seconds the causal tracker has.
 */
function refinePeriod(envelope: Float32Array, lo: number, hi: number, frames: number): number {
  // The score's peak narrows as the track gets longer (its width in period is
  // about p²/frames), so the step has to narrow with it or a long track's peak
  // falls between two candidates and is never seen.
  const coarseStep = Math.max(0.002, (hi * hi) / frames / 4);
  const coarse = scanPeriods(envelope, lo, hi, coarseStep);
  const fineStep = Math.max(0.0005, coarseStep / 20);
  return scanPeriods(envelope, coarse - coarseStep * 1.5, coarse + coarseStep * 1.5, fineStep);
}

/** The best-scoring period in `[lo, hi]`, in envelope frames. */
function scanPeriods(envelope: Float32Array, lo: number, hi: number, step: number): number {
  let bestLag = lo;
  let bestScore = -1;
  for (let lag = lo; lag <= hi; lag += step) {
    const score = combScore(envelope, lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag;
}

function combScore(envelope: Float32Array, lag: number): number {
  let real1 = 0;
  let imaginary1 = 0;
  let real2 = 0;
  let imaginary2 = 0;
  let total = 0;
  for (let i = 0; i < envelope.length; i++) {
    const value = envelope[i];
    if (value <= 0) continue;
    total += value;
    const angle = 2 * Math.PI * ((i / lag) % 1);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    real1 += value * cos;
    imaginary1 -= value * sin;
    // Double angle rather than a second pair of trig calls — this loop runs for
    // every candidate period over every frame of the track.
    real2 += value * (2 * cos * cos - 1);
    imaginary2 -= value * (2 * sin * cos);
  }
  if (total <= 0) return 0;
  const fundamental = Math.hypot(real1, imaginary1);
  const harmonic = Math.hypot(real2, imaginary2);
  return (fundamental + SECOND_HARMONIC_WEIGHT * harmonic) / total;
}

/**
 * Where in the beat the energy sits, as a fraction of `lag`.
 *
 * Folding the envelope onto one beat and taking the fullest bin is what
 * distinguishes the downbeat from the offbeat: on material with hats between the
 * kicks both bins are full, but the kick's is fuller, and a circular *mean* over
 * the whole fold would land halfway between them. So: fold coarsely, take the
 * winning bin, then compute a weighted circular mean of only the energy near it
 * to get a continuous answer without being dragged by the offbeat.
 */
function fitPhase(envelope: Float32Array, lag: number): number {
  const bins = 64;
  const folded = new Float64Array(bins);
  for (let i = 0; i < envelope.length; i++) {
    const value = envelope[i];
    if (value > 0) folded[Math.floor(((i / lag) % 1) * bins) % bins] += value;
  }

  const smoothed = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    smoothed[b] =
      0.25 * folded[(b + bins - 1) % bins] + 0.5 * folded[b] + 0.25 * folded[(b + 1) % bins];
  }
  let peak = 0;
  for (let b = 1; b < bins; b++) if (smoothed[b] > smoothed[peak]) peak = b;

  const centre = (peak + 0.5) / bins;
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i < envelope.length; i++) {
    const value = envelope[i];
    if (value <= 0) continue;
    const fraction = (i / lag) % 1;
    if (circularDistance(fraction, centre) > 0.12) continue;
    const angle = 2 * Math.PI * fraction;
    real += value * Math.cos(angle);
    imaginary += value * Math.sin(angle);
  }
  if (real === 0 && imaginary === 0) return centre;
  const mean = Math.atan2(imaginary, real) / (2 * Math.PI);
  return (mean % 1) + (mean < 0 ? 1 : 0);
}

interface GridFit {
  /** Share of the envelope's energy sitting on a beat, chance-corrected. */
  recall: number;
  /** How evenly that energy is spread over the grid's beats, 0..1. */
  evenness: number;
  /** The two multiplied — what a candidate grid is ranked and trusted on. */
  pulseStrength: number;
}

/**
 * Score a fully specified grid — period *and* phase — on how well it explains the
 * track. This, not the autocorrelation, is what decides the tempo.
 *
 * Two things have to be true of a real beat grid, and each on its own is easy to
 * fool:
 *
 * - **Recall**: the track's onsets land on it. A grid at half the true tempo
 *   fails this, because it walks past every other beat.
 * - **Evenness**: its beats are *all* used, not just half of them. A grid at
 *   twice the true tempo passes recall perfectly — it catches everything the
 *   correct grid catches — and fails this, because every second beat lands on
 *   nothing. Measuring it as a participation ratio over the per-beat energies
 *   avoids having to invent a threshold for "this beat has a hit on it": it is 1
 *   when every beat carries the same energy and 1/2 when half of them carry it
 *   all, which is exactly the double-tempo case.
 *
 * Together they are what makes the half-versus-double question decidable at all,
 * and they degrade gracefully rather than snapping to zero: a bare click track
 * scores near 1, a kick-and-hat pattern lands near a half because half its onsets
 * are offbeats the grid legitimately ignores, and unstructured noise scores 0.
 */
function gridFit(envelope: Float32Array, lag: number, offsetFraction: number): GridFit {
  const tolerance = CAPTURE_TOLERANCE * lag;
  const first = offsetFraction * lag;
  const beatCount = Math.floor((envelope.length - 1 - first - tolerance) / lag) + 1;
  if (beatCount < MIN_FITTED_BEATS) return { recall: 0, evenness: 0, pulseStrength: 0 };

  let total = 0;
  for (let i = 0; i < envelope.length; i++) total += envelope[i];
  if (total <= 0) return { recall: 0, evenness: 0, pulseStrength: 0 };

  let captured = 0;
  let rootSum = 0;
  for (let beat = 0; beat < beatCount; beat++) {
    const centre = first + beat * lag;
    const from = Math.max(0, Math.ceil(centre - tolerance));
    const to = Math.min(envelope.length - 1, Math.floor(centre + tolerance));
    let energy = 0;
    for (let i = from; i <= to; i++) energy += envelope[i];
    captured += energy;
    rootSum += Math.sqrt(energy);
  }

  const chance = 2 * CAPTURE_TOLERANCE;
  const recall = clamp01((captured / total - chance) / (1 - chance));
  const evenness = captured > 0 ? (rootSum * rootSum) / (beatCount * captured) : 0;
  return { recall, evenness, pulseStrength: recall * evenness };
}

/** Distance between two 0..1 phases the short way round, so 0.98 and 0.02 are
 *  0.04 apart rather than 0.96. */
function circularDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 1;
  return Math.min(raw, 1 - raw);
}

/**
 * How much the grid deserves to be believed.
 *
 * `pulseStrength` — how well the winning grid explains the track — gates it: a
 * grid that does not explain the music cannot be rescued by having beaten weak
 * rivals, so it multiplies rather than adds. `salience` — how far the winning
 * *interpretation* beat the runner-up — then modulates within the top 40%. That
 * ordering matters for the honest cases: a bare click track at 70 BPM explains
 * itself perfectly but has no way to rule out being read at 140, and comes back
 * around 0.75 rather than 1, which is the right answer.
 *
 * The two divisors are where "good enough" sits for each and are reasoned, not
 * measured — no real music has been through this. See ADR-0010; expect dense
 * material (sustained instruments, vocals, a busy mix) to depress
 * `pulseStrength` and with it this number, whether or not the grid is right.
 */
function gridConfidence(pulseStrength: number, salience: number): number {
  return clamp01(pulseStrength / 0.5) * (0.6 + 0.4 * clamp01(salience / 0.5));
}

/**
 * Answers "what is the beat doing at position X" from a precomputed grid.
 *
 * Read once per frame with the playback position (`FileSource.position()`). It
 * keeps just enough state to make `onBeat` an edge rather than a level — which
 * beat the last call was inside — and re-anchors silently when the position
 * jumps, so scrubbing the transport bar does not fire a burst of phantom beats.
 */
export class BeatGridReader implements BeatReader {
  private lastIndex: number | null = null;
  private lastPosition: number | null = null;
  private readonly seekThreshold: number;

  /**
   * @param seekThresholdSeconds a jump larger than this is treated as a seek
   * rather than a slow frame. The default is generous enough that a stuttering
   * tab does not read as a seek, and far shorter than any deliberate scrub.
   */
  constructor(
    private readonly grid: BeatGrid,
    seekThresholdSeconds = 0.25,
  ) {
    this.seekThreshold = seekThresholdSeconds;
  }

  read(positionSeconds: number): BeatReading {
    const elapsed = (positionSeconds - this.grid.offset) / this.grid.period;
    const index = Math.floor(elapsed);
    const advance = this.lastPosition === null ? Infinity : positionSeconds - this.lastPosition;
    const seeked = advance < 0 || advance > this.seekThreshold;
    const onBeat = !seeked && this.lastIndex !== null && index > this.lastIndex;

    this.lastIndex = index;
    this.lastPosition = positionSeconds;
    return {
      bpm: this.grid.bpm,
      beatPhase: elapsed - index,
      onBeat,
      // Whole-file, not per-moment: the grid was fitted to the entire track, so
      // this number says how well the track as a whole supports it, and is the
      // same at every position. A tracker that reported a per-moment confidence
      // here would be inventing information the offline fit does not have.
      confidence: this.grid.confidence,
      beatIndex: index,
    };
  }

  reset(): void {
    this.lastIndex = null;
    this.lastPosition = null;
  }
}
