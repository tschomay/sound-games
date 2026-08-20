/**
 * A minimal in-place radix-2 FFT.
 *
 * Offline beat tracking needs a spectrum for every ~10ms of a whole track — for
 * a four-minute file that is around 24,000 transforms, which a naive O(N²) DFT
 * would turn into tens of billions of multiplies. `pitch.ts` gets away without
 * one because NSDF is a time-domain method over a decimated buffer; spectral
 * flux has no such escape, so this is the one place the codebase needs a real
 * FFT. It stays hand-rolled rather than pulled in as a dependency, matching
 * `pitch.ts`/`onset.ts` (see AGENTS.md conventions).
 *
 * Twiddle factors and the bit-reversal permutation are precomputed per size, so
 * the per-transform cost is the butterflies alone. Reuse one instance across
 * frames — constructing it is the expensive part.
 */
export class Fft {
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reversed: Uint32Array;

  /** @param size transform length; must be a power of two and at least 2. */
  constructor(readonly size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    const half = size >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      // Tabulated rather than accumulated by repeated rotation: over a 512-point
      // transform the accumulated form drifts by enough to smear a spectrum's
      // high bins, and the table costs one allocation for the whole run.
      const angle = (-2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }

    this.reversed = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let value = 0;
      for (let bit = 0; bit < bits; bit++) {
        if (i & (1 << bit)) value |= 1 << (bits - 1 - bit);
      }
      this.reversed[i] = value;
    }
  }

  /** Forward transform of `re`/`im`, both `size` long, rewritten in place. */
  transform(re: Float32Array, im: Float32Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reversed[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }

    for (let span = 1; span < n; span <<= 1) {
      const step = n / (span << 1);
      for (let start = 0; start < n; start += span << 1) {
        for (let k = 0; k < span; k++) {
          const twiddle = k * step;
          const wr = this.cos[twiddle];
          const wi = this.sin[twiddle];
          const a = start + k;
          const b = a + span;
          const vr = re[b] * wr - im[b] * wi;
          const vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr;
          im[b] = im[a] - vi;
          re[a] += vr;
          im[a] += vi;
        }
      }
    }
  }

  /**
   * Magnitude of bins 0..size/2 for a real signal already loaded into `re`
   * (with `im` zeroed). Both arrays are clobbered.
   */
  magnitudes(re: Float32Array, im: Float32Array, out: Float32Array): void {
    this.transform(re, im);
    for (let i = 0; i < out.length; i++) out[i] = Math.hypot(re[i], im[i]);
  }
}

/** A Hann window of `size` points, for tapering STFT frames. */
export function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return window;
}
