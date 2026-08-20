import { describe, expect, it } from 'vitest';
import {
  BeatGridReader,
  analyseBeatGrid,
  analyseEnvelope,
  computeOnsetEnvelope,
  type BeatGrid,
} from '../beat-offline';
import {
  clickTimes,
  clickTrack,
  decodedAudio,
  noiseAudio,
  silentAudio,
  type ClickTrackOptions,
} from './synthetic-audio';

/** Largest distance from any true click to the nearest grid beat, in seconds. */
function worstBeatError(grid: BeatGrid, truth: number[]): number {
  let worst = 0;
  for (const time of truth) {
    let nearest = Infinity;
    for (const beat of grid.beats) nearest = Math.min(nearest, Math.abs(beat - time));
    worst = Math.max(worst, nearest);
  }
  return worst;
}

function analyse(options: ClickTrackOptions): BeatGrid {
  const grid = analyseBeatGrid(clickTrack(options));
  expect(grid).not.toBeNull();
  return grid as BeatGrid;
}

describe('computeOnsetEnvelope', () => {
  it('peaks at the clicks and is quiet between them', () => {
    const options = { bpm: 120, durationSeconds: 6 };
    const envelope = computeOnsetEnvelope(clickTrack(options));
    const frameAt = (seconds: number): number =>
      Math.round((seconds - envelope.firstFrameSeconds) / envelope.hopSeconds);

    for (const click of clickTimes(options)) {
      let onClick = 0;
      // A click's flux lands within a window of the attributed frame, not exactly
      // on it — the STFT window is 23ms wide.
      for (let i = frameAt(click) - 2; i <= frameAt(click) + 2; i++) {
        onClick = Math.max(onClick, envelope.values[i] ?? 0);
      }
      // Halfway to the next click there should be nothing at all.
      const between = envelope.values[frameAt(click + 0.25)] ?? 0;
      expect(onClick).toBeGreaterThan(between * 10);
    }
  });

  it('does not report a false onset in its first frame', () => {
    // Every bin appears at once in frame 0 for want of a predecessor; counting
    // that would anchor every grid to the start of the file.
    expect(computeOnsetEnvelope(clickTrack({ bpm: 120, durationSeconds: 6 })).values[0]).toBe(0);
  });
});

describe('analyseBeatGrid', () => {
  it('recovers an exact tempo from a clean click track', () => {
    for (const bpm of [70, 92, 128, 174]) {
      const grid = analyse({ bpm, durationSeconds: 20 });
      expect(grid.bpm).toBeCloseTo(bpm, 1);
    }
  });

  it('anchors the grid to the clicks, not to the start of the file', () => {
    const options = { bpm: 128, durationSeconds: 20, startSeconds: 1.3 };
    const grid = analyse(options);
    // Every click has a beat on it. The grid extends backwards past the first
    // click to the head of the file, so the check is per-click, not per-beat.
    expect(worstBeatError(grid, clickTimes(options))).toBeLessThan(0.02);
  });

  it('holds its tempo across a long track', () => {
    // The precision claim in ADR-0010: error accumulates over the whole file, so
    // a three-minute track is where a wrong period would show up as drift.
    const options = { bpm: 128, durationSeconds: 180 };
    const grid = analyse(options);
    expect(grid.bpm).toBeCloseTo(128, 1);
    expect(worstBeatError(grid, clickTimes(options))).toBeLessThan(0.02);
  }, 30000);

  it('survives human-sized timing jitter', () => {
    const options = { bpm: 128, durationSeconds: 20, jitterSeconds: 0.012 };
    const grid = analyse(options);
    expect(Math.abs(grid.bpm - 128)).toBeLessThan(1);
  });

  it('reads a kick-and-hat pattern at the beat, not at the eighths or the half', () => {
    // The case the autocorrelation cannot settle on its own: onsets twice a beat,
    // so the beat, half the beat and one-and-a-half beats all look periodic.
    const grid = analyse({
      bpm: 128,
      durationSeconds: 20,
      offbeatAt: 0.5,
      offbeatAmplitude: 0.5,
    });
    expect(grid.bpm).toBeCloseTo(128, 0);
  });

  it('reports no grid for silence', () => {
    expect(analyseBeatGrid(silentAudio(20))).toBeNull();
  });

  it('reports no grid for unstructured noise', () => {
    expect(analyseBeatGrid(noiseAudio(20))).toBeNull();
  });

  it('reports no grid for a track too short to argue about', () => {
    expect(analyseBeatGrid(clickTrack({ bpm: 128, durationSeconds: 2 }))).toBeNull();
  });

  it('is confident about a click track and less so about one with offbeats', () => {
    const clean = analyse({ bpm: 128, durationSeconds: 20 });
    const busy = analyse({ bpm: 128, durationSeconds: 20, offbeatAt: 0.5, offbeatAmplitude: 0.5 });
    expect(clean.confidence).toBeGreaterThan(0.9);
    expect(busy.confidence).toBeLessThan(clean.confidence);
    expect(busy.confidence).toBeGreaterThan(0.4);
  });

  it('works at any sample rate', () => {
    for (const sampleRate of [22050, 44100, 48000]) {
      expect(analyse({ bpm: 128, durationSeconds: 20, sampleRate }).bpm).toBeCloseTo(128, 1);
    }
  });

  it('reads a two-channel buffer as one', () => {
    const stereo = clickTrack({ bpm: 128, durationSeconds: 20 });
    const both = { ...stereo, numberOfChannels: 2 };
    expect(analyseBeatGrid(both)?.bpm).toBeCloseTo(128, 1);
  });
});

describe('analyseEnvelope', () => {
  /** A hand-built envelope: a spike every `period` seconds, nothing between. */
  function spikes(period: number, duration: number, hopSeconds = 0.01) {
    const values = new Float32Array(Math.round(duration / hopSeconds));
    for (let t = 0.4; t < duration; t += period) values[Math.round(t / hopSeconds)] = 1;
    return { values, hopSeconds, firstFrameSeconds: 0, duration };
  }

  it('finds the tempo in an envelope built by hand', () => {
    // The tempo stage on its own, with no audio and no STFT involved.
    const grid = analyseEnvelope(spikes(60 / 100, 30));
    expect(grid?.bpm).toBeCloseTo(100, 1);
    expect(grid?.offset).toBeCloseTo(0.4, 2);
  });

  it('respects a narrowed tempo range', () => {
    // Forced to look above 150, a 100 BPM envelope is read at its double rather
    // than reported at a tempo outside the range it was asked for.
    const grid = analyseEnvelope(spikes(60 / 100, 30), { minBpm: 150, maxBpm: 250 });
    expect(grid?.bpm).toBeCloseTo(200, 0);
  });

  it('reports nothing for an empty envelope', () => {
    expect(
      analyseEnvelope({
        values: new Float32Array(3000),
        hopSeconds: 0.01,
        firstFrameSeconds: 0,
        duration: 30,
      }),
    ).toBeNull();
  });

  it('reports nothing for audio with no samples', () => {
    expect(analyseBeatGrid(decodedAudio(new Float32Array(0), 44100))).toBeNull();
  });
});

describe('BeatGridReader', () => {
  const grid: BeatGrid = {
    bpm: 120,
    period: 0.5,
    offset: 0.25,
    beats: [0.25, 0.75, 1.25, 1.75, 2.25],
    confidence: 0.8,
    duration: 2.5,
  };

  it('interpolates phase between beats', () => {
    const reader = new BeatGridReader(grid);
    expect(reader.read(0.25).beatPhase).toBeCloseTo(0, 6);
    expect(reader.read(0.375).beatPhase).toBeCloseTo(0.25, 6);
    expect(reader.read(0.5).beatPhase).toBeCloseTo(0.5, 6);
    expect(reader.read(0.74).beatPhase).toBeCloseTo(0.98, 6);
  });

  it('counts beats from the first one, and backwards before it', () => {
    const reader = new BeatGridReader(grid);
    expect(reader.read(0.3).beatIndex).toBe(0);
    expect(reader.read(1.3).beatIndex).toBe(2);
    reader.reset();
    expect(reader.read(0.1).beatIndex).toBe(-1);
  });

  it('fires onBeat exactly once per beat when stepped at a frame rate', () => {
    const reader = new BeatGridReader(grid);
    let fired = 0;
    let worstLateness = 0;
    for (let t = 0; t < 2.5; t += 1 / 60) {
      if (!reader.read(t).onBeat) continue;
      fired++;
      let nearest = Infinity;
      for (const beat of grid.beats) nearest = Math.min(nearest, Math.abs(beat - t));
      worstLateness = Math.max(worstLateness, nearest);
    }
    expect(fired).toBe(grid.beats.length);
    expect(worstLateness).toBeLessThan(1 / 60);
  });

  it('does not fire onBeat when the position jumps, in either direction', () => {
    const reader = new BeatGridReader(grid);
    reader.read(0.3);
    expect(reader.read(2.3).onBeat).toBe(false);
    expect(reader.read(0.3).onBeat).toBe(false);
    // ...and picks straight back up once playback is running normally again.
    expect(reader.read(0.55).onBeat).toBe(false);
    expect(reader.read(0.8).onBeat).toBe(true);
  });

  it('reports the whole-file confidence unchanged at every position', () => {
    const reader = new BeatGridReader(grid);
    expect(reader.read(0.1).confidence).toBe(0.8);
    expect(reader.read(2.4).confidence).toBe(0.8);
  });
});
