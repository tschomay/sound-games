import { describe, expect, it } from 'vitest';
import { RhythmSiege, DEFAULT_CONFIG, classifyOnset, marchSpeed, type Input } from '../game';
import type { Bands } from '../../../engine/types';

const DT = 1 / 60;

const SILENT_BANDS: Bands = { bass: 0, lowMid: 0, mid: 0, high: 0 };
const BASS_BANDS: Bands = { bass: 0.9, lowMid: 0.1, mid: 0.05, high: 0.05 };
const HIGH_BANDS: Bands = { bass: 0.05, lowMid: 0.05, mid: 0.3, high: 0.9 };
const MID_HIGH_BANDS: Bands = { bass: 0.05, lowMid: 0.05, mid: 0.6, high: 0.5 };
const AMBIGUOUS_BANDS: Bands = { bass: 0.5, lowMid: 0.1, mid: 0.1, high: 0.5 };
const QUIET_BANDS: Bands = { bass: 0.03, lowMid: 0.02, mid: 0.01, high: 0.02 };

const noSignal: Input = {
  onset: false,
  bands: SILENT_BANDS,
  level: 0,
  bpm: null,
  confidence: 0,
};

/** A frame with steady presence but no onset this frame — used to hold the
 *  round in 'playing' without triggering a spawn. */
function idleFrame(bands: Bands = SILENT_BANDS): Input {
  return { onset: false, bands, level: 0.5, bpm: null, confidence: 0 };
}

/** One onset frame carrying a classification-worthy `bands` reading. */
function onsetFrame(bands: Bands, bpm: number | null = null, confidence = 0): Input {
  return { onset: true, bands, level: 0.5, bpm, confidence };
}

/** Drive the game through its presence hold, landing in 'playing'. */
function lockIn(game: RhythmSiege): void {
  const holdFrames = Math.ceil(game.config.readyHoldTime / DT) + 2;
  for (let i = 0; i < holdFrames; i++) game.update(DT, idleFrame());
  expect(game.phase).toBe('playing');
}

describe('classifyOnset', () => {
  it('classifies a clearly bass-dominant onset as heavy', () => {
    expect(classifyOnset(BASS_BANDS, DEFAULT_CONFIG)).toBe('heavy');
  });

  it('classifies a clearly high-dominant onset as swarm', () => {
    expect(classifyOnset(HIGH_BANDS, DEFAULT_CONFIG)).toBe('swarm');
  });

  it('classifies a mid+high combined dominant onset as swarm', () => {
    expect(classifyOnset(MID_HIGH_BANDS, DEFAULT_CONFIG)).toBe('swarm');
  });

  it('classifies an ambiguous, roughly-tied onset as nothing — a real margin test, not a maximum-by-an-epsilon tie-break', () => {
    // Exactly tied.
    expect(classifyOnset(AMBIGUOUS_BANDS, DEFAULT_CONFIG)).toBeNull();
    // Bass is technically ahead (0.42 vs 0.4) but well inside the margin —
    // should not fall through to "whichever is bigger."
    const barelyBass: Bands = { bass: 0.42, lowMid: 0.1, mid: 0.1, high: 0.4 };
    expect(classifyOnset(barelyBass, DEFAULT_CONFIG)).toBeNull();
  });

  it('classifies a quiet onset below the signal floor as nothing, even if technically unequal', () => {
    // bass (0.03) edges high (0.02) but both are under minSignal.
    expect(classifyOnset(QUIET_BANDS, DEFAULT_CONFIG)).toBeNull();
  });
});

describe('marchSpeed', () => {
  it('falls back to the fixed default when bpm is null', () => {
    expect(marchSpeed(null, 0.9, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.fallbackMarchSpeed);
  });

  it('falls back to the fixed default when confidence is too low, even with a known bpm', () => {
    expect(marchSpeed(120, 0.05, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.fallbackMarchSpeed);
  });

  it('scales with bpm once confidence clears the floor', () => {
    const speed = marchSpeed(140, 0.9, DEFAULT_CONFIG);
    expect(speed).toBeCloseTo(140 * DEFAULT_CONFIG.marchSpeedPerBpm, 6);
    expect(speed).toBeGreaterThan(marchSpeed(100, 0.9, DEFAULT_CONFIG));
  });

});

describe('RhythmSiege', () => {
  it('stays in ready with no presence at all, however long it waits', () => {
    const game = new RhythmSiege();
    for (let i = 0; i < 300; i++) game.update(DT, noSignal);
    expect(game.phase).toBe('ready');
  });

  it('starts once presence holds for the configured hold time', () => {
    const game = new RhythmSiege();
    lockIn(game);
    expect(game.phase).toBe('playing');
  });

  it('a brief drop in presence does not start the round early', () => {
    const game = new RhythmSiege();
    const almost = Math.ceil(game.config.readyHoldTime / DT) - 2;
    for (let i = 0; i < almost; i++) game.update(DT, idleFrame());
    game.update(DT, noSignal);
    expect(game.phase).toBe('ready');
  });

  it('starts even with bpm permanently null — the round never stalls waiting for a beat lock', () => {
    const game = new RhythmSiege();
    lockIn(game);
    expect(game.phase).toBe('playing');
    expect(game.bpm).toBeNull();
    // And it keeps progressing: a spawned enemy still marches under the fallback speed.
    game.update(DT, onsetFrame(BASS_BANDS));
    expect(game.enemies.length).toBe(1);
    const before = game.enemies[0].progress;
    game.update(DT, idleFrame());
    expect(game.enemies[0].progress).toBeGreaterThan(before);
  });

  it('spawns a single heavy enemy on a bass-dominant onset', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(BASS_BANDS));
    expect(game.enemies.length).toBe(1);
    expect(game.enemies[0].kind).toBe('heavy');
    expect(game.enemies[0].hitsRemaining).toBe(game.config.enemyStats.heavy.hitsToKill);
  });

  it('spawns a cluster of swarm enemies on a high-dominant onset', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(HIGH_BANDS));
    expect(game.enemies.length).toBe(game.config.swarmClusterSize);
    expect(game.enemies.every((e) => e.kind === 'swarm')).toBe(true);
  });

  it('spawns nothing on an ambiguous onset', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(AMBIGUOUS_BANDS));
    expect(game.enemies.length).toBe(0);
  });

  it('respects a per-classification spawn cooldown, even with an onset every frame', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(BASS_BANDS));
    expect(game.enemies.length).toBe(1);
    // Hammer bass onsets well inside the cooldown window.
    const framesWithinCooldown = Math.floor(game.config.heavySpawnCooldown / DT) - 2;
    for (let i = 0; i < framesWithinCooldown; i++) game.update(DT, onsetFrame(BASS_BANDS));
    expect(game.enemies.length).toBe(1);
  });

  it('allows another spawn once the cooldown fully elapses', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(BASS_BANDS));
    expect(game.enemies.length).toBe(1);
    const framesToElapse = Math.ceil(game.config.heavySpawnCooldown / DT) + 2;
    for (let i = 0; i < framesToElapse; i++) game.update(DT, idleFrame());
    game.update(DT, onsetFrame(BASS_BANDS));
    expect(game.enemies.length).toBe(2);
  });

  it('heavy and swarm cooldowns are independent of each other', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(BASS_BANDS));
    expect(game.enemies.length).toBe(1);
    // A swarm-classified onset immediately after should still land — its own
    // cooldown hasn't been touched by the heavy spawn.
    game.update(DT, onsetFrame(HIGH_BANDS));
    expect(game.enemies.length).toBe(1 + game.config.swarmClusterSize);
  });

  it('march speed scales with a confident bpm reading, not just the fallback', () => {
    const slow = new RhythmSiege();
    lockIn(slow);
    slow.update(DT, onsetFrame(BASS_BANDS));
    const fast = new RhythmSiege();
    lockIn(fast);
    fast.update(DT, onsetFrame(BASS_BANDS));

    slow.update(DT, { onset: false, bands: SILENT_BANDS, level: 0.5, bpm: 80, confidence: 0.9 });
    fast.update(DT, { onset: false, bands: SILENT_BANDS, level: 0.5, bpm: 200, confidence: 0.9 });
    expect(fast.enemies[0].progress).toBeGreaterThan(slow.enemies[0].progress);
  });

  it('strike always lands, with no timing gate, hitting the nearest enemy in the tapped lane', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(HIGH_BANDS)); // spawns a swarm cluster across lanes 0,1,2
    const targetLane = game.enemies[0].lane;
    const startCount = game.enemies.length;
    game.strike(targetLane);
    expect(game.enemies.length).toBe(startCount - 1);
  });

  it('strike in a lane does not hit enemies in other lanes', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(HIGH_BANDS));
    // Every lane should have exactly one enemy from a 3-sized cluster starting at lane 0.
    for (const lane of [0, 1, 2] as const) {
      expect(game.enemies.filter((e) => e.lane === lane).length).toBe(1);
    }
    game.strike(0);
    expect(game.enemies.some((e) => e.lane === 0)).toBe(false);
    expect(game.enemies.some((e) => e.lane === 1)).toBe(true);
    expect(game.enemies.some((e) => e.lane === 2)).toBe(true);
  });

  it('striking an empty lane whiffs without throwing or affecting other lanes', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(BASS_BANDS)); // single heavy, lane 0
    const before = game.enemies.length;
    expect(() => game.strike(1)).not.toThrow();
    expect(game.enemies.length).toBe(before);
    expect(game.missFlash).toBeGreaterThan(0);
  });

  it('strike hits the enemy nearest the player line, not the newest spawn, when several share a lane', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(BASS_BANDS)); // lane 0
    const nearId = game.enemies[0].id;
    game.enemies[0].progress = 0.9;
    // Force cooldown clear then spawn another heavy — round-robins to a new lane, so place it manually in lane 0 too.
    game.enemies.push({
      id: 999,
      kind: 'heavy',
      lane: 0,
      progress: 0.1,
      hitsRemaining: game.config.enemyStats.heavy.hitsToKill,
      spawnedAt: game.elapsed,
    });
    game.strike(0);
    // The near one (progress 0.9, single hit remaining after this strike) should be hit, not removed yet
    // since heavy takes multiple hits — check it lost a hit, not the far one.
    const near = game.enemies.find((e) => e.id === nearId);
    expect(near).toBeDefined();
    expect(near!.hitsRemaining).toBe(game.config.enemyStats.heavy.hitsToKill - 1);
    const far = game.enemies.find((e) => e.id === 999);
    expect(far!.hitsRemaining).toBe(game.config.enemyStats.heavy.hitsToKill);
  });

  it('a heavy takes multiple hits to kill', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(BASS_BANDS));
    const hits = game.config.enemyStats.heavy.hitsToKill;
    expect(hits).toBeGreaterThan(1);
    for (let i = 0; i < hits - 1; i++) {
      game.strike(0);
      expect(game.enemies.length).toBe(1);
    }
    game.strike(0);
    expect(game.enemies.length).toBe(0);
  });

  it('a swarm dies in one hit', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(HIGH_BANDS));
    const before = game.enemies.length;
    game.strike(game.enemies[0].lane);
    expect(game.enemies.length).toBe(before - 1);
  });

  it('killing an enemy awards its killScore', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(BASS_BANDS));
    for (let i = 0; i < game.config.enemyStats.heavy.hitsToKill; i++) game.strike(0);
    expect(game.score).toBe(game.config.enemyStats.heavy.killScore);
  });

  it('an enemy reaching the player line depletes health by its damage', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(BASS_BANDS));
    const startHealth = game.health;
    game.enemies[0].progress = 1 - 1e-6;
    // A confident, fast bpm to guarantee it crosses the line this frame.
    game.update(1, { onset: false, bands: SILENT_BANDS, level: 0.5, bpm: 200, confidence: 0.9 });
    expect(game.health).toBe(startHealth - game.config.enemyStats.heavy.damage);
    expect(game.enemies.length).toBe(0);
  });

  it('reaches game over at zero health', () => {
    const game = new RhythmSiege();
    lockIn(game);
    // Drain health directly via repeated arrivals rather than depending on
    // exact spawn cooldown timing.
    while (game.phase === 'playing' && game.health > 0) {
      game.update(DT, onsetFrame(BASS_BANDS));
      for (const enemy of game.enemies) enemy.progress = 1;
      game.update(DT, idleFrame());
    }
    expect(game.phase).toBe('over');
    expect(game.defeated).toBe(true);
    expect(game.health).toBe(0);
  });

  it('does not process spawns once the game is over', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.health = 0.001;
    game.enemies.push({
      id: 1,
      kind: 'heavy',
      lane: 0,
      progress: 1,
      hitsRemaining: 1,
      spawnedAt: 0,
    });
    game.update(DT, idleFrame());
    expect(game.phase).toBe('over');
    game.update(DT, onsetFrame(BASS_BANDS));
    expect(game.enemies.length).toBe(0); // still empty, no new spawn processed once over
  });

  it('strike does nothing once the game is over', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(BASS_BANDS));
    // Exactly enough health left that this one arrival finishes the round.
    game.health = game.config.enemyStats.heavy.damage;
    game.enemies[0].progress = 1 - 1e-6;
    game.update(1, { onset: false, bands: SILENT_BANDS, level: 0.5, bpm: 200, confidence: 0.9 });
    expect(game.phase).toBe('over');
    const before = game.enemies.length;
    expect(() => game.strike(0)).not.toThrow();
    expect(game.enemies.length).toBe(before);
  });

  it('reset returns the game to its initial ready state', () => {
    const game = new RhythmSiege();
    lockIn(game);
    game.update(DT, onsetFrame(BASS_BANDS));
    game.strike(0);
    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.score).toBe(0);
    expect(game.health).toBe(game.config.maxHealth);
    expect(game.enemies).toEqual([]);
    expect(game.defeated).toBe(false);
  });
});
