import { describe, expect, it } from 'vitest';
import {
  LatencyTrial,
  LoopbackLatencyMeasurement,
  createClickBuffer,
  summariseLatency,
} from '../latency';
import { OnsetDetector } from '../onset';
import { OutputBus } from '../output';
import { FakeAudioContext } from './fake-audio-context';

describe('LatencyTrial', () => {
  it('reports null before begin() is ever called', () => {
    const trial = new LatencyTrial();
    expect(trial.isRunning).toBe(false);
    expect(trial.sample(1, false)).toBeNull();
  });

  it('measures the gap between begin() and the onset arriving', () => {
    const trial = new LatencyTrial(1);
    trial.begin(10);
    expect(trial.isRunning).toBe(true);
    expect(trial.sample(10.03, false)).toBeNull(); // still waiting
    expect(trial.sample(10.05, true)).toBeCloseTo(0.05, 10);
    expect(trial.isRunning).toBe(false); // consumed, not still running
  });

  it('reports a timeout once the deadline passes with nothing detected', () => {
    const trial = new LatencyTrial(0.1);
    trial.begin(0);
    expect(trial.sample(0.05, false)).toBeNull();
    expect(trial.sample(0.1, false)).toBe('timeout');
    expect(trial.isRunning).toBe(false);
  });

  it('can be reused for a second trial after begin() is called again', () => {
    const trial = new LatencyTrial(1);
    trial.begin(0);
    trial.sample(0.02, true);
    trial.begin(5);
    expect(trial.sample(5.01, true)).toBeCloseTo(0.01, 10);
  });
});

describe('summariseLatency', () => {
  it('reports null with fewer than minSamples clean measurements', () => {
    expect(summariseLatency([0.05], 2)).toBeNull();
    expect(summariseLatency([], 2)).toBeNull();
  });

  it('is the middle value for an odd count', () => {
    expect(summariseLatency([0.05, 0.03, 0.04], 2)).toBe(0.04);
  });

  it('averages the two middle values for an even count', () => {
    expect(summariseLatency([0.05, 0.03], 2)).toBeCloseTo(0.04, 10);
  });

  it('is not dragged by a single outlier the way a mean would be', () => {
    const median = summariseLatency([0.03, 0.031, 0.029, 0.03, 0.5], 2);
    expect(median).toBeLessThan(0.1);
  });
});

describe('createClickBuffer', () => {
  it('sizes the buffer from toneSeconds and the context sample rate', () => {
    const context = new FakeAudioContext();
    const buffer = createClickBuffer(context, { toneSeconds: 0.02 });
    expect(buffer.length).toBe(Math.round(48000 * 0.02));
  });

  it('envelopes to (near) silence at both edges and has real signal in the middle', () => {
    const context = new FakeAudioContext();
    const buffer = createClickBuffer(context, { toneSeconds: 0.03, toneHz: 1000 });
    const data = buffer.getChannelData(0);
    expect(Math.abs(data[0])).toBeLessThan(0.05);
    expect(Math.abs(data[data.length - 1])).toBeLessThan(0.05);
    // A single sample near the middle can coincidentally land on a zero
    // crossing of the tone itself, so check the energy of a middle span
    // instead of one instant.
    const from = Math.floor(data.length / 3);
    const to = Math.floor((2 * data.length) / 3);
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(data[i]));
    expect(peak).toBeGreaterThan(0.1);
  });
});

const BIN_COUNT = 64;
const NYQUIST = 24000;
const quiet = new Float32Array(BIN_COUNT).fill(-100);
const loud = new Float32Array(BIN_COUNT).fill(-10);

describe('LoopbackLatencyMeasurement', () => {
  it('measures the real gap between playing a click and hearing its onset', () => {
    const context = new FakeAudioContext();
    const output = new OutputBus(context as unknown as AudioContext);
    const detector = new OnsetDetector(BIN_COUNT, NYQUIST);
    const buffer = createClickBuffer(context, {});
    const measurement = new LoopbackLatencyMeasurement(output, buffer, detector, {
      trials: 1,
      minSamples: 1,
      warmupSeconds: 0,
      timeoutSeconds: 1,
      gapSeconds: 1,
    });

    // warmupSeconds: 0 means the very first step() both primes the onset
    // detector's history *and* starts the trial (plays the click) at t=0.
    let now = 0;
    const dt = 0.01;
    for (let i = 0; i < 9; i++) {
      measurement.step(now, quiet);
      now += dt;
    }
    expect(measurement.finished).toBe(false);

    // The "click" arrives — a real transient in the raw spectrum — 90ms after
    // it was scheduled.
    measurement.step(now, loud);

    expect(measurement.finished).toBe(true);
    expect(measurement.result).toBeCloseTo(now, 5);
  });

  it('reports null when every trial times out with nothing heard', () => {
    const context = new FakeAudioContext();
    const output = new OutputBus(context as unknown as AudioContext);
    const detector = new OnsetDetector(BIN_COUNT, NYQUIST);
    const buffer = createClickBuffer(context, {});
    const measurement = new LoopbackLatencyMeasurement(output, buffer, detector, {
      trials: 1,
      minSamples: 1,
      warmupSeconds: 0,
      timeoutSeconds: 0.05,
      gapSeconds: 0.1,
    });

    let now = 0;
    for (let i = 0; i < 20; i++) {
      measurement.step(now, quiet); // never hears anything
      now += 0.01;
    }

    expect(measurement.finished).toBe(true);
    expect(measurement.result).toBeNull();
  });

  it('aggregates several clean trials rather than stopping at the first', () => {
    const context = new FakeAudioContext();
    const output = new OutputBus(context as unknown as AudioContext);
    const detector = new OnsetDetector(BIN_COUNT, NYQUIST);
    const buffer = createClickBuffer(context, {});
    const measurement = new LoopbackLatencyMeasurement(output, buffer, detector, {
      trials: 2,
      minSamples: 2,
      warmupSeconds: 0,
      timeoutSeconds: 1,
      gapSeconds: 0.5,
    });

    let now = 0;
    const dt = 0.01;
    // Warm up, then let the first click arrive.
    for (let i = 0; i < 9; i++) {
      measurement.step(now, quiet);
      now += dt;
    }
    measurement.step(now, loud); // first trial: heard after ~0.09s
    now += dt;
    expect(measurement.finished).toBe(false); // one more trial to go

    // Coast in silence until the second trial's click is due, then let it
    // arrive too, a different gap later.
    while (!measurement.finished && now < 10) {
      measurement.step(now, quiet);
      now += dt;
      if (now > 0.75) {
        measurement.step(now, loud);
        break;
      }
    }

    expect(measurement.finished).toBe(true);
    expect(measurement.progress.trialsRun).toBe(2);
    expect(measurement.result).not.toBeNull();
  });
});
