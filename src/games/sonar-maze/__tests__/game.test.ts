import { describe, expect, it } from 'vitest';
import { SonarMaze, type Input } from '../game';

const DT = 1 / 60;

const quiet: Input = { onset: false, level: 0 };

/** Steer straight to the lane the next fork needs, however many taps it takes. */
function alignToFork(game: SonarMaze): void {
  const fork = game.nextFork();
  if (!fork) return;
  while (game.lane !== fork.openLane) {
    game.steer(fork.openLane > game.lane ? 1 : -1);
  }
}

describe('SonarMaze', () => {
  it('stays in ready without a clap', () => {
    const game = new SonarMaze();
    for (let i = 0; i < 60; i++) game.update(DT, quiet);
    expect(game.phase).toBe('ready');
    expect(game.distance).toBe(0);
  });

  it('starts on the first clap, whatever its volume', () => {
    const game = new SonarMaze();
    game.update(DT, { onset: true, level: 0.1 });
    expect(game.phase).toBe('playing');
  });

  it('reveals a fork once a wavefront reaches it, and a soft clap reaches less far', () => {
    const game = new SonarMaze();
    game.update(DT, { onset: true, level: 0 });
    const fork = game.nextFork()!;

    // Get within reach of a loud clap but not a soft one.
    const maxRadius = game.config.wavefrontBaseRadius + game.config.wavefrontBonus;
    const target = fork.x - (maxRadius - 0.5);
    while (game.distance < target) game.update(DT, quiet);

    game.update(DT, { onset: true, level: 0.1 });
    expect(fork.revealed).toBe(false);

    game.update(DT, { onset: true, level: 1 });
    expect(fork.revealed).toBe(true);
  });

  it('never reveals a fork ahead of where a clap can reach', () => {
    const game = new SonarMaze();
    game.update(DT, { onset: true, level: 1 });
    for (const fork of game.forks) expect(fork.revealed).toBe(false);
  });

  it('a louder clap raises the hunter\'s alertness more', () => {
    const soft = new SonarMaze();
    soft.update(DT, { onset: true, level: 0.1 });
    const loud = new SonarMaze();
    loud.update(DT, { onset: true, level: 1 });
    expect(loud.alertness).toBeGreaterThan(soft.alertness);
  });

  it('crashes if you are in the wrong lane at a fork', () => {
    const game = new SonarMaze();
    game.update(DT, { onset: true, level: 0.5 });
    const fork = game.nextFork()!;
    const wrongLane = (fork.openLane + 1) % game.config.lanes;
    while (game.lane !== wrongLane) game.steer(wrongLane > game.lane ? 1 : -1);

    for (let i = 0; i < 60 * 20 && game.phase === 'playing'; i++) {
      game.update(DT, quiet);
    }
    expect(game.phase).toBe('over');
    expect(game.crashed).toBe(true);
  });

  it('scores by steering into the open lane at each fork', () => {
    const game = new SonarMaze();
    game.update(DT, { onset: true, level: 0.3 });
    for (let i = 0; i < 60 * 60 && game.phase === 'playing'; i++) {
      alignToFork(game);
      game.update(DT, quiet);
    }
    expect(game.phase).toBe('playing');
    expect(game.score).toBeGreaterThan(4);
  });

  it('gets less forgiving as the score climbs', () => {
    const game = new SonarMaze();
    game.update(DT, { onset: true, level: 0.3 });
    const openingSpeed = game.speed();
    for (let i = 0; i < 60 * 60 && game.phase === 'playing'; i++) {
      alignToFork(game);
      game.update(DT, quiet);
    }
    expect(game.speed()).toBeGreaterThan(openingSpeed);
  });

  it('lets a quiet run fall behind the hunter', () => {
    const game = new SonarMaze();
    game.update(DT, { onset: true, level: 0.2 });
    const openingGap = Math.abs(game.distance - game.hunterDistance);
    for (let i = 0; i < 60 * 20 && game.phase === 'playing'; i++) {
      alignToFork(game);
      game.update(DT, quiet);
    }
    expect(game.phase).toBe('playing');
    expect(Math.abs(game.distance - game.hunterDistance)).toBeGreaterThan(openingGap);
  });

  it('gets caught if you keep the hunter alert with claps', () => {
    const game = new SonarMaze();
    game.update(DT, { onset: true, level: 1 });
    for (let i = 0; i < 60 * 40 && game.phase === 'playing'; i++) {
      alignToFork(game);
      const onset = i % 6 === 0; // clapping far more than navigation needs
      game.update(DT, onset ? { onset: true, level: 1 } : quiet);
    }
    expect(game.phase).toBe('over');
    expect(game.caught).toBe(true);
  });

  it('clamps steering to the corridor width', () => {
    const game = new SonarMaze();
    for (let i = 0; i < 10; i++) game.steer(-1);
    expect(game.lane).toBe(0);
    for (let i = 0; i < 10; i++) game.steer(1);
    expect(game.lane).toBe(game.config.lanes - 1);
  });

  it('keeps the fork list bounded however long you play', () => {
    const game = new SonarMaze();
    game.update(DT, { onset: true, level: 0.3 });
    for (let i = 0; i < 60 * 120 && game.phase === 'playing'; i++) {
      alignToFork(game);
      game.update(DT, quiet);
    }
    expect(game.forks.length).toBeLessThan(20);
  });

  it('starts clean after a reset', () => {
    const game = new SonarMaze();
    game.update(DT, { onset: true, level: 0.3 });
    for (let i = 0; i < 60 * 20; i++) {
      alignToFork(game);
      game.update(DT, quiet);
    }
    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.score).toBe(0);
    expect(game.distance).toBe(0);
    expect(game.alertness).toBe(0);
    expect(game.forks.length).toBe(6);
  });
});
