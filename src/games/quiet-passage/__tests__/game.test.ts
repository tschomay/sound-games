import { describe, expect, it } from 'vitest';
import { QuietPassage, DEFAULT_CONFIG, type Input } from '../game';
import type { Gap, QuietPassageLevel } from '../loudness';

const DT = 1 / 60;

/** A synthetic level — the same "construct fake data directly" precedent
 *  Drop Siege's tests use for `SongStructure`, applied to `QuietPassageLevel`.
 *  One gap, in lane 1, open from 3s to 6s, over a 20s track. */
function levelWithOneGap(overrides: Partial<QuietPassageLevel> = {}): QuietPassageLevel {
  const gaps: Gap[] = overrides.gaps ?? [{ startSeconds: 3, endSeconds: 6, lane: 1 }];
  return {
    durationSeconds: overrides.durationSeconds ?? 20,
    gaps,
    quietLevelThreshold: overrides.quietLevelThreshold ?? 0.3,
    laneCount: overrides.laneCount ?? 3,
  };
}

function input(level: number, positionSeconds: number): Input {
  return { level, positionSeconds };
}

/** Drive `update` through the fixed ready-hold so the round reaches
 *  'playing' — the level must already be configured. */
function start(game: QuietPassage, level = 0): void {
  const holdFrames = Math.ceil(game.config.readyHoldSeconds / DT) + 2;
  for (let i = 0; i < holdFrames; i++) game.update(DT, input(level, 0));
  expect(game.phase).toBe('playing');
}

/** Run `update` at a fixed level/position for `seconds` of game time, enough
 *  ticks for the exponential `height` chase to settle. */
function holdFor(game: QuietPassage, seconds: number, level: number, positionSeconds: number): void {
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) game.update(DT, input(level, positionSeconds));
}

describe('QuietPassage', () => {
  it('starts in ready, pinned at the floor, in the middle lane', () => {
    const game = new QuietPassage();
    expect(game.phase).toBe('ready');
    expect(game.height).toBe(0);
    expect(game.lane).toBe(1); // Math.floor(3 / 2) with the default 3-lane config
  });

  it('stays in ready forever with no level configured, however long it waits', () => {
    const game = new QuietPassage();
    for (let i = 0; i < 300; i++) game.update(DT, input(0, 0));
    expect(game.phase).toBe('ready');
  });

  it('moves to playing once a level is configured and the ready hold elapses', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap());
    start(game);
  });

  it('chases height toward 0 (the floor) while the track stays loud', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap());
    start(game, 1);
    holdFor(game, 3, 1, 0); // several time constants at the default responsiveness
    expect(game.height).toBeLessThan(0.02);
  });

  it('chases height toward 1 (the ceiling) while the track stays quiet', () => {
    const game = new QuietPassage();
    // A gap covering the whole track in the default lane, purely so this
    // test can isolate the height-smoothing math from the hazard check —
    // without it, height would cross into hazard territory partway through
    // the hold (this same scenario, unguarded, is exactly what the
    // "hits a hazard" test below exercises on purpose).
    game.configureTrack(levelWithOneGap({ gaps: [{ startSeconds: 0, endSeconds: 20, lane: 1 }] }));
    start(game, 1);
    holdFor(game, 3, 0, 0);
    expect(game.height).toBeGreaterThan(0.98);
  });

  it('rises and falls smoothly rather than snapping — height moves monotonically toward its target', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap());
    start(game, 1);
    let previous = game.height;
    for (let i = 0; i < 30; i++) {
      game.update(DT, input(0, 0));
      expect(game.height).toBeGreaterThanOrEqual(previous);
      previous = game.height;
    }
  });

  it('accepts a lane switch while the track is quiet enough', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap());
    start(game, 0);
    game.update(DT, input(0.1, 0)); // below quietLevelThreshold (0.3)
    game.switchLane(2);
    expect(game.lane).toBe(2);
    expect(game.laneSwitchFlash).toBeGreaterThan(0);
  });

  it('ignores a lane switch while the track is too loud', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap());
    start(game, 0);
    game.update(DT, input(0.8, 0)); // above quietLevelThreshold (0.3)
    game.switchLane(2);
    expect(game.lane).toBe(1); // unchanged
    expect(game.laneRejectFlash).toBeGreaterThan(0);
  });

  it('ignores a lane switch before the round has started', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap());
    game.switchLane(2);
    expect(game.lane).toBe(1);
  });

  it('hits a hazard when lifted into the ceiling in a lane with no open gap', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap()); // gap is lane 1, 3..6s
    start(game, 0);
    // Stay in lane 1's default, but switch away from the only gap's lane
    // while quiet is still allowed, then let the track go quiet at a moment
    // no gap covers (position 0, long before the gap opens at 3s).
    game.switchLane(0);
    // Just past the ~0.376s it takes height to cross the hazard threshold at
    // the default responsiveness — long enough to trigger, short enough that
    // hurtFlash (which keeps decaying every frame, playing or not — see
    // `update`'s own unconditional decay lines) hasn't faded back to 0 yet.
    holdFor(game, 0.6, 0, 0.5); // quiet, lifts into the hazard zone, position 0.5s — no gap here
    expect(game.phase).toBe('over');
    expect(game.defeated).toBe(true);
    expect(game.hurtFlash).toBeGreaterThan(0);
  });

  it('hits a hazard when at the ceiling in the wrong lane even during the gap’s own time span', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap()); // gap is lane 1
    start(game, 0);
    game.switchLane(0); // deliberately the wrong lane
    holdFor(game, 2, 0, 4); // quiet, and squarely inside the gap's 3..6s span — but wrong lane
    expect(game.phase).toBe('over');
    expect(game.defeated).toBe(true);
  });

  it('survives a correctly timed and laned gap', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap()); // gap is lane 1, 3..6s
    start(game, 0);
    // Already in lane 1 (the default) — no switch needed.
    holdFor(game, 2, 0, 4); // quiet, at the ceiling, inside the gap's span, right lane
    expect(game.phase).toBe('playing');
    expect(game.defeated).toBe(false);
  });

  it('does not hit a hazard while pinned low, regardless of lane or gap timing', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap());
    start(game, 1);
    game.switchLane(0); // rejected — too loud to switch, stays in lane 1, irrelevant either way
    holdFor(game, 2, 1, 10); // loud throughout, well outside the gap's span
    expect(game.phase).toBe('playing');
  });

  it('reaches victory when playback position reaches the end of the track', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap({ durationSeconds: 10 }));
    start(game, 1);
    holdFor(game, 0.2, 1, 9.95); // inside TRACK_END_EPSILON of the 10s duration
    expect(game.phase).toBe('over');
    expect(game.defeated).toBe(false);
  });

  it('scores the furthest position reached, as a percentage of the track', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap({ durationSeconds: 20 }));
    start(game, 1);
    holdFor(game, 0.1, 1, 5); // 5 / 20 = 25%
    expect(game.score).toBeCloseTo(25, 0);
  });

  it('keeps the furthest position reached even if position later moves backward', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap({ durationSeconds: 20 }));
    start(game, 1);
    holdFor(game, 0.1, 1, 10);
    holdFor(game, 0.1, 1, 2); // e.g. a seek back — score should not drop
    expect(game.score).toBeCloseTo(50, 0);
  });

  it('scores 0 with no level configured at all', () => {
    const game = new QuietPassage();
    expect(game.score).toBe(0);
  });

  it('reset clears round state but keeps the configured level', () => {
    const game = new QuietPassage();
    const level = levelWithOneGap();
    game.configureTrack(level);
    start(game, 0);
    game.switchLane(2);
    holdFor(game, 2, 0, 0.5); // dies, out of gap, out of lane
    expect(game.phase).toBe('over');

    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.height).toBe(0);
    expect(game.lane).toBe(1);
    expect(game.defeated).toBe(false);
    expect(game.score).toBe(0);
    expect(game.level).toBe(level); // the level itself survives, unlike round state
  });

  it('reaching the ready hold restarts cleanly after a reset', () => {
    const game = new QuietPassage();
    game.configureTrack(levelWithOneGap());
    start(game, 0);
    game.reset();
    start(game, 0); // should be able to reach playing again from a fresh ready
  });

  it('falls back to the config lane count before any level has been configured', () => {
    const game = new QuietPassage({ ...DEFAULT_CONFIG, laneCount: 5 });
    expect(game.lane).toBe(2); // Math.floor(5 / 2)
  });
});
