import { describe, expect, it } from 'vitest';
import { OnsetDetector } from '../onset';

const BINS = 1024;
const NYQUIST = 24000;

function spectrum(db: number, jitter = 0.3): Float32Array {
  const values = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) values[i] = db + (Math.random() * 2 - 1) * jitter;
  return values;
}

/** Feed `frames` of room tone, starting at t=0 and advancing 1/60 s a frame. */
function settle(detector: OnsetDetector, frames: number, db = -70): number {
  let t = 0;
  for (let i = 0; i < frames; i++) {
    detector.process(spectrum(db), t);
    t += 1 / 60;
  }
  return t;
}

describe('OnsetDetector', () => {
  it('does not fire on room tone', () => {
    const detector = new OnsetDetector(BINS, NYQUIST);
    let t = 0;
    let fired = 0;
    for (let i = 0; i < 200; i++) {
      if (detector.process(spectrum(-70), t).onset) fired++;
      t += 1 / 60;
    }
    expect(fired).toBe(0);
  });

  it('fires on a broadband transient', () => {
    const detector = new OnsetDetector(BINS, NYQUIST);
    const t = settle(detector, 30);
    expect(detector.process(spectrum(-25), t).onset).toBe(true);
  });

  it('does not fire twice for one clap', () => {
    const detector = new OnsetDetector(BINS, NYQUIST);
    let t = settle(detector, 30);

    expect(detector.process(spectrum(-25), t).onset).toBe(true);
    t += 1 / 60;
    // Still loud on the next frame — the tail of the same clap, not a new one.
    expect(detector.process(spectrum(-24), t).onset).toBe(false);
  });

  it('fires again once the refractory period has passed', () => {
    const detector = new OnsetDetector(BINS, NYQUIST);
    let t = settle(detector, 30);
    expect(detector.process(spectrum(-25), t).onset).toBe(true);

    t = settle(detector, 30, -70) + t;
    expect(detector.process(spectrum(-25), t).onset).toBe(true);
  });

  it('ignores a hum swelling gradually', () => {
    const detector = new OnsetDetector(BINS, NYQUIST);
    let t = settle(detector, 30, -70);
    let fired = 0;
    for (let i = 0; i < 60; i++) {
      // Half a decibel a frame: loud within a second, but never a transient.
      if (detector.process(spectrum(-70 + i * 0.5), t).onset) fired++;
      t += 1 / 60;
    }
    expect(fired).toBe(0);
  });
});
