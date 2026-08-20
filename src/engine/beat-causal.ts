/**
 * Causal realtime beat tracking — the mushy one.
 *
 * This is the microphone half of ADR-0001's two trackers, and the roadmap is
 * blunt about what to expect from it: "the honest failure mode is that mic-driven
 * beat games are mushy while file-driven ones are tight." It gets one moment at a
 * time, cannot see a beat before it happens, and has to commit to a tempo from a
 * few seconds of history — where `beat-offline.ts` gets the whole track and all
 * the time in the world. It will be slower to lock on, less precise, and
 * occasionally an octave out. What it must not do is *hide* that, which is what
 * `confidence` is for: it starts at zero, climbs only as a stable periodicity
 * actually emerges, and collapses again when the music stops.
 *
 * Two pieces, deliberately kept separate because they fail differently:
 *
 * 1. **Tempo, from an inter-onset-interval histogram.** Every pair of onsets in
 *    the recent history votes for the period it implies, and for that period
 *    divided by small integers, because a gap of two or three beats is evidence
 *    about the beat too. The votes go into a smeared histogram and its peak is
 *    the tempo. This is Dixon-style tempo induction, chosen over autocorrelating
 *    a flux envelope because it needs only onset *times* — a handful of numbers a
 *    frame rather than a rolling spectrogram — which is the right cost for
 *    something running inside a game loop.
 * 2. **Phase, from a first-order lock onto onsets near the predicted beat.** The
 *    predicted beat is nudged a fraction of the way toward any onset that lands
 *    close enough to plausibly *be* that beat, and onsets further away are
 *    ignored rather than allowed to drag the prediction onto a syncopation.
 *
 * See ADR-0010 for the reasoning and the honest limitations.
 */
import {
  DEFAULT_TEMPO_RANGE,
  NO_BEAT,
  bpmToPeriod,
  clamp01,
  periodToBpm,
  tempoPrior,
  type BeatReader,
  type BeatReading,
  type TempoRange,
} from './beat';

export interface CausalBeatOptions extends Partial<TempoRange> {
  /**
   * How much onset history to reason from. Long enough to hold a dozen beats of
   * slow music, short enough that a tempo change works its way out in seconds
   * rather than a minute. This is the single biggest lever on the "adapts
   * quickly" versus "holds steady" tradeoff.
   */
  historySeconds?: number;
  /** The widest gap between two onsets that is still evidence about the tempo. */
  maxIntervalSeconds?: number;
  /** With no onsets for this long, the tempo estimate is dropped rather than
   *  coasted on — the music has stopped, or the room has. */
  staleAfterSeconds?: number;
  /** Onsets needed before any tempo is reported at all. */
  minOnsets?: number;
  /** Share of a phase error corrected per onset. Higher locks on faster and
   *  jitters more. */
  phaseGain?: number;
  /** Share of the way the period moves toward each new histogram estimate. */
  tempoGain?: number;
}

const DEFAULTS = {
  historySeconds: 8,
  maxIntervalSeconds: 2,
  staleAfterSeconds: 5,
  minOnsets: 4,
  phaseGain: 0.2,
  tempoGain: 0.3,
} as const;

/** Histogram resolution over the tempo range. ~7ms of period per bin at the
 *  default range, comfortably finer than the timing spread of real onsets. */
const HISTOGRAM_BINS = 96;
/** Each vote is smeared this far (as a fraction of the period it votes for)
 *  rather than dropped in one bin, so two performances of the same tempo two
 *  bins apart reinforce each other instead of splitting the vote. */
const VOTE_SPREAD = 0.02;
/** An onset counts as "on" the predicted beat, and so may correct its phase, only
 *  within this fraction of a period. A quarter beat is the point past which an
 *  onset is better explained as a syncopation than as a late beat, and locking
 *  onto those is how a tracker ends up confidently half a beat out. */
const PHASE_CAPTURE = 0.25;
/** Consecutive onsets landing outside that window before the phase prediction is
 *  thrown away and re-anchored to the next onset. Without this the tracker can
 *  lock itself out: a prediction far enough from the beat is never corrected,
 *  because every correction is gated on being close already. */
const PHASE_RECOVERY = 4;
/** How far a new tempo estimate must sit from the current one to count as a
 *  disagreement rather than drift. */
const TEMPO_JUMP = 0.12;
/** Consecutive disagreeing estimates before the tempo is abandoned and replaced
 *  outright. Small enough to adapt inside a few seconds, large enough that one
 *  stumbled bar cannot throw the tempo away. */
const JUMP_PATIENCE = 3;

interface Onset {
  at: number;
  strength: number;
}

export class CausalBeatTracker implements BeatReader {
  private readonly minPeriod: number;
  private readonly maxPeriod: number;
  private readonly options: Required<Omit<CausalBeatOptions, 'minBpm' | 'maxBpm'>>;

  private readonly onsets: Onset[] = [];
  private period: number | null = null;
  /** Time of the most recent beat, predicted or observed. */
  private anchor = 0;
  private anchored = false;
  private beatIndex = 0;
  private disagreements = 0;
  private phaseMisses = 0;
  /** Rolling mean of how far onsets miss the predicted beat, 0 (perfect) to 1
   *  (half a beat out). Starts pessimistic so confidence has to be earned. */
  private lockError = 1;
  private salience = 0;

  constructor(options: CausalBeatOptions = {}) {
    this.minPeriod = bpmToPeriod(options.maxBpm ?? DEFAULT_TEMPO_RANGE.maxBpm);
    this.maxPeriod = bpmToPeriod(options.minBpm ?? DEFAULT_TEMPO_RANGE.minBpm);
    this.options = {
      historySeconds: options.historySeconds ?? DEFAULTS.historySeconds,
      maxIntervalSeconds: options.maxIntervalSeconds ?? DEFAULTS.maxIntervalSeconds,
      staleAfterSeconds: options.staleAfterSeconds ?? DEFAULTS.staleAfterSeconds,
      minOnsets: options.minOnsets ?? DEFAULTS.minOnsets,
      phaseGain: options.phaseGain ?? DEFAULTS.phaseGain,
      tempoGain: options.tempoGain ?? DEFAULTS.tempoGain,
    };
  }

  /**
   * One moment of input. Call once per frame, in order.
   *
   * @param now seconds on the analyser's clock (`Frame.t`).
   * @param onset whether a transient started this frame (`Frame.onset`).
   * @param strength how loud it was, 0..1 (`Frame.onsetStrength`); used to weight
   * a confident onset above a marginal one when voting on tempo.
   */
  process(now: number, onset: boolean, strength = 1): BeatReading {
    if (onset) this.ingest(now, strength);
    this.expire(now);
    return this.advance(now);
  }

  /** The reading for a frame with no onset in it. */
  read(now: number): BeatReading {
    return this.process(now, false);
  }

  reset(): void {
    this.onsets.length = 0;
    this.period = null;
    this.anchor = 0;
    this.anchored = false;
    this.beatIndex = 0;
    this.disagreements = 0;
    this.phaseMisses = 0;
    this.lockError = 1;
    this.salience = 0;
  }

  private ingest(now: number, strength: number): void {
    // A floor rather than the raw strength: `OnsetDetector` reports 0 for
    // anything that only just cleared its threshold, and a zero-weight vote is
    // the same as not having heard the onset at all.
    this.onsets.push({ at: now, strength: Math.max(0.1, strength) });
    while (this.onsets.length > 0 && now - this.onsets[0].at > this.options.historySeconds) {
      this.onsets.shift();
    }
    this.updateTempo(now);
    this.updatePhase(now);
  }

  private expire(now: number): void {
    const last = this.onsets[this.onsets.length - 1];
    if (last !== undefined && now - last.at <= this.options.staleAfterSeconds) return;
    if (this.period === null && this.onsets.length === 0) return;
    // Coasting on a tempo nothing has confirmed for five seconds is exactly the
    // dishonesty `confidence` exists to prevent, so the estimate is dropped
    // outright rather than left standing at a decayed confidence.
    this.reset();
  }

  private updateTempo(now: number): void {
    if (this.onsets.length < this.options.minOnsets) return;
    const estimate = this.estimateTempo(now);
    if (estimate === null) return;

    this.salience = estimate.salience;
    if (this.period === null) {
      this.period = estimate.period;
      return;
    }

    if (Math.abs(estimate.period - this.period) / this.period > TEMPO_JUMP) {
      // Blending across a big gap would spend several seconds reporting tempi
      // nothing in the room is playing. Hold the current one until the new
      // estimate has repeated itself, then take it whole.
      if (++this.disagreements >= JUMP_PATIENCE) {
        this.period = estimate.period;
        this.disagreements = 0;
        this.phaseMisses = 0;
        this.lockError = 1;
      }
      return;
    }
    this.disagreements = 0;
    this.period += this.options.tempoGain * (estimate.period - this.period);
  }

  /**
   * Every pair of onsets close enough together votes for the period it implies.
   *
   * A gap of one beat votes for itself; a gap of two, three or more beats votes
   * for its own fraction, which is what lets a sparse pattern — a kick every other
   * beat — still say something about the tempo. Votes are weighted by both
   * onsets' strengths, by how recent they are, and down by the divisor used, since
   * "that gap was five beats" is a weaker claim than "that gap was one beat". A
   * tempo prior breaks the remaining ties (see `beat.ts`).
   */
  private estimateTempo(now: number): { period: number; salience: number } | null {
    const histogram = new Float64Array(HISTOGRAM_BINS);
    const width = (this.maxPeriod - this.minPeriod) / HISTOGRAM_BINS;

    for (let j = 1; j < this.onsets.length; j++) {
      const later = this.onsets[j];
      const recency = Math.exp(-(now - later.at) / this.options.historySeconds);
      for (let i = j - 1; i >= 0; i--) {
        const earlier = this.onsets[i];
        const gap = later.at - earlier.at;
        if (gap > this.options.maxIntervalSeconds) break;
        const weight = earlier.strength * later.strength * recency;
        for (let beats = 1; beats <= 6; beats++) {
          const period = gap / beats;
          if (period < this.minPeriod) break;
          if (period > this.maxPeriod) continue;
          this.vote(histogram, width, period, weight / beats);
        }
      }
    }

    let peak = -1;
    let peakBin = 0;
    for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
      const period = this.minPeriod + (bin + 0.5) * width;
      histogram[bin] *= tempoPrior(periodToBpm(period));
      if (histogram[bin] > peak) {
        peak = histogram[bin];
        peakBin = bin;
      }
    }
    if (peak <= 0) return null;

    let rival = 0;
    for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
      if (Math.abs(bin - peakBin) < HISTOGRAM_BINS * 0.08) continue;
      if (histogram[bin] > rival) rival = histogram[bin];
    }

    const centre = this.minPeriod + (peakBin + 0.5) * width;
    return {
      period: centre + interpolatePeak(histogram, peakBin) * width,
      salience: clamp01(1 - rival / peak),
    };
  }

  private vote(histogram: Float64Array, width: number, period: number, weight: number): void {
    const spread = Math.max(width, period * VOTE_SPREAD);
    const centre = (period - this.minPeriod) / width - 0.5;
    const reach = Math.ceil((3 * spread) / width);
    const from = Math.max(0, Math.round(centre) - reach);
    const to = Math.min(HISTOGRAM_BINS - 1, Math.round(centre) + reach);
    for (let bin = from; bin <= to; bin++) {
      const distance = ((bin - centre) * width) / spread;
      histogram[bin] += weight * Math.exp(-0.5 * distance * distance);
    }
  }

  private updatePhase(now: number): void {
    const period = this.period;
    if (period === null) return;
    if (!this.anchored) {
      // Nothing to correct toward yet: the first onset after a tempo appears is
      // the only thing we know about where the beat actually is.
      this.anchor = now;
      this.anchored = true;
      return;
    }

    const beatsAway = (now - this.anchor) / period;
    const error = (beatsAway - Math.round(beatsAway)) * period;
    const missed = clamp01(Math.abs(error) / (period / 2));
    this.lockError += 0.25 * (missed - this.lockError);

    if (Math.abs(error) > PHASE_CAPTURE * period) {
      if (++this.phaseMisses >= PHASE_RECOVERY) {
        this.anchor = now;
        this.phaseMisses = 0;
      }
      return;
    }
    this.phaseMisses = 0;
    this.anchor += this.options.phaseGain * error;
  }

  private advance(now: number): BeatReading {
    const period = this.period;
    if (period === null || this.onsets.length < this.options.minOnsets) return NO_BEAT;

    let onBeat = false;
    while (now - this.anchor >= period) {
      this.anchor += period;
      this.beatIndex++;
      onBeat = true;
    }
    // A backwards jump means the caller's clock restarted under us; re-anchoring
    // beats reporting a phase from a beat that never happened.
    if (now < this.anchor) this.anchor = now;

    return {
      bpm: periodToBpm(period),
      beatPhase: clamp01((now - this.anchor) / period),
      onBeat,
      confidence: this.confidence(),
      beatIndex: this.beatIndex,
    };
  }

  /**
   * Three things it can be wrong about, multiplied together so that being bad at
   * any one of them is enough to say so: whether it has heard enough to have an
   * opinion, whether the histogram actually picked a tempo out of the noise, and
   * whether predicted beats are landing where onsets land. The last is the one
   * that catches the tracker being confidently half a beat out — the tempo can be
   * exactly right while the phase is not.
   */
  private confidence(): number {
    const coverage = clamp01((this.onsets.length - this.options.minOnsets + 1) / 6);
    const tempo = clamp01(this.salience / 0.5);
    const lock = 1 - this.lockError;
    return clamp01(coverage * (0.4 + 0.6 * tempo) * lock);
  }
}

/** Sub-bin peak position by parabolic interpolation, in bins, or 0 at an edge. */
function interpolatePeak(histogram: Float64Array, bin: number): number {
  if (bin <= 0 || bin >= histogram.length - 1) return 0;
  const before = histogram[bin - 1];
  const here = histogram[bin];
  const after = histogram[bin + 1];
  const denominator = 2 * (2 * here - before - after);
  if (denominator === 0) return 0;
  const offset = (after - before) / denominator;
  return Math.abs(offset) < 1 ? offset : 0;
}
