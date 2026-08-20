import { describe, expect, it } from 'vitest';
import { Analyser } from '../analyser';
import { OutputBus } from '../output';
import { FakeAudioContext, fakeAudioSource } from './fake-audio-context';

const fakeBuffer = {} as AudioBuffer;

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
