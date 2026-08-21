import { describe, expect, it, vi } from 'vitest';
import { CausalBeatInput, FileBeatInput } from '../beat-input';
import { CausalBeatTracker } from '../beat-causal';
import { NO_BEAT, type BeatReader, type BeatReading } from '../beat';

describe('CausalBeatInput', () => {
  it('passes t/onset/onsetStrength straight through to the tracker', () => {
    const tracker = new CausalBeatTracker();
    const spy = vi.spyOn(tracker, 'process');
    const input = new CausalBeatInput(tracker);

    input.advance(1.5, true, 0.8);

    expect(spy).toHaveBeenCalledWith(1.5, true, 0.8);
  });

  it('returns whatever the tracker reports', () => {
    const tracker = new CausalBeatTracker();
    const input = new CausalBeatInput(tracker);

    expect(input.advance(0, false, 0)).toEqual(tracker.read(0));
  });

  it('reset() delegates to the tracker', () => {
    const tracker = new CausalBeatTracker();
    const spy = vi.spyOn(tracker, 'reset');
    const input = new CausalBeatInput(tracker);

    input.reset();

    expect(spy).toHaveBeenCalledOnce();
  });

  it('defaults latencySeconds to 0, forwarding t unshifted', () => {
    const tracker = new CausalBeatTracker();
    const spy = vi.spyOn(tracker, 'process');
    const input = new CausalBeatInput(tracker);

    input.advance(1.5, true, 0.8);

    expect(spy).toHaveBeenCalledWith(1.5, true, 0.8);
  });

  it('subtracts the measured device latency from t before asking the tracker', () => {
    const tracker = new CausalBeatTracker();
    const spy = vi.spyOn(tracker, 'process');
    const input = new CausalBeatInput(tracker);

    input.advance(1.5, true, 0.8, 0.1);

    expect(spy).toHaveBeenCalledWith(1.4, true, 0.8);
  });
});

function fakeReader(reading: BeatReading = NO_BEAT): BeatReader & {
  read: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn().mockReturnValue(reading),
    reset: vi.fn(),
  };
}

describe('FileBeatInput', () => {
  it('reads at its own clock, ignoring the analyser clock and onset input entirely', () => {
    const reader = fakeReader();
    const input = new FileBeatInput(reader, () => 42.5);

    input.advance(1.5, true, 0.9);

    expect(reader.read).toHaveBeenCalledWith(42.5);
    expect(reader.read).toHaveBeenCalledTimes(1);
  });

  it('calls the clock function fresh on every advance, not once at construction', () => {
    let position = 0;
    const reader = fakeReader();
    const input = new FileBeatInput(reader, () => position);

    input.advance(0, false, 0);
    position = 12;
    input.advance(0, false, 0);

    expect(reader.read).toHaveBeenNthCalledWith(1, 0);
    expect(reader.read).toHaveBeenNthCalledWith(2, 12);
  });

  it('returns whatever the reader reports', () => {
    const reading: BeatReading = {
      bpm: 128,
      beatPhase: 0.3,
      onBeat: false,
      confidence: 0.9,
      beatIndex: 12,
    };
    const reader = fakeReader(reading);
    const input = new FileBeatInput(reader, () => 10);

    expect(input.advance(0, false, 0)).toBe(reading);
  });

  it('reset() delegates to the reader', () => {
    const reader = fakeReader();
    const input = new FileBeatInput(reader, () => 0);

    input.reset();

    expect(reader.reset).toHaveBeenCalledOnce();
  });

  it('defaults latencySeconds to 0, reading the clock unshifted', () => {
    const reader = fakeReader();
    const input = new FileBeatInput(reader, () => 42.5);

    input.advance(0, false, 0);

    expect(reader.read).toHaveBeenCalledWith(42.5);
  });

  it('subtracts the measured device latency from the file position before reading', () => {
    const reader = fakeReader();
    const input = new FileBeatInput(reader, () => 42.5);

    input.advance(0, false, 0, 0.1);

    expect(reader.read).toHaveBeenCalledWith(42.4);
  });
});
