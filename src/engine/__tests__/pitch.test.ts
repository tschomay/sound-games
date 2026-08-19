import { describe, expect, it } from 'vitest';
import { PitchDetector, hzToNote } from '../pitch';

const RATE = 48000;
const SIZE = 2048;

/** A tone with harmonics, which is what a hum actually looks like. */
function tone(hz: number, harmonics: number[] = [1, 0.5, 0.25]): Float32Array {
  const samples = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    let value = 0;
    harmonics.forEach((amplitude, index) => {
      value += amplitude * Math.sin((2 * Math.PI * hz * (index + 1) * i) / RATE);
    });
    samples[i] = value * 0.3;
  }
  return samples;
}

function noise(): Float32Array {
  const samples = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) samples[i] = (Math.random() * 2 - 1) * 0.3;
  return samples;
}

describe('PitchDetector', () => {
  const detector = new PitchDetector(RATE, SIZE, { minHz: 70, maxHz: 1000 });

  it.each([98, 147, 220, 330, 440, 660])('finds a %i Hz hum', (hz) => {
    const result = detector.detect(tone(hz));
    expect(result.hz).not.toBeNull();
    expect(result.hz!).toBeCloseTo(hz, -0.5);
    expect(Math.abs(result.hz! - hz) / hz).toBeLessThan(0.02);
    expect(result.clarity).toBeGreaterThan(0.9);
  });

  it('stays on the fundamental when the second harmonic is stronger than it', () => {
    // The classic octave error: the loudest partial is not the fundamental.
    const result = detector.detect(tone(160, [0.4, 1, 0.6]));
    expect(result.hz).not.toBeNull();
    expect(Math.abs(result.hz! - 160) / 160).toBeLessThan(0.03);
  });

  it('reports no pitch for noise', () => {
    const clarities: number[] = [];
    for (let i = 0; i < 20; i++) clarities.push(detector.detect(noise()).clarity);
    const confident = clarities.filter((clarity) => clarity > 0.75).length;
    expect(confident).toBeLessThanOrEqual(1);
  });

  it('reports no pitch for silence', () => {
    expect(detector.detect(new Float32Array(SIZE)).hz).toBeNull();
  });
});

describe('hzToNote', () => {
  it('names concert A', () => {
    expect(hzToNote(440)).toEqual({ name: 'A', octave: 4, cents: 0 });
  });

  it('names middle C', () => {
    const note = hzToNote(261.63);
    expect(note.name).toBe('C');
    expect(note.octave).toBe(4);
    expect(Math.abs(note.cents)).toBeLessThan(2);
  });

  it('reports how flat a note is', () => {
    expect(hzToNote(440 * Math.pow(2, -25 / 1200)).cents).toBe(-25);
  });
});
