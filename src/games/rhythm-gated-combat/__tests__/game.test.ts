import { describe, expect, it } from 'vitest';
import { RhythmGatedCombat, type Input } from '../game';
import type { Bands } from '../../../engine/types';

const DT = 1 / 60;

const SILENT_BANDS: Bands = { bass: 0, lowMid: 0, mid: 0, high: 0 };
const BASS_BANDS: Bands = { bass: 1, lowMid: 0, mid: 0, high: 0 };
const HIGH_BANDS: Bands = { bass: 0, lowMid: 0, mid: 0, high: 1 };

const noBeat: Input = {
  bpm: null,
  beatPhase: null,
  onBeat: false,
  confidence: 0,
  beatIndex: null,
  bands: SILENT_BANDS,
};

/** A locked, confident 120 BPM reading at a given phase. */
function beatAt(phase: number, onBeat = false, bands: Bands = SILENT_BANDS): Input {
  return { bpm: 120, beatPhase: phase, onBeat, confidence: 0.8, beatIndex: 0, bands };
}

/** Drive the game through a locked beat lock-in hold, landing in 'playing'. */
function lockIn(game: RhythmGatedCombat): void {
  const holdFrames = Math.ceil(game.config.readyHoldSeconds / DT) + 2;
  for (let i = 0; i < holdFrames; i++) game.update(DT, beatAt(0.5));
  expect(game.phase).toBe('playing');
}

/** Simulate `n` beats at 120 BPM (0.5s period), each ending with an `onBeat` edge. */
function tickBeats(game: RhythmGatedCombat, n: number, bands: Bands = SILENT_BANDS): void {
  const period = 0.5;
  const framesPerBeat = Math.round(period / DT);
  for (let beat = 0; beat < n; beat++) {
    for (let f = 0; f < framesPerBeat; f++) {
      const phase = f / framesPerBeat;
      const onBeat = f === framesPerBeat - 1;
      game.update(DT, beatAt(onBeat ? 0 : phase, onBeat, bands));
    }
  }
}

describe('RhythmGatedCombat', () => {
  it('stays in ready with no beat lock, however long it waits', () => {
    const game = new RhythmGatedCombat();
    for (let i = 0; i < 300; i++) game.update(DT, noBeat);
    expect(game.phase).toBe('ready');
  });

  it('stays in ready on a flickery, low-confidence beat reading', () => {
    const game = new RhythmGatedCombat();
    for (let i = 0; i < 120; i++) {
      game.update(DT, { bpm: 120, beatPhase: 0.5, onBeat: false, confidence: 0.05, beatIndex: 0, bands: SILENT_BANDS });
    }
    expect(game.phase).toBe('ready');
  });

  it('starts once a confident beat lock holds for the configured hold time', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    expect(game.phase).toBe('playing');
  });

  it('a brief drop in lock does not start the round early', () => {
    const game = new RhythmGatedCombat();
    // Almost long enough, then interrupted.
    const almost = Math.ceil(game.config.readyHoldSeconds / DT) - 2;
    for (let i = 0; i < almost; i++) game.update(DT, beatAt(0.5));
    game.update(DT, noBeat);
    expect(game.phase).toBe('ready');
  });

  it('enemies do not move without an onBeat edge', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    // Force a spawn directly via many beats first, then hammer non-beat frames.
    tickBeats(game, game.config.spawnEveryBeats);
    expect(game.enemies.length).toBeGreaterThan(0);
    const steps = game.enemies[0].steps;
    for (let i = 0; i < 60; i++) game.update(DT, beatAt(0.4, false));
    expect(game.enemies[0].steps).toBe(steps);
  });

  it('an enemy steps closer on every onBeat edge, one step per beat', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    tickBeats(game, game.config.spawnEveryBeats);
    const enemy = game.enemies[0];
    const startSteps = enemy.steps;
    tickBeats(game, 1);
    expect(game.enemies.find((e) => e.id === enemy.id)?.steps).toBe(startSteps - 1);
  });

  it('an attack outside the timing window whiffs, even with an enemy in range', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    tickBeats(game, game.config.spawnEveryBeats);
    const startCount = game.enemies.length;
    // Squarely off-beat.
    game.update(DT, beatAt(0.5));
    game.attack();
    expect(game.enemies.length).toBe(startCount);
    expect(game.missFlash).toBeGreaterThan(0);
  });

  it('an attack inside the timing window kills the nearest in-range enemy', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    // Bring a grunt (1 hit) down to attack range.
    tickBeats(game, game.config.spawnEveryBeats);
    const enemy = game.enemies[0];
    while (game.enemies.some((e) => e.id === enemy.id && e.steps > game.config.attackRange)) {
      tickBeats(game, 1);
    }
    game.update(DT, beatAt(0.02)); // just inside the window
    game.attack();
    expect(game.enemies.some((e) => e.id === enemy.id)).toBe(false);
    expect(game.score).toBeGreaterThan(0);
    expect(game.attackFlash).toBeGreaterThan(0);
  });

  it('a tap with no enemy in range whiffs even on the beat', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    game.update(DT, beatAt(0));
    game.attack();
    expect(game.missFlash).toBeGreaterThan(0);
    expect(game.score).toBe(0);
  });

  it('an enemy that reaches the player deals damage and disappears', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    const startHealth = game.health;
    tickBeats(game, game.config.spawnEveryBeats); // spawn
    const enemy = game.enemies[0];
    const stepsToArrive = enemy.steps;
    tickBeats(game, stepsToArrive); // walk it all the way in, untouched
    expect(game.enemies.some((e) => e.id === enemy.id)).toBe(false);
    expect(game.health).toBeLessThan(startHealth);
    expect(game.hurtFlash).toBeGreaterThan(0);
  });

  it('health hitting zero ends the round as defeated', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    for (let i = 0; i < 400 && game.phase === 'playing'; i++) {
      tickBeats(game, 1, BASS_BANDS); // brutes: fastest to drain health, never attacked
    }
    expect(game.phase).toBe('over');
    expect(game.defeated).toBe(true);
  });

  it('bass-dominant frames spawn tougher, slower enemies than high-dominant frames', () => {
    const bassGame = new RhythmGatedCombat();
    lockIn(bassGame);
    tickBeats(bassGame, bassGame.config.spawnEveryBeats, BASS_BANDS);
    const highGame = new RhythmGatedCombat();
    lockIn(highGame);
    tickBeats(highGame, highGame.config.spawnEveryBeats, HIGH_BANDS);

    expect(bassGame.enemies[0].kind).toBe('brute');
    expect(highGame.enemies[0].kind).toBe('sprite');
    expect(bassGame.enemies[0].steps).toBeGreaterThan(highGame.enemies[0].steps);
    expect(bassGame.enemies[0].hitsRemaining).toBeGreaterThan(highGame.enemies[0].hitsRemaining);
  });

  it('a frame with no strong band defaults to the neutral grunt', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    tickBeats(game, game.config.spawnEveryBeats, SILENT_BANDS);
    expect(game.enemies[0].kind).toBe('grunt');
  });

  it('keeps the enemy list bounded no matter how long a hostile round runs', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    for (let i = 0; i < 200 && game.phase === 'playing'; i++) {
      tickBeats(game, 1, BASS_BANDS);
      expect(game.enemies.length).toBeLessThanOrEqual(game.config.maxEnemies);
    }
  });

  it('spawns faster as score climbs, down to the configured floor', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    game.score = 1000; // enough to blow well past the floor
    tickBeats(game, 1, SILENT_BANDS);
    // At this score the interval is clamped to the floor, so a single beat's
    // worth of spawn pressure at floor 2 should not yet spawn (needs 2 beats).
    expect(game.enemies.length).toBe(0);
    tickBeats(game, 1, SILENT_BANDS);
    expect(game.enemies.length).toBe(1);
  });

  it('ignores attacks before the round starts', () => {
    const game = new RhythmGatedCombat();
    game.attack();
    expect(game.score).toBe(0);
    expect(game.missFlash).toBe(0);
  });

  it('starts clean after a reset', () => {
    const game = new RhythmGatedCombat();
    lockIn(game);
    tickBeats(game, 20, BASS_BANDS);
    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.score).toBe(0);
    expect(game.health).toBe(game.config.startHealth);
    expect(game.enemies.length).toBe(0);
    expect(game.beatPhase).toBe(null);
  });
});
