import { describe, expect, it } from 'vitest';
import { Fft, hannWindow } from '../fft';
import { mulberry32 } from './synthetic-audio';

/** The definition, straight from the textbook, to check the fast version against. */
function naiveDft(input: Float32Array): { re: number[]; im: number[] } {
  const n = input.length;
  const re: number[] = [];
  const im: number[] = [];
  for (let k = 0; k < n; k++) {
    let sumRe = 0;
    let sumIm = 0;
    for (let i = 0; i < n; i++) {
      const angle = (-2 * Math.PI * k * i) / n;
      sumRe += input[i] * Math.cos(angle);
      sumIm += input[i] * Math.sin(angle);
    }
    re.push(sumRe);
    im.push(sumIm);
  }
  return { re, im };
}

describe('Fft', () => {
  it('rejects a size that is not a power of two', () => {
    expect(() => new Fft(300)).toThrow();
    expect(() => new Fft(1)).toThrow();
  });

  it('matches a naive DFT on random input', () => {
    const random = mulberry32(11);
    const size = 16;
    const input = new Float32Array(size);
    for (let i = 0; i < size; i++) input[i] = random() * 2 - 1;

    const expected = naiveDft(input);
    const re = Float32Array.from(input);
    const im = new Float32Array(size);
    new Fft(size).transform(re, im);

    for (let k = 0; k < size; k++) {
      expect(re[k]).toBeCloseTo(expected.re[k], 4);
      expect(im[k]).toBeCloseTo(expected.im[k], 4);
    }
  });

  it('puts a pure cosine in one bin', () => {
    const size = 256;
    const bin = 9;
    const re = new Float32Array(size);
    for (let i = 0; i < size; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / size);

    const magnitude = new Float32Array(size / 2 + 1);
    new Fft(size).magnitudes(re, new Float32Array(size), magnitude);

    let loudest = 0;
    for (let i = 0; i < magnitude.length; i++) if (magnitude[i] > magnitude[loudest]) loudest = i;
    expect(loudest).toBe(bin);
    // Everything that isn't the signal's own bin should be numerical dust.
    for (let i = 0; i < magnitude.length; i++) {
      if (i !== bin) expect(magnitude[i]).toBeLessThan(magnitude[bin] * 0.001);
    }
  });
});

describe('hannWindow', () => {
  it('tapers from zero to one and back', () => {
    const window = hannWindow(64);
    expect(window[0]).toBeCloseTo(0, 6);
    expect(window[32]).toBeCloseTo(1, 6);
    expect(window[16]).toBeCloseTo(window[48], 6);
  });
});
