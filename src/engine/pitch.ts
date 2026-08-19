/**
 * Pitch detection by normalised square difference (McLeod's method) over a
 * decimated buffer.
 *
 * Running NSDF at 48 kHz over a hum's lag range costs about a million multiplies
 * a frame, which a phone will not thank us for. Voices live below ~1 kHz, so we
 * decimate hard first — a box filter and a stride, chosen to keep the effective
 * rate at least 6x the highest pitch we care about. That drops the cost by two
 * orders of magnitude and loses nothing we were going to use.
 */

export interface PitchResult {
  /** Hz, or null when nothing periodic was found. */
  hz: number | null;
  /** Peak NSDF value, 0..1. Above ~0.9 is a confident read. */
  clarity: number;
}

export interface PitchOptions {
  minHz?: number;
  maxHz?: number;
  /** NSDF peaks this far below the strongest one are still eligible, and the
   *  earliest eligible peak wins — that's what stops octave errors. */
  peakThreshold?: number;
  /** Below this clarity we report no pitch at all. */
  clarityFloor?: number;
}

export class PitchDetector {
  private readonly decimation: number;
  private readonly rate: number;
  private readonly minLag: number;
  private readonly maxLag: number;
  private readonly peakThreshold: number;
  private readonly clarityFloor: number;
  private readonly work: Float32Array;
  private readonly nsdf: Float32Array;

  constructor(sampleRate: number, bufferSize: number, options: PitchOptions = {}) {
    const minHz = options.minHz ?? 70;
    const maxHz = options.maxHz ?? 1000;
    this.peakThreshold = options.peakThreshold ?? 0.85;
    this.clarityFloor = options.clarityFloor ?? 0.75;

    this.decimation = Math.max(1, Math.floor(sampleRate / (maxHz * 6)));
    this.rate = sampleRate / this.decimation;

    this.work = new Float32Array(Math.floor(bufferSize / this.decimation));
    this.minLag = Math.max(2, Math.floor(this.rate / maxHz));
    this.maxLag = Math.min(
      Math.floor(this.work.length / 2),
      Math.ceil(this.rate / minHz),
    );
    this.nsdf = new Float32Array(this.maxLag + 1);
  }

  detect(input: Float32Array): PitchResult {
    const n = this.decimate(input);
    if (n < this.maxLag * 2) return { hz: null, clarity: 0 };

    this.computeNsdf(n);
    const lag = this.pickPeak();
    if (lag === null) return { hz: null, clarity: 0 };

    const clarity = this.nsdf[Math.round(lag)] ?? 0;
    if (clarity < this.clarityFloor) return { hz: null, clarity };
    return { hz: this.rate / lag, clarity };
  }

  /** Box-filter and stride into `work`. Returns the sample count written. */
  private decimate(input: Float32Array): number {
    const d = this.decimation;
    const n = Math.min(this.work.length, Math.floor(input.length / d));
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const base = i * d;
      for (let k = 0; k < d; k++) sum += input[base + k];
      this.work[i] = sum / d;
    }
    return n;
  }

  private computeNsdf(n: number): void {
    for (let lag = this.minLag; lag <= this.maxLag; lag++) {
      let correlation = 0;
      let energy = 0;
      for (let i = 0, j = lag; j < n; i++, j++) {
        const a = this.work[i];
        const b = this.work[j];
        correlation += a * b;
        energy += a * a + b * b;
      }
      this.nsdf[lag] = energy > 0 ? (2 * correlation) / energy : 0;
    }
  }

  /**
   * The earliest local maximum that reaches `peakThreshold` of the global
   * maximum, refined by parabolic interpolation. Taking the *earliest* rather
   * than the *largest* peak is what keeps us on the fundamental instead of
   * dropping an octave.
   */
  private pickPeak(): number | null {
    let globalMax = 0;
    for (let lag = this.minLag; lag <= this.maxLag; lag++) {
      if (this.nsdf[lag] > globalMax) globalMax = this.nsdf[lag];
    }
    if (globalMax <= 0) return null;

    const cutoff = globalMax * this.peakThreshold;
    for (let lag = this.minLag + 1; lag < this.maxLag; lag++) {
      const here = this.nsdf[lag];
      if (here < cutoff) continue;
      const before = this.nsdf[lag - 1];
      const after = this.nsdf[lag + 1];
      if (here <= before || here < after) continue;

      const denominator = 2 * (2 * here - before - after);
      const offset = denominator === 0 ? 0 : (after - before) / denominator;
      return lag + offset;
    }
    return null;
  }
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface NoteReading {
  name: string;
  octave: number;
  /** Deviation from the nearest equal-tempered note, -50..+50. */
  cents: number;
}

export function hzToNote(hz: number): NoteReading {
  const midi = 69 + 12 * Math.log2(hz / 440);
  const nearest = Math.round(midi);
  return {
    name: NOTE_NAMES[((nearest % 12) + 12) % 12],
    octave: Math.floor(nearest / 12) - 1,
    cents: Math.round((midi - nearest) * 100),
  };
}
