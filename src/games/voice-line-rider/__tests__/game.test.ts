import { describe, expect, it } from 'vitest';
import { VoiceLineRider, DEFAULT_CONFIG, MAX_SCORE, type Config, type Input } from '../game';

const DT = 1 / 60;

const silence: Input = { voiced: false, pitchNorm: null };
const humming = (pitchNorm: number): Input => ({ voiced: true, pitchNorm });

function run(game: VoiceLineRider, input: Input, frames: number): void {
  for (let i = 0; i < frames; i++) game.update(DT, input);
}

/** A quick config for tests that only care about the recording half — a
 *  four-second capture at real time would make every test slow. */
const FAST_RECORD: Config = { ...DEFAULT_CONFIG, recordDuration: 1, sampleInterval: 0.1 };

describe('VoiceLineRider recording', () => {
  it('waits for a sound before recording starts', () => {
    const game = new VoiceLineRider(FAST_RECORD);
    run(game, silence, 120);
    expect(game.phase).toBe('ready');
    expect(game.contour).toHaveLength(0);
  });

  it('starts recording on the first hummed note', () => {
    const game = new VoiceLineRider(FAST_RECORD);
    game.update(DT, humming(0.5));
    expect(game.phase).toBe('playing');
    expect(game.mode).toBe('recording');
    expect(game.contour).toEqual([0.5]);
  });

  it('captures roughly one sample per sampleInterval and stops at recordDuration', () => {
    const game = new VoiceLineRider(FAST_RECORD);
    run(game, humming(0.6), 90); // 1.5s of real time at 60fps, recordDuration is 1s
    expect(game.mode).toBe('replaying');
    // sampleInterval 0.1 over 1s of recording is ~11 samples (t=0..1.0 inclusive).
    expect(game.contour.length).toBeGreaterThanOrEqual(10);
    expect(game.contour.length).toBeLessThanOrEqual(12);
  });

  it('holds the last pitch through a silent gap instead of dropping to zero', () => {
    const game = new VoiceLineRider(FAST_RECORD);
    game.update(DT, humming(0.8));
    run(game, silence, 30); // ~0.5s silent, still mid-recording
    expect(game.mode).toBe('recording');
    for (const height of game.contour) expect(height).toBeCloseTo(0.8, 5);
  });

  it('stops appending samples once replay begins', () => {
    const game = new VoiceLineRider(FAST_RECORD);
    run(game, humming(0.5), 90);
    expect(game.mode).toBe('replaying');
    const length = game.contour.length;
    run(game, humming(0.9), 60);
    expect(game.contour).toHaveLength(length);
  });

  it('score is zero while a round is being recorded', () => {
    const game = new VoiceLineRider(FAST_RECORD);
    run(game, humming(0.5), 30);
    expect(game.mode).toBe('recording');
    expect(game.score).toBe(0);
  });
});

describe('VoiceLineRider replay physics', () => {
  /** A valley-shaped contour: descends from 1 at the start to 0 at `valley`,
   *  then climbs back to 1 — a stable equilibrium at the bottom, since it's
   *  the one point with zero slope on both sides. Any marble released
   *  anywhere on it eventually settles there once friction bleeds off energy. */
  function valleyContour(width: number, valley = Math.floor(width / 2)): number[] {
    return Array.from({ length: width + 1 }, (_, i) => Math.abs(i - valley) / Math.max(valley, width - valley));
  }

  const STEEP: Config = { ...DEFAULT_CONFIG, gravity: 30, friction: 1.5, maxReplayDuration: 20 };

  function replayFrom(config: Config, contour: number[], goalX: number, startX: number): VoiceLineRider {
    const game = new VoiceLineRider(config);
    game.phase = 'playing';
    game.mode = 'replaying';
    game.contour = contour;
    game.marbleX = startX;
    game.goalX = goalX;
    return game;
  }

  it('rolls the marble downhill toward the bottom of a valley', () => {
    const contour = valleyContour(30);
    const valley = 15;
    const game = replayFrom(STEEP, contour, valley, 2);

    run(game, silence, 60 * 20);

    expect(game.phase).toBe('over');
    expect(Math.abs(game.marbleX - valley)).toBeLessThan(1);
    expect(game.reached).toBe(true);
  });

  it('scores higher the closer the marble settles to the goal', () => {
    // A flat contour so the marble never moves from wherever it starts —
    // isolates the score formula from the settling physics.
    const contour = new Array(20).fill(0.5);
    const near = replayFrom(STEEP, contour, 10, 10);
    const far = replayFrom(STEEP, contour, 10, 3);

    run(near, silence, 60 * 2);
    run(far, silence, 60 * 2);

    expect(near.phase).toBe('over');
    expect(far.phase).toBe('over');
    expect(near.score).toBe(MAX_SCORE);
    expect(near.score).toBeGreaterThan(far.score);
  });

  it('ignores frame input entirely during replay', () => {
    const contour = valleyContour(20);
    const a = replayFrom(STEEP, contour, 10, 3);
    const b = replayFrom(STEEP, contour, 10, 3);

    for (let i = 0; i < 60 * 20; i++) {
      a.update(DT, silence);
      b.update(DT, humming(Math.sin(i) * 0.5 + 0.5));
    }

    expect(a.phase).toBe('over');
    expect(b.phase).toBe('over');
    expect(b.marbleX).toBeCloseTo(a.marbleX, 6);
    expect(b.score).toBe(a.score);
  });

  it('never rolls the marble past the ends of the recorded contour', () => {
    // A one-way downhill slope with nothing to stop the marble but the wall.
    const contour = Array.from({ length: 20 }, (_, i) => 1 - i / 19);
    const game = replayFrom(STEEP, contour, 19, 0);

    run(game, silence, 60 * 20);

    expect(game.marbleX).toBeGreaterThanOrEqual(0);
    expect(game.marbleX).toBeLessThanOrEqual(contour.length - 1);
  });

  it('settles quickly on a flat contour with nowhere to roll', () => {
    const contour = new Array(20).fill(0.5);
    const game = replayFrom(STEEP, contour, 10, 3);

    run(game, silence, 60 * 5);

    expect(game.phase).toBe('over');
    expect(game.marbleX).toBe(3);
  });

  it('caps a non-settling round at maxReplayDuration', () => {
    const zeroFriction: Config = { ...STEEP, friction: 0, settleSpeed: 1e9, maxReplayDuration: 2 };
    const contour = valleyContour(40);
    const game = replayFrom(zeroFriction, contour, 20, 5);

    run(game, silence, 60 * 5); // well past maxReplayDuration if it never settles

    expect(game.phase).toBe('over');
  });

  it('lights the celebration flag only when the marble settles on the goal', () => {
    // Two valleys at different spots so one settle lands on the goal and the
    // other settles somewhere else entirely.
    const hit = replayFrom(STEEP, valleyContour(30, 15), 15, 2);
    const miss = replayFrom(STEEP, valleyContour(30, 5), 25, 2);

    run(hit, silence, 60 * 20);
    run(miss, silence, 60 * 20);

    expect(hit.phase).toBe('over');
    expect(miss.phase).toBe('over');
    expect(hit.celebration).toBe(1);
    expect(miss.celebration).toBe(0);
  });
});

describe('VoiceLineRider reset', () => {
  it('starts clean after a reset', () => {
    const game = new VoiceLineRider(FAST_RECORD);
    run(game, humming(0.5), 90);
    expect(game.mode).toBe('replaying');
    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.mode).toBe('recording');
    expect(game.contour).toHaveLength(0);
    expect(game.marbleX).toBe(0);
    expect(game.score).toBe(0);
  });
});
