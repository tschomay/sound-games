import { describe, expect, it } from 'vitest';
import { TimbreClassifier } from '../timbre-class';

// Representative feature values, not measured — the same style as
// onset.test.ts feeding synthetic dB spectra rather than real audio. A clean
// tone sits at low zcr/flatness; a noise burst sits high on both; see
// ADR-0007 for where these numbers come from.
const TONE = { zcr: 0.02, flatness: 0.05 };
const NOISE = { zcr: 0.4, flatness: 0.6 };
const LOUD = 0.8;
const QUIET = 0.02;

describe('TimbreClassifier', () => {
  it('reads silence below the level floor regardless of shape', () => {
    const classifier = new TimbreClassifier();
    expect(classifier.classify(NOISE.zcr, NOISE.flatness, QUIET)).toBe('silence');
    expect(classifier.classify(TONE.zcr, TONE.flatness, QUIET)).toBe('silence');
  });

  it('reads a clean sustained tone as tonal', () => {
    const classifier = new TimbreClassifier();
    for (let i = 0; i < 10; i++) {
      expect(classifier.classify(TONE.zcr, TONE.flatness, LOUD)).toBe('tonal');
    }
  });

  it('reads a brief noise burst as transient, then promotes it to noisy once held', () => {
    const classifier = new TimbreClassifier();
    // A clap-length burst: well under the hold window.
    expect(classifier.classify(NOISE.zcr, NOISE.flatness, LOUD)).toBe('transient');
    expect(classifier.classify(NOISE.zcr, NOISE.flatness, LOUD)).toBe('transient');

    // Same burst-shaped signal kept going past the hold window — a shout, not
    // a clap that should have decayed by now.
    let last = 'transient';
    for (let i = 0; i < 6; i++) last = classifier.classify(NOISE.zcr, NOISE.flatness, LOUD);
    expect(last).toBe('noisy');
  });

  it('short-circuits to transient the instant a real onset fires', () => {
    const classifier = new TimbreClassifier();
    expect(classifier.classify(TONE.zcr, TONE.flatness, LOUD, true)).toBe('transient');
  });

  it('does not flicker between tonal and noisy on a boundary frame', () => {
    const classifier = new TimbreClassifier();
    for (let i = 0; i < 5; i++) classifier.classify(TONE.zcr, TONE.flatness, LOUD);

    // A single ambiguous frame — neither clearly tonal nor clearly burst-like.
    expect(classifier.classify(0.18, 0.3, LOUD)).toBe('tonal');

    // Back to a clean tone: still reads tonal, not knocked into noisy by the
    // one ambiguous frame in between.
    expect(classifier.classify(TONE.zcr, TONE.flatness, LOUD)).toBe('tonal');
  });

  it('recovers to transient/noisy classification after returning from silence', () => {
    const classifier = new TimbreClassifier();
    for (let i = 0; i < 6; i++) classifier.classify(NOISE.zcr, NOISE.flatness, LOUD); // now 'noisy'
    expect(classifier.classify(NOISE.zcr, NOISE.flatness, QUIET)).toBe('silence');
    // A fresh burst after silence starts counting from zero again.
    expect(classifier.classify(NOISE.zcr, NOISE.flatness, LOUD)).toBe('transient');
  });
});
