/**
 * Offline song *structure* detection — where a track's sections start, and which
 * one is the drop.
 *
 * Phase 8's B2 (Reactive Runner / Tower Defense) wants "wave structure derived
 * from song structure; the drop is a boss wave". That needs something the beat
 * grid cannot give it: the beat grid says where every beat is, uniformly, from
 * the first bar to the last, and is by construction blind to the fact that bar 33
 * is where the chorus started. This module answers the other question — given the
 * whole decoded file, where does the music *change character*, and which stretch
 * between two such changes is the loudest and bassiest.
 *
 * Like `beat-offline.ts` this is a whole-file, non-causal pass: it needs to see
 * the end of the track to know that the middle was quiet, which is exactly why
 * B2 is file-only.
 *
 * Five stages:
 *
 * 1. **A beat-synchronous timbre feature.** Eight octave-spaced band energies in
 *    dB, averaged over each beat of the track's `BeatGrid`. One feature vector
 *    per beat rather than per 10ms frame: structure changes happen on musical
 *    boundaries, so sampling on them is both cheaper and better aligned to what
 *    is being looked for. When no beat grid can be found the same feature is
 *    sampled on a fixed half-second grid instead, so an ambient or beatless track
 *    still gets an answer.
 * 2. **A self-similarity matrix**, near the diagonal only. Similarity is an RMS
 *    dB distance between two frames' band spectra on an absolute scale, with no
 *    per-track normalisation — see `similarityOf` for why the two standard
 *    alternatives were tried and abandoned.
 * 3. **A novelty curve** (Foote, 2000): a Gaussian-tapered checkerboard kernel
 *    slid along that diagonal. Inside one homogeneous section every similarity is
 *    alike and the kernel's positive and negative lobes cancel to zero; straddling
 *    a boundary, the two on-diagonal blocks are self-similar and the two
 *    off-diagonal blocks are not, and the kernel returns a large positive number.
 *    Peak-picking that curve, with a minimum spacing and a robust significance
 *    threshold, gives the candidate boundaries.
 * 4. **A veto.** Novelty is a local measure and peaks just as happily on a drum
 *    fill as on a section change, so each candidate must also show that the music
 *    either side of it is genuinely different over a section's worth of time.
 * 5. **Characterisation.** Each section between surviving boundaries gets a mean
 *    bass-weighted loudness; the loudest is the drop, unless nothing stands out
 *    far enough above the track's own median section to be called one.
 *
 * See ADR-0013 for why each of those was chosen and — importantly — the several
 * kinds of real music this is expected to be wrong about.
 */
import { clamp01 } from './beat';
import {
  analyseBeatGrid,
  downmixAndDecimate,
  type BeatGrid,
  type DecodedAudio,
} from './beat-offline';
import { Fft, hannWindow } from './fft';

/** One stretch of a track between two detected changes of character. */
export interface Section {
  /** Position in the track, 0-based. Sections are contiguous and in order. */
  index: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  /**
   * 0..1 *within this track*: 1 is the most intense section it has, 0 the least.
   * Relative on purpose — "how big is this bit compared to the rest of this song"
   * is what a difficulty curve wants, and it is the only version of the question
   * that survives mastering, since one track's quiet verse can be louder in
   * absolute terms than another's chorus.
   */
  intensity: number;
  /** Mean bass-weighted loudness over the section, in dB relative to full scale.
   *  The absolute number `intensity` is derived from, for anyone who wants it. */
  loudnessDb: number;
  /** 0..1 strength of the novelty peak that opened this section. 0 for the first
   *  section, whose start is the start of the file rather than a detected change. */
  boundaryStrength: number;
  /** True for exactly one section, or none — see `SongStructure.dropIndex`. */
  isDrop: boolean;
  /** Index into `BeatGrid.beats` of the beat this section starts on, or `null`
   *  when the analysis was not beat-synchronous. Boundaries land exactly on beats
   *  when a grid was used, so a game can schedule a wave on this beat number
   *  without re-deriving anything. */
  startBeat: number | null;
  /** Whole beats the section spans; `null` when not beat-synchronous. */
  beatCount: number | null;
}

/** The novelty curve the boundaries were picked from. Exposed for a scope
 *  readout and for tests — nothing in a game needs it. */
export interface NoveltyCurve {
  /** Checkerboard-kernel response, normalised so 1 is a perfect boundary — two
   *  internally identical sections with nothing in common — and 0 is no change at
   *  all. Values can go slightly negative where the music is *more* alike across
   *  a point than either side is with itself. */
  values: Float32Array;
  /** When each value was measured, in seconds. Same length as `values`. Double
   *  precision, so a boundary read off it is bit-for-bit the beat instant the
   *  grid put there rather than a rounded copy of it. */
  times: Float64Array;
}

/** A whole track's structure, computed once before playback. */
export interface SongStructure {
  /**
   * Contiguous, in order, always covering `[0, duration]`. A track with no
   * detectable structure comes back as a *single* section spanning the whole file
   * rather than as nothing, so this is empty only for a zero-length buffer.
   */
  sections: Section[];
  /**
   * The climactic section — the loudest, bassiest one — or `null` when no
   * section leads the track's median section by enough to be worth calling a
   * drop (including whenever there is only one section). A game wanting a boss
   * wave regardless should fall back deliberately rather than have one invented
   * for it here.
   */
  dropIndex: number | null;
  duration: number;
  /** Whether features were sampled once per beat (true) or on a fixed time grid
   *  because no beat grid could be found (false). */
  beatSynchronous: boolean;
  /** The grid the sampling used, so a caller that needs both — B2 needs both —
   *  does not analyse the file twice. `null` when none was found. */
  grid: BeatGrid | null;
  /** 0..1, how strongly the track's own features support these boundaries. 0
   *  when none were found. Reasoned, not measured — see ADR-0013. */
  confidence: number;
  novelty: NoveltyCurve;
}

export interface SectionOptions {
  /**
   * A beat grid to sample on. Pass one you already have (B2 needs a grid anyway)
   * to avoid a second full analysis pass; pass `null` explicitly to force the
   * fixed-time fallback; omit the property entirely and one is computed.
   */
  grid?: BeatGrid | null;
  /** Shortest section that may be reported, and so the closest two boundaries
   *  may be. */
  minSectionSeconds?: number;
  /** Half-width of the checkerboard kernel in seconds — the timescale of change
   *  being looked for. */
  kernelSeconds?: number;
  /** How many robust standard deviations above the novelty curve's own median a
   *  peak must stand to count as a boundary. */
  noveltySigma?: number;
  /** Absolute floor on a boundary's novelty, 0..1, regardless of significance. */
  minNovelty?: number;
  /** RMS dB change the typical spectrum must show across a candidate boundary
   *  before it is believed. Below it, the boundary is dropped as a passing event. */
  minBoundaryChangeDb?: number;
}

/** Analysis rate the file is decimated to, matching `beat-offline.ts`: above the
 *  7.7kHz top band by enough that its crude box-filter decimation cannot alias
 *  anything into a band we measure. */
const ANALYSIS_RATE_HZ = 22050;
/**
 * STFT window, ~93ms at the analysis rate. Much longer than the beat tracker's
 * 23ms, and for the opposite reason: nothing here needs to place an event in
 * time — the sampling grid does that — while the lowest band edge at 30Hz needs
 * frequency resolution the beat tracker's window cannot give. 2048 points is
 * ~10.8Hz per bin, so the bottom band is several bins wide rather than one.
 */
const WINDOW = 2048;
/** 50% overlap. More would cost transforms for detail that is averaged away
 *  within the beat anyway; less would let a short loud event fall between two
 *  windows' tapers. */
const HOP = WINDOW / 2;
/**
 * Octave-spaced band edges, 30Hz to 7.7kHz. Octave spacing rather than
 * `Analyser.bands()`'s four linear-ish bands because this feature has to
 * *discriminate*, not just describe: a verse and a chorus can share a level and
 * differ entirely in where their energy sits, and four bands is too coarse to see
 * that. Eight is still small enough that the similarity matrix is cheap and that
 * no single band can be noise-dominated. The top edge matches `onset.ts` and
 * `beat-offline.ts` — above it is mostly hiss.
 */
const BAND_EDGES_HZ = [30, 60, 120, 240, 480, 960, 1920, 3840, 7680];
const BANDS = BAND_EDGES_HZ.length - 1;
/** The bottom three bands, 30–240Hz: kick and bass. */
const BASS_BANDS = 3;
/** How much of the intensity measure is bass rather than broadband. A drop is
 *  characterised as much by what arrives underneath as by how loud it is, but
 *  loudness is still the larger half. */
const BASS_WEIGHT = 0.4;
/** Guards log(0) for silence, and sets the dB floor at -120. */
const POWER_FLOOR = 1e-12;
/**
 * Turns raw FFT bin magnitudes into amplitudes on the signal's own scale, so a
 * band's summed power is comparable with a sample value and `loudnessDb` is
 * genuinely dB relative to full scale — a full-scale sine reads 0. A Hann window
 * of `WINDOW` points sums to `WINDOW / 2`, and only the positive half of the
 * spectrum is summed, hence the factor of two.
 */
const POWER_SCALE = (2 / (WINDOW / 2)) ** 2;

/**
 * The band-by-band change, in dB, that counts as "completely different music".
 * Two frames whose spectra differ by this much in every band score zero
 * similarity; a little over half again as much saturates at -1. Nine decibels is
 * a large change for a single band to make and hold — roughly a doubling of
 * perceived loudness in that part of the spectrum — but well short of the twenty
 * or more between a breakdown and a drop, which is what leaves room for a
 * verse-to-chorus step and a drop to both register on the same track.
 */
const REFERENCE_CHANGE_DB = 9;
/**
 * How far below the track's loudest moment a band stops counting as audible.
 * Bands with essentially nothing in them still produce a dB number, and it swings
 * wildly on nothing at all — a track with no content above 4kHz would otherwise
 * have its structure decided by the dither in its top two bands. Flooring them
 * makes an inaudible band a constant, which contributes exactly zero to every
 * distance.
 */
const DYNAMIC_FLOOR_DB = 60;
/** Sampling interval when there is no beat grid. Two frames a second is fine for
 *  structure — the shortest thing being looked for is many seconds long — and
 *  keeps the matrix small on a long ambient track. */
const FALLBACK_HOP_SECONDS = 0.5;
/**
 * Half-width of the checkerboard kernel, in seconds. The kernel compares roughly
 * the preceding six seconds against the following six: long enough to average
 * over a bar or two, so a single drum fill or one loud stab does not read as a
 * section change, and short enough that the boundary is still placed within a
 * beat or so of where it belongs. It is defined in seconds rather than in beats
 * so the timescale does not silently double between a 60 BPM track and a 120 BPM
 * one.
 */
const KERNEL_SECONDS = 6;
/** A kernel narrower than this averages too few frames to mean anything; wider
 *  than this is paying for a smoothing the sampling grid already did. */
const MIN_KERNEL_FRAMES = 4;
const MAX_KERNEL_FRAMES = 48;
/** Sections shorter than this are not part of a song's large-scale form — they
 *  are fills, breaks and turnarounds, and reporting them as structure would give
 *  a game a wave every few seconds. */
const MIN_SECTION_SECONDS = 8;
/**
 * Significance a novelty peak needs, in robust standard deviations above the
 * curve's own median. The curve is heavily autocorrelated (successive positions
 * share most of their kernel), so an unstructured track's curve has few
 * effectively independent samples and its largest excursion is only around three
 * sigma; five leaves margin above that while a real boundary between two
 * genuinely different sections scores far higher.
 */
const NOVELTY_SIGMA = 5;
/** And an absolute floor, because a *very* flat curve has a tiny sigma and a
 *  meaningless excursion can clear five of them. 0.05 is a twentieth of the
 *  response of a perfect boundary. */
const MIN_NOVELTY = 0.05;
/**
 * How much the typical spectrum must actually change across a boundary, as an RMS
 * dB difference over the eight bands, before it is believed. A low bar on
 * purpose: the check exists to throw out fills and one-bar breakdowns, where the
 * material either side is *the same material* and the residual difference is only
 * the couple of dB that separates any two windows of the same music, not to
 * adjudicate between two genuinely different but similar-sounding sections.
 * Measured on the synthetic cases: a one-second fill leaves 1.3dB behind it, and
 * the least emphatic real boundary among them changes the spectrum by 3.2dB.
 */
const MIN_BOUNDARY_CHANGE_DB = 2.5;
/** Feature smoothing, in frames either side. One beat of averaging takes the
 *  edge off a feature that would otherwise swing with whether a given beat
 *  happened to have a cymbal on it. */
const SMOOTH_RADIUS = 1;
/** Cap on feature frames, so a DJ-set-length file cannot turn the O(N·L²)
 *  novelty pass into something a page freeze is noticed for. Beyond it, beats are
 *  grouped. */
const MAX_FEATURE_FRAMES = 3000;
/** How far the loudest section must lead the track's median section, in dB,
 *  before it is called the drop. Low bar deliberately — it exists to catch tracks
 *  with no dynamic shape at all, not to adjudicate between two big choruses. */
const DROP_MIN_LEAD_DB = 2;
/** Novelty at which the boundaries are believed completely. Reasoned, not
 *  measured; see ADR-0013, and expect real music to sit well below a synthetic
 *  segment boundary. */
const CONFIDENT_NOVELTY = 0.4;

/** Everything, end to end: decoded audio in, song structure out. Never returns
 *  `null` and never throws on degenerate input — a track with nothing to say
 *  about it comes back as one section with `dropIndex: null`. */
export function analyseSongStructure(
  audio: DecodedAudio,
  options: SectionOptions = {},
): SongStructure {
  const duration = audio.length / audio.sampleRate;
  const grid = 'grid' in options ? (options.grid ?? null) : analyseBeatGrid(audio);
  const minSection = options.minSectionSeconds ?? MIN_SECTION_SECONDS;

  const frames = computeFeatureFrames(audio, grid, duration);
  const empty: NoveltyCurve = { values: new Float32Array(0), times: new Float64Array(0) };
  if (frames === null) return degenerate(audio, duration, grid, empty);

  const kernelHalf = kernelHalfWidth(frames.frameSeconds, options.kernelSeconds ?? KERNEL_SECONDS);
  // Two half-kernels plus a frame to put between them is the least a novelty
  // curve can be computed from at all. A track that short has no structure worth
  // reporting anyway, so it becomes one section rather than a special case.
  if (frames.count < 2 * kernelHalf + 3 || duration < 2 * minSection) {
    return finish([], duration, grid, frames, empty, []);
  }

  const similarity = bandedSimilarity(frames.bandsDb, frames.count, 2 * kernelHalf);
  const novelty = noveltyCurve(similarity, frames, kernelHalf);
  const peaks = pickPeaks(novelty, kernelHalf, minSection, duration, options).filter((peak) =>
    sidesDiffer(frames, peak.frame, minSection, options),
  );
  return finish(
    peaks.map((peak) => peak.time),
    duration,
    grid,
    frames,
    novelty,
    peaks.map((peak) => peak.strength),
  );
}

/**
 * A file too short for even two STFT windows — well under a second — still gets
 * one section, because a caller reaching for `sections[0]` should not have to
 * special-case a track that is merely tiny. Its `loudnessDb` is plain broadband
 * RMS rather than the bass-weighted measure every other section carries; there is
 * no spectrum to weight, and `intensity` is 1 either way with nothing to compare
 * against.
 */
function degenerate(
  audio: DecodedAudio,
  duration: number,
  grid: BeatGrid | null,
  novelty: NoveltyCurve,
): SongStructure {
  const base: SongStructure = {
    sections: [],
    dropIndex: null,
    duration,
    beatSynchronous: false,
    grid,
    confidence: 0,
    novelty,
  };
  if (duration <= 0 || audio.length === 0) return base;

  const samples = audio.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  base.sections = [
    {
      index: 0,
      startSeconds: 0,
      endSeconds: duration,
      durationSeconds: duration,
      intensity: 1,
      loudnessDb: 20 * Math.log10(rms + Math.sqrt(POWER_FLOOR)),
      boundaryStrength: 0,
      isDrop: false,
      startBeat: null,
      beatCount: null,
    },
  ];
  return base;
}

/** The features the structure was found in, sampled once per beat or once per
 *  `FALLBACK_HOP_SECONDS`. */
interface FeatureFrames {
  count: number;
  /** Start of each frame's span. `times[k]` is where section boundary `k` would
   *  be placed — on a beat instant, when the sampling was beat-synchronous. */
  times: Float64Array;
  /** Typical span of one frame, for sizing the kernel. */
  frameSeconds: number;
  /** `count` × `BANDS` band energies in dB, row-major, lightly smoothed. */
  bandsDb: Float32Array;
  /** Bass-weighted broadband loudness per frame, dB. Kept separately from
   *  `bandsDb` because it answers the other question — *how big* a section is,
   *  rather than whether it is a different section — and only it is exempt from
   *  the dynamic floor, which would otherwise flatten a fade-out. */
  intensityDb: Float64Array;
  beatSynchronous: boolean;
}

/**
 * Band energies in dB, averaged onto the sampling grid.
 *
 * Returns `null` when the file is too short to produce even a couple of STFT
 * frames, which is the degenerate case the whole module has to survive rather
 * than a failure.
 */
function computeFeatureFrames(
  audio: DecodedAudio,
  grid: BeatGrid | null,
  duration: number,
): FeatureFrames | null {
  const decimation = Math.max(1, Math.round(audio.sampleRate / ANALYSIS_RATE_HZ));
  const rate = audio.sampleRate / decimation;
  const mono = downmixAndDecimate(audio, decimation);
  const stftCount = mono.length >= WINDOW ? Math.floor((mono.length - WINDOW) / HOP) + 1 : 0;
  if (stftCount < 2) return null;

  const fft = new Fft(WINDOW);
  const window = hannWindow(WINDOW);
  const bins = WINDOW / 2 + 1;
  const edges = BAND_EDGES_HZ.map((hz) =>
    Math.min(bins - 1, Math.max(1, Math.round((hz * WINDOW) / rate))),
  );
  const re = new Float32Array(WINDOW);
  const im = new Float32Array(WINDOW);
  const magnitude = new Float32Array(bins);

  // Summed power per band per STFT frame, plus the centre time of each frame.
  const power = new Float64Array(stftCount * BANDS);
  const stftTimes = new Float64Array(stftCount);
  for (let frame = 0; frame < stftCount; frame++) {
    const start = frame * HOP;
    for (let i = 0; i < WINDOW; i++) re[i] = mono[start + i] * window[i];
    im.fill(0);
    fft.magnitudes(re, im, magnitude);
    // Attributed to the window's centre, the same convention `beat-offline.ts`
    // uses, so a frame's energy is assigned to the moment it was loudest around.
    stftTimes[frame] = (start + WINDOW / 2) / rate;
    for (let band = 0; band < BANDS; band++) {
      const from = edges[band];
      const to = Math.max(from, edges[band + 1] - 1);
      let sum = 0;
      for (let i = from; i <= to; i++) sum += magnitude[i] * magnitude[i];
      // Summed, not averaged over the band's bins: a band's *total* power is
      // what makes the eight of them add up to the track's loudness, whereas a
      // per-bin mean would make a tone read quieter simply for landing in a wide
      // band, and would put the octave-spaced bands on eight different scales.
      power[frame * BANDS + band] = sum * POWER_SCALE;
    }
  }

  const spans = samplingGrid(grid, duration);
  const count = spans.length - 1;
  if (count < 1) return null;

  const bandsDb = new Float32Array(count * BANDS);
  const intensityDb = new Float64Array(count);
  const times = new Float64Array(count);
  const accumulator = new Float64Array(BANDS);
  let cursor = 0;
  for (let k = 0; k < count; k++) {
    times[k] = spans[k];
    accumulator.fill(0);
    while (cursor < stftCount && stftTimes[cursor] < spans[k]) cursor++;
    let used = 0;
    for (let f = cursor; f < stftCount && stftTimes[f] < spans[k + 1]; f++) {
      for (let band = 0; band < BANDS; band++) accumulator[band] += power[f * BANDS + band];
      used++;
    }
    if (used === 0) {
      // A span shorter than the STFT hop, or past the last window. Borrow the
      // nearest frame rather than reporting silence that is not there.
      const nearest = Math.min(stftCount - 1, Math.max(0, cursor));
      for (let band = 0; band < BANDS; band++) accumulator[band] = power[nearest * BANDS + band];
      used = 1;
    }

    let total = 0;
    let bass = 0;
    for (let band = 0; band < BANDS; band++) {
      const mean = accumulator[band] / used;
      bandsDb[k * BANDS + band] = toDb(mean);
      total += mean;
      if (band < BASS_BANDS) bass += mean;
    }
    intensityDb[k] = (1 - BASS_WEIGHT) * toDb(total) + BASS_WEIGHT * toDb(bass);
  }

  applyDynamicFloor(bandsDb, count);
  smooth(bandsDb, count, BANDS, SMOOTH_RADIUS);
  return {
    count,
    times,
    frameSeconds: count > 0 ? (spans[count] - spans[0]) / count : duration,
    bandsDb,
    intensityDb,
    beatSynchronous: grid !== null && grid.beats.length >= 2,
  };
}

/**
 * Frame boundaries to average band energies between: the beat instants
 * themselves when there is a grid, a fixed half-second grid when there is not.
 *
 * Beat-synchronous sampling is used whenever `analyseBeatGrid` returns *any*
 * grid, without consulting its confidence, and that is deliberate. Structure
 * analysis is far less sensitive to the tempo being exactly right than a rhythm
 * game is: a grid locked at half or double the true tempo still slices the track
 * on musical time, which is all this needs, and even a grid that is somewhat
 * wrong is a better sampling clock than an arbitrary half-second ruler. The
 * fallback exists for tracks with no findable pulse at all — ambient, spoken
 * word, drone — which are also, honestly, the tracks this module is least likely
 * to say anything useful about.
 */
function samplingGrid(grid: BeatGrid | null, duration: number): Float64Array {
  if (grid !== null && grid.beats.length >= 2) {
    // Group beats when a very long file would otherwise blow the frame budget.
    const stride = Math.max(1, Math.ceil((grid.beats.length - 1) / MAX_FEATURE_FRAMES));
    const spans: number[] = [];
    for (let i = 0; i < grid.beats.length; i += stride) spans.push(grid.beats[i]);
    if (spans[spans.length - 1] < duration) spans.push(duration);
    if (spans.length >= 2) return Float64Array.from(spans);
  }
  const hop = FALLBACK_HOP_SECONDS;
  const count = Math.max(1, Math.min(MAX_FEATURE_FRAMES, Math.floor(duration / hop)));
  const step = duration / count;
  const spans = new Float64Array(count + 1);
  for (let i = 0; i <= count; i++) spans[i] = i * step;
  return spans;
}

function toDb(power: number): number {
  return 10 * Math.log10(power + POWER_FLOOR);
}

/** Clamp every band of every frame to within `DYNAMIC_FLOOR_DB` of the loudest
 *  band reading anywhere in the track. */
function applyDynamicFloor(bandsDb: Float32Array, count: number): void {
  let peak = -Infinity;
  for (let i = 0; i < count * BANDS; i++) if (bandsDb[i] > peak) peak = bandsDb[i];
  if (!Number.isFinite(peak)) return;
  const floor = peak - DYNAMIC_FLOOR_DB;
  for (let i = 0; i < count * BANDS; i++) if (bandsDb[i] < floor) bandsDb[i] = floor;
}

/** In-place moving average along the frame axis of a row-major `rows × cols`
 *  matrix. */
function smooth(values: Float32Array, rows: number, cols: number, radius: number): void {
  if (radius < 1 || rows < 3) return;
  const source = values.slice();
  for (let r = 0; r < rows; r++) {
    const from = Math.max(0, r - radius);
    const to = Math.min(rows - 1, r + radius);
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let i = from; i <= to; i++) sum += source[i * cols + c];
      values[r * cols + c] = sum / (to - from + 1);
    }
  }
}

/**
 * Similarity between two frames' band spectra: 1 identical, 0 as different as
 * `REFERENCE_CHANGE_DB` in every band, clamped at -1.
 *
 * The measure is a root-mean-square dB distance, and every part of that sentence
 * is a decision.
 *
 * **dB, on an absolute scale, with no per-track normalisation.** Two more
 * literature-standard alternatives were tried first and both misbehave on this
 * feature. *Cosine similarity between standardised vectors* discards vector
 * length, and standardisation puts the frames of a homogeneous stretch near the
 * origin — normalising those to unit length turns tiny numerical differences into
 * unit vectors pointing in arbitrary directions, so a track with nothing
 * happening in it comes back looking maximally eventful. *Euclidean distance
 * between standardised vectors* fixes that but inherits a worse problem from the
 * standardisation itself: a track containing one enormous drop has its per-band
 * scale set almost entirely by that drop, which shrinks every other change in the
 * track to a rounding error (measured, on a synthetic four-part track: a real
 * boundary scoring 0.045 while the drop scored 1.0). Decibels are already a
 * perceptually sensible common scale across bands and across tracks, so no
 * normalisation is needed and none of that arises.
 *
 * **Clamped below at -1.** Without it the drop dominates everything downstream —
 * the peak-picking statistics, the confidence — for no gain, since a 40 dB change
 * is not twice as much a section boundary as a 20 dB one. Saturation is what
 * leaves room for the quieter boundaries in the same track to be seen.
 */
function similarityOf(bandsDb: Float32Array, a: number, b: number): number {
  let sum = 0;
  for (let band = 0; band < BANDS; band++) {
    const d = bandsDb[a * BANDS + band] - bandsDb[b * BANDS + band];
    sum += d * d;
  }
  return Math.max(-1, 1 - sum / (BANDS * REFERENCE_CHANGE_DB * REFERENCE_CHANGE_DB));
}

/**
 * The self-similarity matrix, but only the diagonal band the kernel can reach.
 *
 * The full N×N matrix is the textbook picture and is genuinely useful for
 * *repetition* detection — spotting that bar 65 sounds like bar 1 — but novelty
 * only ever reads within `halfBand` of the diagonal, and a ten-minute track's
 * full matrix is millions of entries to fill so that thousandths of them can be
 * read. Repetition detection is not built here; see ADR-0013.
 *
 * Stored as `[i][d]` for `d = j - i` in `0..halfBand`, symmetric by definition.
 */
function bandedSimilarity(bandsDb: Float32Array, count: number, halfBand: number): Float32Array {
  const stride = halfBand + 1;
  const out = new Float32Array(count * stride);
  for (let i = 0; i < count; i++) {
    for (let d = 0; d <= halfBand && i + d < count; d++) {
      out[i * stride + d] = similarityOf(bandsDb, i, i + d);
    }
  }
  return out;
}

function kernelHalfWidth(frameSeconds: number, kernelSeconds: number): number {
  const frames = Math.round(kernelSeconds / Math.max(1e-6, frameSeconds));
  return Math.max(MIN_KERNEL_FRAMES, Math.min(MAX_KERNEL_FRAMES, frames));
}

/**
 * Slide a Gaussian-tapered checkerboard kernel along the diagonal.
 *
 * The kernel is `2L × 2L` with no centre row or column, so it straddles the gap
 * *between* two frames rather than sitting on one: `novelty[i]` asks how
 * different the L frames ending at `i - 1` are from the L frames starting at `i`,
 * which is why a peak at `i` places a boundary exactly at `times[i]`.
 *
 * Its two on-diagonal quadrants are positive (each side should look like itself)
 * and its two off-diagonal quadrants negative (the sides should not look like
 * each other), and it sums to zero — so a homogeneous stretch, where every
 * similarity in reach is much the same, returns exactly nothing, with no
 * detrending step needed to make it so. The Gaussian taper (σ = L/2) weights the
 * frames nearest the split most, which sharpens the peak and stops the response
 * being a wide plateau L frames long.
 *
 * Dividing by the kernel's total absolute weight puts the result on a fixed
 * scale: 1 is the unreachable ideal of two internally identical, mutually
 * opposite sections, and everything real is a fraction of it.
 */
function noveltyCurve(
  similarity: Float32Array,
  frames: FeatureFrames,
  half: number,
): NoveltyCurve {
  const stride = 2 * half + 1;
  const size = 2 * half;
  const kernel = new Float64Array(size * size);
  const sigma = half / 2;
  let weight = 0;
  for (let u = 0; u < size; u++) {
    // +0.5 so the taper is measured from the split between the quadrants rather
    // than from a cell centre, keeping the kernel symmetric about it.
    const du = u - half + 0.5;
    for (let v = 0; v < size; v++) {
      const dv = v - half + 0.5;
      const sign = du * dv > 0 ? 1 : -1;
      const value = sign * Math.exp(-(du * du + dv * dv) / (2 * sigma * sigma));
      kernel[u * size + v] = value;
      weight += Math.abs(value);
    }
  }

  const count = frames.count;
  const first = half;
  const last = count - half;
  const length = Math.max(0, last - first);
  const values = new Float32Array(length);
  const times = new Float64Array(length);
  for (let i = first; i < last; i++) {
    let sum = 0;
    for (let u = 0; u < size; u++) {
      const a = i + u - half;
      for (let v = 0; v < size; v++) {
        const b = i + v - half;
        const lo = a < b ? a : b;
        sum += kernel[u * size + v] * similarity[lo * stride + Math.abs(b - a)];
      }
    }
    values[i - first] = sum / weight;
    times[i - first] = frames.times[i];
  }
  return { values, times };
}

interface Peak {
  time: number;
  /** Which feature frame the boundary falls on. */
  frame: number;
  /** Novelty at the peak, 0..1. */
  strength: number;
}

/**
 * Boundaries, strongest first by selection but returned in time order.
 *
 * Significance is measured against the curve's own median and median absolute
 * deviation rather than its mean and standard deviation, because the peaks being
 * looked for are themselves large enough to inflate a standard deviation and so
 * raise the bar that is meant to catch them — a track with four clean boundaries
 * would end up harder to find boundaries in than a track with one.
 *
 * Selection is greedy and largest-first with a minimum spacing, which is both the
 * simplest way to enforce "no sections shorter than N seconds" and the right one:
 * where two candidate peaks are too close together, the stronger is the one more
 * likely to be the real change and the weaker is usually its own shoulder.
 */
function pickPeaks(
  novelty: NoveltyCurve,
  kernelHalf: number,
  minSection: number,
  duration: number,
  options: SectionOptions,
): Peak[] {
  const { values, times } = novelty;
  if (values.length === 0) return [];
  const sigmaThreshold = options.noveltySigma ?? NOVELTY_SIGMA;
  const floor = options.minNovelty ?? MIN_NOVELTY;

  const median = medianOf(values);
  const deviations = Float32Array.from(values, (value) => Math.abs(value - median));
  // 1.4826 rescales a median absolute deviation into the standard deviation of
  // the Gaussian it would have come from, so the threshold can be stated in the
  // sigmas everyone means by the word.
  const spread = Math.max(1e-9, 1.4826 * medianOf(deviations));

  const candidates: Peak[] = [];
  for (let i = 1; i < values.length - 1; i++) {
    if (values[i] < values[i - 1] || values[i] < values[i + 1]) continue;
    if (values[i] < floor) continue;
    if ((values[i] - median) / spread < sigmaThreshold) continue;
    // A boundary in the first or last section-length of the track would carve off
    // a section shorter than the minimum, and the track's own start and end are
    // already boundaries.
    if (times[i] < minSection || times[i] > duration - minSection) continue;
    // `novelty[0]` was measured at feature frame `kernelHalf` — the curve cannot
    // start before the kernel fits — so the frame a peak sits on is offset by it.
    candidates.push({ time: times[i], frame: i + kernelHalf, strength: clamp01(values[i]) });
  }

  candidates.sort((a, b) => b.strength - a.strength);
  const chosen: Peak[] = [];
  for (const candidate of candidates) {
    if (chosen.some((other) => Math.abs(other.time - candidate.time) < minSection)) continue;
    chosen.push(candidate);
  }
  chosen.sort((a, b) => a.time - b.time);
  return chosen;
}

/**
 * Does the music either side of this boundary actually stay different?
 *
 * The novelty curve is a *local* measure: it peaks wherever the next few seconds
 * are unlike the last few, which a single loud drum fill, a one-bar breakdown or
 * a dropout satisfies perfectly well without any section having begun. Those are
 * the false positives this module would otherwise be full of — a one-second fill
 * in the middle of an otherwise unchanging track was enough to produce a
 * confident boundary before this check existed.
 *
 * So each surviving peak is asked to justify itself over the timescale a section
 * is claimed to last: the *typical* spectrum over the `minSection` seconds before
 * it must actually differ from the typical spectrum over the `minSection` seconds
 * after it. A fill fails because the material either side of it is the same
 * material; a real section change passes because it is not. This is the one place
 * the module looks beyond the kernel's horizon, and it is deliberately a veto
 * rather than a score — it can only remove boundaries the novelty curve proposed,
 * never add one.
 */
function sidesDiffer(
  frames: FeatureFrames,
  frame: number,
  minSection: number,
  options: SectionOptions,
): boolean {
  const span = Math.max(2, Math.round(minSection / Math.max(1e-6, frames.frameSeconds)));
  const before = medianSpectrum(frames, Math.max(0, frame - span), frame);
  const after = medianSpectrum(frames, frame, Math.min(frames.count, frame + span));
  let sum = 0;
  for (let band = 0; band < BANDS; band++) {
    const d = before[band] - after[band];
    sum += d * d;
  }
  const changeDb = Math.sqrt(sum / BANDS);
  return changeDb >= (options.minBoundaryChangeDb ?? MIN_BOUNDARY_CHANGE_DB);
}

/** The typical spectrum over a window of frames, band by band. A median rather
 *  than a mean because the whole point of the check is to be unmoved by a brief
 *  extreme event: a one-second fill is two frames out of sixteen, which cannot
 *  shift a median but can pull a mean several dB on its own. */
function medianSpectrum(frames: FeatureFrames, from: number, to: number): Float64Array {
  const median = new Float64Array(BANDS);
  if (to <= from) return median;
  const column = new Float32Array(to - from);
  for (let band = 0; band < BANDS; band++) {
    for (let k = from; k < to; k++) column[k - from] = frames.bandsDb[k * BANDS + band];
    median[band] = medianOf(column);
  }
  return median;
}

function medianOf(values: Float32Array): number {
  const sorted = Float32Array.from(values).sort();
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Turn boundary times into characterised sections.
 *
 * Section loudness is the mean of the *per-frame* dB values rather than the dB of
 * the mean power. The two differ on material with a wide dynamic range within one
 * section, and the per-frame mean is the one that matches what the section sounds
 * like: averaging power first lets four bars of loud stabs decide the loudness of
 * a section that is otherwise near silence.
 */
function finish(
  boundaries: number[],
  duration: number,
  grid: BeatGrid | null,
  frames: FeatureFrames,
  novelty: NoveltyCurve,
  strengths: number[],
): SongStructure {
  const beatSynchronous = frames.beatSynchronous;
  const edges = [0, ...boundaries, duration];
  const loudness: number[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    loudness.push(meanIntensityDb(frames, edges[i], edges[i + 1]));
  }

  const highest = Math.max(...loudness);
  const lowest = Math.min(...loudness);
  const span = highest - lowest;
  const median = medianOf(Float32Array.from(loudness));
  let dropIndex: number | null = null;
  if (loudness.length > 1 && highest - median >= DROP_MIN_LEAD_DB) {
    dropIndex = loudness.indexOf(highest);
  }

  const sections: Section[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const startSeconds = edges[i];
    const endSeconds = edges[i + 1];
    const startBeat = beatSynchronous && grid !== null ? beatIndexAt(grid, startSeconds) : null;
    const endBeat = beatSynchronous && grid !== null ? beatIndexAt(grid, endSeconds) : null;
    sections.push({
      index: i,
      startSeconds,
      endSeconds,
      durationSeconds: endSeconds - startSeconds,
      // A single section, or a track with no dynamic range at all, is fully
      // intense by this measure — there is nothing in the track that is more so.
      intensity: span > 0 ? (loudness[i] - lowest) / span : 1,
      loudnessDb: loudness[i],
      boundaryStrength: i === 0 ? 0 : (strengths[i - 1] ?? 0),
      isDrop: dropIndex === i,
      startBeat,
      beatCount: startBeat !== null && endBeat !== null ? endBeat - startBeat : null,
    });
  }

  const confidence =
    strengths.length === 0
      ? 0
      : clamp01(
          strengths.reduce((sum, value) => sum + value, 0) / strengths.length / CONFIDENT_NOVELTY,
        );
  return { sections, dropIndex, duration, beatSynchronous, grid, confidence, novelty };
}

function meanIntensityDb(frames: FeatureFrames, from: number, to: number): number {
  let sum = 0;
  let used = 0;
  for (let k = 0; k < frames.count; k++) {
    if (frames.times[k] < from) continue;
    if (frames.times[k] >= to) break;
    sum += frames.intensityDb[k];
    used++;
  }
  if (used === 0) {
    // A section shorter than one feature frame — possible only at the tail of a
    // track. Take the frame it sits inside.
    let nearest = 0;
    let best = Infinity;
    for (let k = 0; k < frames.count; k++) {
      const distance = Math.abs(frames.times[k] - from);
      if (distance < best) {
        best = distance;
        nearest = k;
      }
    }
    return frames.intensityDb[nearest];
  }
  return sum / used;
}

/** The first beat at or after `seconds`, as an index into `grid.beats`. */
function beatIndexAt(grid: BeatGrid, seconds: number): number {
  // A hair of tolerance: boundaries are beat instants by construction, and float
  // arithmetic must not push one to the beat after the one it came from.
  const target = seconds - 1e-6;
  let lo = 0;
  let hi = grid.beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (grid.beats[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
