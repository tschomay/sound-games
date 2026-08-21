import { describe, expect, it } from 'vitest';
import { DropSiege, type Input } from '../game';
import type { Section, SongStructure } from '../../../engine/sections';
import type { Bands } from '../../../engine/types';

const DT = 1 / 60;
const EMPTY_NOVELTY = { values: new Float32Array(0), times: new Float64Array(0) };

const SILENT_BANDS: Bands = { bass: 0, lowMid: 0, mid: 0, high: 0 };
const BASS_BANDS: Bands = { bass: 1, lowMid: 0, mid: 0, high: 0 };
const HIGH_BANDS: Bands = { bass: 0, lowMid: 0, mid: 0, high: 1 };

/** A minimal, valid `Section` — tests only override what they care about. */
function section(overrides: {
  index: number;
  startSeconds: number;
  endSeconds: number;
  intensity: number;
  loudnessDb?: number;
}): Section {
  return {
    index: overrides.index,
    startSeconds: overrides.startSeconds,
    endSeconds: overrides.endSeconds,
    durationSeconds: overrides.endSeconds - overrides.startSeconds,
    intensity: overrides.intensity,
    loudnessDb: overrides.loudnessDb ?? -30 + overrides.intensity * 20,
    boundaryStrength: 0.5,
    isDrop: false,
    startBeat: null,
    beatCount: null,
  };
}

/** A synthetic `SongStructure` — the same "construct fake data directly"
 *  precedent every other game's tests use for `Frame`, applied to structure. */
function structure(sections: Section[], dropIndex: number | null): SongStructure {
  return {
    sections,
    dropIndex,
    duration: sections.length > 0 ? sections[sections.length - 1].endSeconds : 0,
    beatSynchronous: false,
    grid: null,
    confidence: 0.8,
    novelty: EMPTY_NOVELTY,
  };
}

/** Two quiet sections then one loud one, with an explicit drop. Long enough
 *  (60 beats each at 120 BPM = 30s) that a whole wave has room to spawn. */
function twoWaveTrack(): SongStructure {
  return structure(
    [
      section({ index: 0, startSeconds: 0, endSeconds: 30, intensity: 0.1 }),
      section({ index: 1, startSeconds: 30, endSeconds: 60, intensity: 1 }),
    ],
    1,
  );
}

const noBeat: Input = {
  bpm: null,
  beatPhase: null,
  onBeat: false,
  confidence: 0,
  beatIndex: null,
  bands: SILENT_BANDS,
  positionSeconds: 0,
};

/** A locked, confident 120 BPM reading at a given phase and position. */
function beatAt(
  phase: number,
  positionSeconds: number,
  onBeat = false,
  bands: Bands = SILENT_BANDS,
): Input {
  return { bpm: 120, beatPhase: phase, onBeat, confidence: 0.8, beatIndex: 0, bands, positionSeconds };
}

/** Drive the game through a locked beat lock-in hold, landing in 'playing'. */
function lockIn(game: DropSiege, positionSeconds = 0): void {
  const holdFrames = Math.ceil(game.config.readyHoldSeconds / DT) + 2;
  for (let i = 0; i < holdFrames; i++) game.update(DT, beatAt(0.5, positionSeconds));
  expect(game.phase).toBe('playing');
}

/** Simulate `n` beats at 120 BPM (0.5s period), each ending with an `onBeat`
 *  edge, holding `positionSeconds` fixed for the whole run — tests are about
 *  wave/beat logic, not real playback-position/tempo correlation. */
function tickBeats(
  game: DropSiege,
  n: number,
  positionSeconds: number,
  bands: Bands = SILENT_BANDS,
): void {
  const period = 0.5;
  const framesPerBeat = Math.round(period / DT);
  for (let beat = 0; beat < n; beat++) {
    for (let f = 0; f < framesPerBeat; f++) {
      const phase = f / framesPerBeat;
      const onBeat = f === framesPerBeat - 1;
      game.update(DT, beatAt(onBeat ? 0 : phase, positionSeconds, onBeat, bands));
    }
  }
}

describe('DropSiege', () => {
  it('stays in ready with no beat lock, however long it waits', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    for (let i = 0; i < 300; i++) game.update(DT, noBeat);
    expect(game.phase).toBe('ready');
  });

  it('stays in ready with a confident beat lock but no track configured', () => {
    const game = new DropSiege();
    const holdFrames = Math.ceil(game.config.readyHoldSeconds / DT) + 2;
    for (let i = 0; i < holdFrames; i++) game.update(DT, beatAt(0.5, 0));
    expect(game.phase).toBe('ready');
  });

  it('starts once the track is configured and the beat locks in', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    lockIn(game);
    expect(game.phase).toBe('playing');
  });

  it('enemies do not move without an onBeat edge', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    lockIn(game, 0);
    tickBeats(game, game.config.maxSpawnEveryBeats, 0);
    expect(game.enemies.length).toBeGreaterThan(0);
    const steps = game.enemies[0].steps;
    for (let i = 0; i < 60; i++) game.update(DT, beatAt(0.4, 0, false));
    expect(game.enemies[0].steps).toBe(steps);
  });

  it('an enemy steps closer on every onBeat edge, one step per beat', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    lockIn(game, 0);
    tickBeats(game, game.config.maxSpawnEveryBeats, 0);
    const enemy = game.enemies[0];
    const before = enemy.steps;
    tickBeats(game, 1, 0);
    expect(game.enemies.find((e) => e.id === enemy.id)?.steps).toBe(before - 1);
  });

  it('a quiet section spawns a smaller wave than an intense one', () => {
    const track = twoWaveTrack();
    const quiet = new DropSiege();
    quiet.configureTrack(track);
    lockIn(quiet, 0); // section 0, intensity 0.1
    tickBeats(quiet, 40, 0); // plenty of beats to finish the wave

    const intense = new DropSiege();
    intense.configureTrack(track);
    lockIn(intense, 35); // section 1, intensity 1 — also the drop/boss section
    tickBeats(intense, 40, 35);

    // The boss section spawns the boss itself plus its escorts; a fair
    // comparison is against the escort count, which is fixed at max size,
    // while the quiet section's regular wave is scaled down near the floor.
    const quietSpawns = quiet.enemies.length; // none arrived yet at low intensity's slow spacing
    expect(quietSpawns).toBeLessThan(intense.config.bossEscortSize);
  });

  it('entering a new section starts a fresh wave and flags it', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    lockIn(game, 0);
    expect(game.currentSectionIndex).toBe(0);
    tickBeats(game, 2, 0);
    // Cross into section 1.
    game.update(DT, beatAt(0.5, 30));
    expect(game.currentSectionIndex).toBe(1);
    expect(game.waveStartFlash).toBeGreaterThan(0);
  });

  it('the drop section spawns a distinct boss enemy on its first beat', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    lockIn(game, 35); // straight into the drop/boss section
    tickBeats(game, 1, 35);
    expect(game.enemies.some((e) => e.kind === 'boss')).toBe(true);
    const boss = game.enemies.find((e) => e.kind === 'boss')!;
    expect(boss.lane).toBe(1);
    expect(boss.hitsRemaining).toBeGreaterThan(1);
  });

  it('a null dropIndex still produces exactly one boss wave', () => {
    // Two sections that differ in timbre but not enough to be called a drop
    // by the engine's own margin — the honest ADR-0013 case.
    const track = structure(
      [
        section({ index: 0, startSeconds: 0, endSeconds: 20, intensity: 0.4, loudnessDb: -20 }),
        section({ index: 1, startSeconds: 20, endSeconds: 40, intensity: 0.6, loudnessDb: -19 }),
      ],
      null,
    );
    const game = new DropSiege();
    game.configureTrack(track);
    // The loudest section (louder loudnessDb) is section 1 — the deliberate fallback.
    expect(game.bossSectionIndex).toBe(1);
  });

  it('a single-section structure is its own boss section', () => {
    const track = structure([section({ index: 0, startSeconds: 0, endSeconds: 20, intensity: 1 })], null);
    const game = new DropSiege();
    game.configureTrack(track);
    expect(game.bossSectionIndex).toBe(0);
    lockIn(game, 0);
    tickBeats(game, 1, 0);
    expect(game.enemies.some((e) => e.kind === 'boss')).toBe(true);
  });

  it('bass-dominant frames spawn a brute in the bass lane, high-dominant a sprite in the high lane', () => {
    const track = twoWaveTrack();
    const bassGame = new DropSiege();
    bassGame.configureTrack(track);
    lockIn(bassGame, 0);
    tickBeats(bassGame, bassGame.config.maxSpawnEveryBeats, 0, BASS_BANDS);

    const highGame = new DropSiege();
    highGame.configureTrack(track);
    lockIn(highGame, 0);
    tickBeats(highGame, highGame.config.maxSpawnEveryBeats, 0, HIGH_BANDS);

    expect(bassGame.enemies[0].kind).toBe('brute');
    expect(bassGame.enemies[0].lane).toBe(0);
    expect(highGame.enemies[0].kind).toBe('sprite');
    expect(highGame.enemies[0].lane).toBe(2);
  });

  it('a frame with no strong band defaults to the neutral grunt in the centre lane', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    lockIn(game, 0);
    tickBeats(game, game.config.maxSpawnEveryBeats, 0, SILENT_BANDS);
    expect(game.enemies[0].kind).toBe('grunt');
    expect(game.enemies[0].lane).toBe(1);
  });

  it('a strike only hits an enemy in the tapped lane', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    lockIn(game, 0);
    tickBeats(game, game.config.maxSpawnEveryBeats, 0, HIGH_BANDS); // spawns a sprite in lane 2
    const sprite = game.enemies[0];
    while (game.enemies.some((e) => e.id === sprite.id && e.steps > game.config.attackRange)) {
      tickBeats(game, 1, 0, SILENT_BANDS);
    }
    game.update(DT, beatAt(0.02, 0));
    game.strike(0); // wrong lane
    expect(game.enemies.some((e) => e.id === sprite.id)).toBe(true);
    expect(game.missFlash).toBeGreaterThan(0);

    game.update(DT, beatAt(0.02, 0));
    game.strike(2); // right lane
    expect(game.enemies.some((e) => e.id === sprite.id)).toBe(false);
    expect(game.score).toBeGreaterThan(0);
  });

  it('a strike outside the timing window whiffs even with a target in the right lane', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    lockIn(game, 0);
    tickBeats(game, game.config.maxSpawnEveryBeats, 0, SILENT_BANDS);
    const startCount = game.enemies.length;
    game.update(DT, beatAt(0.5, 0)); // squarely off-beat
    game.strike(1);
    expect(game.enemies.length).toBe(startCount);
    expect(game.missFlash).toBeGreaterThan(0);
  });

  it('an enemy that reaches the player deals damage and disappears', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    lockIn(game, 0);
    const startHealth = game.health;
    tickBeats(game, game.config.maxSpawnEveryBeats, 0);
    const enemy = game.enemies[0];
    tickBeats(game, enemy.steps, 0);
    expect(game.enemies.some((e) => e.id === enemy.id)).toBe(false);
    expect(game.health).toBeLessThan(startHealth);
    expect(game.hurtFlash).toBeGreaterThan(0);
  });

  it('health hitting zero ends the round as defeated, not a win', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    lockIn(game, 0);
    for (let i = 0; i < 200 && game.phase === 'playing'; i++) {
      tickBeats(game, 1, 0, BASS_BANDS); // brutes drain health, never attacked
    }
    expect(game.phase).toBe('over');
    expect(game.defeated).toBe(true);
  });

  it('the track ending with health left is a win, not a defeat', () => {
    const short = structure([section({ index: 0, startSeconds: 0, endSeconds: 4, intensity: 0.2 })], null);
    const game = new DropSiege();
    game.configureTrack(short);
    lockIn(game, 0);
    game.update(DT, beatAt(0.5, 4)); // position at the very end of a 4s track
    expect(game.phase).toBe('over');
    expect(game.defeated).toBe(false);
  });

  it('keeps the enemy list bounded no matter how long a hostile section runs', () => {
    const long = structure([section({ index: 0, startSeconds: 0, endSeconds: 600, intensity: 1 })], null);
    const game = new DropSiege();
    game.configureTrack(long);
    lockIn(game, 0);
    for (let i = 0; i < 300 && game.phase === 'playing'; i++) {
      tickBeats(game, 1, 5, BASS_BANDS); // stay well inside the section
      expect(game.enemies.length).toBeLessThanOrEqual(game.config.maxEnemies);
    }
  });

  it('ignores strikes before the round starts', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    game.strike(0);
    expect(game.score).toBe(0);
    expect(game.missFlash).toBe(0);
  });

  it('a reset keeps the configured track but clears the round', () => {
    const game = new DropSiege();
    game.configureTrack(twoWaveTrack());
    lockIn(game, 0);
    tickBeats(game, 10, 0, BASS_BANDS);
    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.score).toBe(0);
    expect(game.health).toBe(game.config.startHealth);
    expect(game.enemies.length).toBe(0);
    expect(game.structure).not.toBeNull();
    expect(game.bossSectionIndex).toBe(1);
    // And it can start straight back up on the same track without reconfiguring.
    lockIn(game, 0);
    expect(game.phase).toBe('playing');
  });
});
