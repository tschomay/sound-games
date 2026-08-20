/**
 * The one shape both beat trackers speak.
 *
 * ADR-0001 committed this project to two audio sources and, with them, two beat
 * trackers: a causal one that has to guess from what it has heard so far
 * (`beat-causal.ts`, for the microphone) and an offline one that gets to look at
 * the whole file before a note is played (`beat-offline.ts`). They are not
 * equally good and never will be — the offline one is exact, the causal one is
 * approximate and late. What makes that tolerable is that a game never has to
 * know which one it is talking to: both answer the same question, "what is the
 * beat doing right now", with the same `BeatReading`.
 *
 * See ADR-0010 for the algorithms behind each and an honest account of where
 * they are expected to struggle.
 */

/** What the beat is doing at one moment. Produced once per frame. */
export interface BeatReading {
  /** Current tempo estimate. `null` when there isn't enough signal to say. */
  bpm: number | null;
  /**
   * Position inside the current beat, 0 at the beat instant rising to just
   * under 1 immediately before the next. `null` whenever `bpm` is `null`.
   */
  beatPhase: number | null;
  /**
   * True on the first reading at or after a beat instant, and only that one, so
   * a caller can treat it as an edge rather than a level. At a normal frame rate
   * this fires within one frame of the beat, always late rather than early.
   */
  onBeat: boolean;
  /**
   * How much to trust the rest of this reading, 0..1. The two trackers earn this
   * differently and are not directly comparable — see each tracker's docs — but
   * in both, near-zero means "ignore me" and a sustained value above ~0.6 means
   * a stable periodicity has been found.
   */
  confidence: number;
  /**
   * Which beat this is. For the offline grid it counts from the first beat of
   * the track (and goes negative in any lead-in before it); for the causal
   * tracker it counts from whenever the tracker locked on, so it is useful for
   * "every fourth beat" style rhythm but carries no relationship to bar lines in
   * the actual music. `null` whenever `bpm` is `null`.
   */
  beatIndex: number | null;
}

/** The reading to use when nothing is known: no tempo, no phase, no confidence. */
export const NO_BEAT: BeatReading = Object.freeze({
  bpm: null,
  beatPhase: null,
  onBeat: false,
  confidence: 0,
  beatIndex: null,
});

/**
 * What both trackers expose, so a caller can hold one without caring which.
 *
 * `read` is a *tick*, not a pure query: the causal tracker advances its beat
 * prediction inside it, and both trackers use the gap between successive calls
 * to decide whether `onBeat` should fire. Call it once per frame, in order.
 * `CausalBeatTracker` additionally takes onset input, through its own
 * `process()`; `read(now)` is just that with no onset this frame.
 */
export interface BeatReader {
  /**
   * @param now for the causal tracker, seconds on the analyser's clock; for the
   * offline grid, seconds into the track (`FileSource.position()`).
   */
  read(now: number): BeatReading;
  /** Forget any per-frame edge state. Call after a seek or a round restart. */
  reset(): void;
}

/**
 * Tempo search bounds. 60–180 BPM covers essentially all dance, pop and rock
 * music at the level a listener taps their foot, and keeping the window under an
 * octave-and-a-bit means most half/double-tempo confusions fall outside it
 * entirely rather than having to be argued about.
 */
export interface TempoRange {
  minBpm: number;
  maxBpm: number;
}

export const DEFAULT_TEMPO_RANGE: TempoRange = { minBpm: 60, maxBpm: 180 };

/**
 * Human tempo perception is not uniform over that range — around 120 BPM is the
 * most natural tapping rate, and estimators that ignore this systematically
 * report half-tempo for fast tracks and double for slow ones. Both trackers
 * weight candidate tempi by a log-normal prior centred here, wide enough
 * (`TEMPO_PRIOR_OCTAVES` in octaves) that it only breaks genuine ties rather
 * than overriding evidence. Numbers follow the shape used by Ellis's
 * beat-tracking work, which is the standard reference for this trick.
 */
export const TEMPO_PRIOR_BPM = 120;
export const TEMPO_PRIOR_OCTAVES = 0.9;

/** Relative likelihood of `bpm` under the tempo prior, peaking at 1. */
export function tempoPrior(bpm: number): number {
  const octaves = Math.log2(bpm / TEMPO_PRIOR_BPM) / TEMPO_PRIOR_OCTAVES;
  return Math.exp(-0.5 * octaves * octaves);
}

export function bpmToPeriod(bpm: number): number {
  return 60 / bpm;
}

export function periodToBpm(periodSeconds: number): number {
  return 60 / periodSeconds;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
