import { describe, expect, it } from 'vitest';
import { OutputBus } from '../output';
import { FakeAudioContext } from './fake-audio-context';

const fakeBuffer = {} as AudioBuffer;

describe('OutputBus', () => {
  it('is not suppressed before anything plays', () => {
    const context = new FakeAudioContext();
    const bus = new OutputBus(context as unknown as AudioContext);
    expect(bus.isSuppressed()).toBe(false);
  });

  it('opens the suppression window for the requested duration on playSfx', () => {
    const context = new FakeAudioContext();
    const bus = new OutputBus(context as unknown as AudioContext);

    bus.playSfx(fakeBuffer, { suppressMs: 200 });
    expect(bus.isSuppressed()).toBe(true);

    context.advance(0.19);
    expect(bus.isSuppressed()).toBe(true);

    context.advance(0.02); // 0.21s total, past the 200ms window
    expect(bus.isSuppressed()).toBe(false);
  });

  it('uses a sane default window when none is given', () => {
    const context = new FakeAudioContext();
    const bus = new OutputBus(context as unknown as AudioContext);

    bus.playSfx(fakeBuffer);
    context.advance(0.05);
    expect(bus.isSuppressed()).toBe(true);

    context.advance(1);
    expect(bus.isSuppressed()).toBe(false);
  });

  it('extends rather than shortens an overlapping SFX', () => {
    const context = new FakeAudioContext();
    const bus = new OutputBus(context as unknown as AudioContext);

    bus.playSfx(fakeBuffer, { suppressMs: 100 }); // alone would close at t=0.1
    context.advance(0.05); // t=0.05
    bus.playSfx(fakeBuffer, { suppressMs: 100 }); // alone would close at t=0.15

    context.advance(0.07); // t=0.12: past the first SFX's own window...
    expect(bus.isSuppressed()).toBe(true); // ...but the second one still covers it

    context.advance(0.05); // t=0.17: past both
    expect(bus.isSuppressed()).toBe(false);
  });

  it('suppressFor opens the window without playing anything', () => {
    const context = new FakeAudioContext();
    const bus = new OutputBus(context as unknown as AudioContext);

    bus.suppressFor(100);
    expect(bus.isSuppressed()).toBe(true);
    context.advance(0.11);
    expect(bus.isSuppressed()).toBe(false);
  });

  it('briefly gates around music starting and stopping, not the whole loop', () => {
    const context = new FakeAudioContext();
    const bus = new OutputBus(context as unknown as AudioContext);

    bus.startMusic(fakeBuffer);
    expect(bus.isSuppressed()).toBe(true);

    context.advance(1); // well past the attack window; the loop keeps playing
    expect(bus.isSuppressed()).toBe(false);

    bus.stopMusic();
    expect(bus.isSuppressed()).toBe(true);
  });
});
