import { describe, expect, it } from 'vitest';
import { Analyser, zeroCrossingRate } from '../analyser';
import { OutputBus } from '../output';
import { FakeAudioContext, fakeAudioSource } from './fake-audio-context';

const fakeBuffer = {} as AudioBuffer;

function sineWave(samples: number, cyclesPerBuffer: number): Float32Array {
  const wave = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    wave[i] = Math.sin((2 * Math.PI * cyclesPerBuffer * i) / samples);
  }
  return wave;
}

/** Deterministic "noise": no periodic structure, unlike sineWave above. */
function noiseBurst(samples: number, seed = 1): Float32Array {
  const wave = new Float32Array(samples);
  let state = seed;
  for (let i = 0; i < samples; i++) {
    // A tiny xorshift PRNG — deterministic across runs, unlike Math.random(),
    // so this test can't flake.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    wave[i] = (state % 1000) / 1000;
  }
  return wave;
}

describe('zeroCrossingRate', () => {
  it('reads low for a clean sine wave', () => {
    // 20 cycles across 2048 samples — comparable to a ~200-300Hz tone at a
    // typical 44.1/48kHz sample rate and this codebase's default fftSize.
    const zcr = zeroCrossingRate(sineWave(2048, 20));
    expect(zcr).toBeGreaterThan(0);
    expect(zcr).toBeLessThan(0.05);
  });

  it('reads high for a noise burst', () => {
    const zcr = zeroCrossingRate(noiseBurst(2048));
    expect(zcr).toBeGreaterThan(0.3);
  });

  it('separates the two clearly, same as the transient/tonal classifier relies on', () => {
    const toneZcr = zeroCrossingRate(sineWave(2048, 20));
    const noiseZcr = zeroCrossingRate(noiseBurst(2048));
    expect(noiseZcr).toBeGreaterThan(toneZcr * 5);
  });

  it('is silent (0) for a flat DC signal', () => {
    expect(zeroCrossingRate(new Float32Array(512).fill(0.3))).toBe(0);
  });
});

/**
 * End-to-end demonstration of ADR-0005: the output bus plays an SFX, and the
 * analyser it's wired into reports the frame as gated — with onset forced off
 * and level frozen — for exactly the suppression window, no longer.
 */
describe('Analyser gating', () => {
  it('is not gated before anything plays', () => {
    const context = new FakeAudioContext();
    const source = fakeAudioSource(context);
    const output = new OutputBus(context as unknown as AudioContext);
    const analyser = new Analyser(source, { suppression: output });

    expect(analyser.read().gated).toBe(false);
  });

  it('forces onset off and freezes level while the output bus is playing an SFX', () => {
    const context = new FakeAudioContext();
    const source = fakeAudioSource(context);
    const output = new OutputBus(context as unknown as AudioContext);
    const analyser = new Analyser(source, { suppression: output });

    // A quiet, steady room: read once so the frozen level has something real
    // to hold, and prime the onset detector like a live session would.
    context.analyserNode.amplitude = 0.02;
    context.analyserNode.spectrumDb = -70;
    const before = analyser.read();
    expect(before.gated).toBe(false);
    const quietLevel = before.level;

    output.playSfx(fakeBuffer, { suppressMs: 200 });

    // The "SFX" itself is loud and broadband — exactly what would otherwise
    // trip the onset detector.
    context.analyserNode.amplitude = 0.9;
    context.analyserNode.spectrumDb = -10;
    context.advance(0.05);
    const during = analyser.read();

    expect(during.gated).toBe(true);
    expect(during.onset).toBe(false);
    expect(during.onsetStrength).toBe(0);
    // Frozen at the pre-SFX level, not reading the loud SFX itself.
    expect(during.level).toBeCloseTo(quietLevel, 5);

    // Past the suppression window, back to quiet: gating lifts.
    context.analyserNode.amplitude = 0.02;
    context.analyserNode.spectrumDb = -70;
    context.advance(0.2); // 0.25s since the SFX started, past its 200ms window
    const after = analyser.read();

    expect(after.gated).toBe(false);
  });
});

/**
 * FakeAnalyserNode's time domain is a constant amplitude — no real waveform —
 * so it cannot exercise the classifier's shape logic (that's what
 * timbre-class.test.ts and the zeroCrossingRate tests above are for). This
 * only checks the wiring: `zcr`/`timbreClass` land on the Frame, respond to
 * `level`, and get suppressed alongside `onset` while gated.
 */
describe('Analyser timbre classification wiring', () => {
  it('reads silence with zero zcr on a near-silent room', () => {
    const context = new FakeAudioContext();
    const source = fakeAudioSource(context);
    const analyser = new Analyser(source);

    context.analyserNode.amplitude = 0;
    context.analyserNode.spectrumDb = -100;
    const frame = analyser.read();

    expect(frame.zcr).toBe(0);
    expect(frame.timbreClass).toBe('silence');
  });

  it('classifies a loud steady signal as something other than silence', () => {
    const context = new FakeAudioContext();
    const source = fakeAudioSource(context);
    const analyser = new Analyser(source);

    context.analyserNode.amplitude = 0.9;
    context.analyserNode.spectrumDb = -10;
    const frame = analyser.read();

    expect(frame.timbreClass).not.toBe('silence');
  });

  it('forces timbreClass to silence while gated, same as onset', () => {
    const context = new FakeAudioContext();
    const source = fakeAudioSource(context);
    const output = new OutputBus(context as unknown as AudioContext);
    const analyser = new Analyser(source, { suppression: output });

    context.analyserNode.amplitude = 0.9;
    context.analyserNode.spectrumDb = -10;
    output.playSfx(fakeBuffer, { suppressMs: 200 });
    context.advance(0.05);
    const frame = analyser.read();

    expect(frame.gated).toBe(true);
    expect(frame.timbreClass).toBe('silence');
  });
});
