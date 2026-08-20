import { describe, expect, it } from 'vitest';
import { CausalBeatTracker } from '../beat-causal';
import { BeatGridReader, analyseBeatGrid, type BeatGrid } from '../beat-offline';
import type { BeatReader, BeatReading } from '../beat';
import { clickTimes, clickTrack, mulberry32 } from './synthetic-audio';

/** The frame rate everything in this engine runs at. */
const FRAME = 1 / 60;

interface Run {
  readings: BeatReading[];
  times: number[];
  final: BeatReading;
}

/**
 * Drive a tracker frame by frame over a synthetic onset stream, exactly as the
 * game loop will: one `process` per frame, `onset` true on the frame an onset
 * time falls into.
 */
function drive(tracker: CausalBeatTracker, onsetTimes: number[], duration: number): Run {
  const readings: BeatReading[] = [];
  const times: number[] = [];
  let next = 0;
  for (let t = 0; t < duration; t += FRAME) {
    let onset = false;
    while (next < onsetTimes.length && onsetTimes[next] <= t) {
      onset = true;
      next++;
    }
    readings.push(tracker.process(t, onset, 1));
    times.push(t);
  }
  return { readings, times, final: readings[readings.length - 1] };
}

/** Onset times at an exact tempo. */
function pulse(bpm: number, from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = from; t < to; t += 60 / bpm) out.push(t);
  return out;
}

/** The reading at a given moment of a run. */
function at(run: Run, seconds: number): BeatReading {
  return run.readings[Math.min(run.readings.length - 1, Math.round(seconds / FRAME))];
}

describe('CausalBeatTracker', () => {
  it('reports no tempo before it has heard anything', () => {
    const tracker = new CausalBeatTracker();
    expect(tracker.read(0)).toEqual({
      bpm: null,
      beatPhase: null,
      onBeat: false,
      confidence: 0,
      beatIndex: null,
    });
  });

  it('reports no tempo through twenty seconds of silence', () => {
    const run = drive(new CausalBeatTracker(), [], 20);
    for (const reading of run.readings) {
      expect(reading.bpm).toBeNull();
      expect(reading.confidence).toBe(0);
      expect(reading.onBeat).toBe(false);
    }
  });

  it('finds a steady tempo, loosely, across the range', () => {
    // Loosely on purpose: this is the mushy tracker. The tolerance it is held to
    // here is an order of magnitude wider than the offline one's.
    for (const bpm of [70, 92, 128, 174]) {
      const run = drive(new CausalBeatTracker(), pulse(bpm, 0.5, 30), 30);
      expect(run.final.bpm).not.toBeNull();
      expect(Math.abs((run.final.bpm as number) - bpm)).toBeLessThan(3);
    }
  });

  it('locks on within a few seconds, not instantly', () => {
    const run = drive(new CausalBeatTracker(), pulse(128, 0.5, 30), 30);
    // Nothing at all for the first couple of beats — four onsets is the minimum
    // before it will name a tempo, and four onsets at 128 BPM take ~2s.
    expect(at(run, 1).bpm).toBeNull();
    expect(at(run, 5).bpm).not.toBeNull();
    expect(Math.abs((at(run, 5).bpm as number) - 128)).toBeLessThan(3);
  });

  it('earns its confidence rather than starting with it', () => {
    const run = drive(new CausalBeatTracker(), pulse(128, 0.5, 30), 30);
    expect(at(run, 1).confidence).toBe(0);
    expect(at(run, 4).confidence).toBeGreaterThan(0);
    expect(at(run, 4).confidence).toBeLessThan(0.8);
    expect(at(run, 12).confidence).toBeGreaterThan(0.8);
    // ...and never claims more than it has.
    for (const reading of run.readings) expect(reading.confidence).toBeLessThanOrEqual(1);
  });

  it('predicts beats that land on the real ones', () => {
    const bpm = 128;
    const truth = pulse(bpm, 0.5, 30);
    const run = drive(new CausalBeatTracker(), truth, 30);

    let fired = 0;
    let worst = 0;
    for (let i = 0; i < run.readings.length; i++) {
      if (!run.readings[i].onBeat) continue;
      fired++;
      if (run.times[i] < 10) continue; // only judge it once locked on
      let nearest = Infinity;
      for (const beat of truth) nearest = Math.min(nearest, Math.abs(beat - run.times[i]));
      worst = Math.max(worst, nearest);
    }
    // One prediction per beat, minus the handful before it had a tempo at all.
    expect(fired).toBeGreaterThan(truth.length - 8);
    expect(fired).toBeLessThanOrEqual(truth.length);
    expect(worst).toBeLessThan(0.04);
  });

  it('keeps beatPhase near zero at the beat and near one just before it', () => {
    const period = 60 / 128;
    const run = drive(new CausalBeatTracker(), pulse(128, 0.5, 30), 30);
    const onBeat = at(run, 20.0);
    expect(onBeat.beatPhase).not.toBeNull();
    // Sample a whole beat's worth of frames and check the phase sweeps 0..1 once.
    const start = Math.round(20 / FRAME);
    const phases: number[] = [];
    for (let i = start; i < start + Math.round(period / FRAME); i++) {
      phases.push(run.readings[i].beatPhase as number);
    }
    const min = Math.min(...phases);
    const max = Math.max(...phases);
    expect(min).toBeLessThan(0.1);
    expect(max).toBeGreaterThan(0.9);
  });

  it('adapts to a tempo change, slowly', () => {
    const onsets = pulse(120, 0.5, 20).concat(pulse(150, 20, 45));
    const run = drive(new CausalBeatTracker(), onsets, 45);

    expect(Math.abs((at(run, 19).bpm as number) - 120)).toBeLessThan(3);
    // Not immediately: a couple of beats after the change it is still on the old
    // tempo, which is the correct behaviour, not a bug.
    expect(Math.abs((at(run, 21).bpm as number) - 120)).toBeLessThan(3);
    expect(Math.abs((at(run, 35).bpm as number) - 150)).toBeLessThan(3);
    // And it recovers its confidence once it has settled again.
    expect(at(run, 40).confidence).toBeGreaterThan(0.7);
  });

  it('forgets a tempo when the music stops', () => {
    const run = drive(new CausalBeatTracker(), pulse(128, 0.5, 20), 40);
    expect(at(run, 19).bpm).not.toBeNull();
    // Still coasting a beat or two after the last onset...
    expect(at(run, 22).bpm).not.toBeNull();
    // ...but not indefinitely.
    expect(at(run, 30).bpm).toBeNull();
    expect(at(run, 30).confidence).toBe(0);
  });

  it('starts again cleanly after the music comes back', () => {
    const onsets = pulse(128, 0.5, 20).concat(pulse(96, 40, 65));
    const run = drive(new CausalBeatTracker(), onsets, 65);
    expect(at(run, 35).bpm).toBeNull();
    expect(Math.abs((at(run, 60).bpm as number) - 96)).toBeLessThan(3);
  });

  it('survives human-sized timing jitter', () => {
    const random = mulberry32(5);
    const jittered = pulse(128, 0.5, 30).map((t) => t + (random() * 2 - 1) * 0.015);
    const run = drive(new CausalBeatTracker(), jittered, 30);
    expect(Math.abs((run.final.bpm as number) - 128)).toBeLessThan(4);
  });

  it('holds the beat rather than the eighths when both have onsets', () => {
    const beats = pulse(128, 0.5, 30);
    const eighths = pulse(128, 0.5 + 60 / 128 / 2, 30);
    const run = drive(new CausalBeatTracker(), [...beats, ...eighths].sort((a, b) => a - b), 30);
    // 256 BPM is outside the tempo range, so the only way this can go wrong is
    // by settling on 64 or on something unrelated.
    expect(Math.abs((run.final.bpm as number) - 128)).toBeLessThan(4);
    // But it is measurably less sure of itself than on the unambiguous version,
    // because half a beat out would explain the onsets just as well.
    const clean = drive(new CausalBeatTracker(), beats, 30);
    expect(run.final.confidence).toBeLessThan(clean.final.confidence);
  });

  it('reset clears everything it had learned', () => {
    const tracker = new CausalBeatTracker();
    drive(tracker, pulse(128, 0.5, 20), 20);
    tracker.reset();
    expect(tracker.read(20).bpm).toBeNull();
    expect(tracker.read(20).confidence).toBe(0);
  });

  it('honours a narrowed tempo range', () => {
    const tracker = new CausalBeatTracker({ minBpm: 140, maxBpm: 220 });
    // A 90 BPM pulse cannot be reported as 90, so it comes back at 180.
    const run = drive(tracker, pulse(90, 0.5, 30), 30);
    expect(Math.abs((run.final.bpm as number) - 180)).toBeLessThan(4);
  });
});

describe('the two trackers against the same signal', () => {
  it('agree on the tempo, and the offline one is far more precise', () => {
    // The claim ADR-0010 makes, tested rather than asserted: both find 128 BPM
    // on identical material, but the offline pass is exact to a fraction of a
    // BPM where the causal one is only close.
    const options = { bpm: 128, durationSeconds: 30 };
    const audio = clickTrack(options);

    const grid = analyseBeatGrid(audio);
    const causal = drive(new CausalBeatTracker(), clickTimes(options), 30).final;

    expect(grid).not.toBeNull();
    expect(causal.bpm).not.toBeNull();

    const offlineError = Math.abs((grid as { bpm: number }).bpm - 128);
    const causalError = Math.abs((causal.bpm as number) - 128);
    expect(offlineError).toBeLessThan(0.1);
    expect(causalError).toBeLessThan(3);
    expect(offlineError).toBeLessThan(causalError);
  }, 20000);

  it('produce readings of the same shape, so a caller need not know which it holds', () => {
    const options = { bpm: 128, durationSeconds: 30 };
    const grid = analyseBeatGrid(clickTrack(options));
    expect(grid).not.toBeNull();

    const readers: BeatReader[] = [
      new BeatGridReader(grid as BeatGrid),
      new CausalBeatTracker(),
    ];
    const fields = ['beatIndex', 'beatPhase', 'bpm', 'confidence', 'onBeat'];
    for (const reader of readers) {
      // Both are ticked the same way and answer with the same keys; only the
      // meaning of `now` differs (track position versus analyser clock).
      expect(Object.keys(reader.read(1)).sort()).toEqual(fields);
      reader.reset();
      expect(Object.keys(reader.read(1)).sort()).toEqual(fields);
    }
  }, 20000);
});
