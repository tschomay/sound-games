/**
 * Classifies a frame's sound as transient (a clap), tonal (a held vowel like
 * "aaah") or noisy (a shout, or anything sustained and loud that isn't clean
 * and periodic) — see ADR-0007. `onset.ts` already finds transients precisely
 * from spectral flux (frame-to-frame change); this instead reads a frame's
 * static *shape* from zero-crossing rate and spectral flatness, which is what
 * separates the two verbs A2 Clap Runner actually needs: a periodic waveform
 * (low zcr, low flatness) versus a noise-like one (high zcr, high flatness).
 * Kept out of `onset.ts`/`analyser.ts`'s existing detectors — same reasoning
 * as ADR-0005 and ADR-0006 for keeping a new concern in its own module.
 *
 * Both features move together for a real voice — a harsh shout raises zcr and
 * flatness at once, a clean "aaah" keeps both low — so the classifier requires
 * both to agree before committing to either extreme, and holds its last
 * sustained read in the ambiguous band between them rather than picking a
 * side on noise. That, plus a short hold before a burst gets promoted from
 * "transient" to "noisy", is the whole of its hysteresis.
 */
import type { Timbre } from './types';

export interface TimbreThresholds {
  /** `level` below this can't be classified as anything but silence. */
  silenceLevel: number;
  /** zcr at/below this counts toward "tonal". */
  tonalZcr: number;
  /** flatness at/below this counts toward "tonal". */
  tonalFlatness: number;
  /** zcr at/above this counts toward "burst" (transient or noisy). */
  burstZcr: number;
  /** flatness at/above this counts toward "burst". */
  burstFlatness: number;
  /**
   * Consecutive burst-shaped frames still read as "transient" rather than
   * "noisy" — a real clap decays away well inside this; a held shout keeps
   * going past it.
   */
  transientHoldFrames: number;
}

/**
 * First-pass estimates, reasoned from how zero-crossing rate scales with
 * frequency content (a voiced fundamental in the 70–1000 Hz range this
 * codebase already targets for pitch sits at a small fraction of the sample
 * rate; broadband noise sits close to the 0.5 ceiling for uncorrelated
 * samples) rather than measured on real hardware. See ADR-0007 for the
 * tradeoff and what to tune first if a device disagrees.
 */
export const DEFAULT_TIMBRE_THRESHOLDS: TimbreThresholds = {
  silenceLevel: 0.06,
  tonalZcr: 0.12,
  tonalFlatness: 0.2,
  burstZcr: 0.28,
  burstFlatness: 0.45,
  transientHoldFrames: 4,
};

export class TimbreClassifier {
  private lastSustained: 'tonal' | 'noisy' = 'tonal';
  private burstFrames = 0;

  constructor(private readonly thresholds: TimbreThresholds = DEFAULT_TIMBRE_THRESHOLDS) {}

  /**
   * @param zcr Zero-crossing rate, 0..1 — see `Frame.zcr`.
   * @param flatness Spectral flatness, 0..1 — see `Frame.flatness`.
   * @param level Calibrated loudness, 0..1 — see `Frame.level`.
   * @param onset This frame's onset flag, if the caller has one. `onset.ts`'s
   *   spectral-flux detector is the more precise transient finder, so a true
   *   onset short-circuits straight to "transient" instead of waiting on the
   *   hold-frame count below.
   */
  classify(zcr: number, flatness: number, level: number, onset = false): Timbre {
    const t = this.thresholds;

    if (level < t.silenceLevel) {
      this.burstFrames = 0;
      return 'silence';
    }

    if (onset) {
      this.burstFrames = 1;
      return 'transient';
    }

    const burstLike = zcr >= t.burstZcr && flatness >= t.burstFlatness;
    if (burstLike) {
      this.burstFrames++;
      if (this.burstFrames > t.transientHoldFrames) {
        this.lastSustained = 'noisy';
        return 'noisy';
      }
      return 'transient';
    }
    this.burstFrames = 0;

    const tonalLike = zcr <= t.tonalZcr && flatness <= t.tonalFlatness;
    if (tonalLike) {
      this.lastSustained = 'tonal';
      return 'tonal';
    }

    // Neither clearly tonal nor clearly burst-like: hold the last sustained
    // read instead of picking a side on a frame that's genuinely ambiguous.
    // This is what stops a voice hovering near a threshold from flickering
    // between "tonal" and "noisy" frame to frame.
    return this.lastSustained;
  }
}
