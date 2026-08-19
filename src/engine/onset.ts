/**
 * Onset detection by spectral flux against an adaptive threshold.
 *
 * Flux is the sum of positive frame-to-frame change across the spectrum, so a
 * clap — energy appearing everywhere at once — spikes it hard while a sustained
 * hum barely moves it. The threshold tracks a rolling median rather than sitting
 * at a fixed value, because the level a clap has to beat depends entirely on how
 * loud the room already is.
 */

export interface OnsetOptions {
  /** Ignore bins above this — most transient energy is below it, and the top of
   *  the spectrum is mostly hiss. */
  maxHz?: number;
  /** How far above the rolling median flux must go to count. */
  sensitivity?: number;
  /** Minimum gap between onsets, seconds. Stops one clap firing three times. */
  refractory?: number;
  historySize?: number;
}

export interface OnsetResult {
  onset: boolean;
  flux: number;
  /** How far above threshold the transient was, squashed to 0..1. */
  strength: number;
}

export class OnsetDetector {
  private readonly previous: Float32Array;
  private readonly history: number[] = [];
  private readonly historySize: number;
  private readonly maxBin: number;
  private readonly sensitivity: number;
  private readonly refractory: number;
  private lastOnsetAt = -Infinity;
  private primed = false;

  constructor(binCount: number, nyquist: number, options: OnsetOptions = {}) {
    const maxHz = options.maxHz ?? 8000;
    this.sensitivity = options.sensitivity ?? 1.8;
    this.refractory = options.refractory ?? 0.12;
    this.historySize = options.historySize ?? 43; // ~1s at 60fps of analyser updates
    this.maxBin = Math.min(binCount, Math.ceil((maxHz / nyquist) * binCount));
    this.previous = new Float32Array(binCount);
  }

  /** @param spectrum magnitudes in dBFS, as `getFloatFrequencyData` returns. */
  process(spectrum: Float32Array, now: number): OnsetResult {
    let flux = 0;
    for (let i = 0; i < this.maxBin; i++) {
      // dB is already logarithmic; clamping the floor keeps near-silent bins
      // from dominating the difference.
      const magnitude = Math.max(-100, spectrum[i]);
      const delta = magnitude - this.previous[i];
      if (delta > 0) flux += delta;
      this.previous[i] = magnitude;
    }
    flux /= this.maxBin;

    if (!this.primed) {
      this.primed = true;
      return { onset: false, flux: 0, strength: 0 };
    }

    const threshold = this.threshold();
    this.history.push(flux);
    if (this.history.length > this.historySize) this.history.shift();

    if (flux > threshold && now - this.lastOnsetAt > this.refractory) {
      this.lastOnsetAt = now;
      return { onset: true, flux, strength: Math.min(1, (flux - threshold) / 6) };
    }
    return { onset: false, flux, strength: 0 };
  }

  private threshold(): number {
    if (this.history.length < 8) return Infinity;
    const sorted = [...this.history].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // The additive floor is what stops a dead-silent room from firing onsets on
    // its own noise, where a purely multiplicative threshold would collapse.
    return median * this.sensitivity + 0.6;
  }
}
