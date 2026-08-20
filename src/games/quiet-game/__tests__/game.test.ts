import { describe, expect, it } from 'vitest';
import { QuietGame, type Input } from '../game';

const DT = 1 / 60;

const quiet: Input = { level: 0 };
const shout: Input = { level: 0.9 };

/** Hold quiet long enough to leave the 'ready' phase. */
function begin(game: QuietGame): void {
  for (let i = 0; i < 60; i++) game.update(DT, quiet);
}

/** Sneak the whole run: silent past guards, shouting only to break glass. */
function sneakWell(game: QuietGame, frames: number): void {
  for (let i = 0; i < frames; i++) {
    const next = game.nextObstacle();
    game.update(DT, next?.kind === 'glass' ? shout : quiet);
  }
}

describe('QuietGame', () => {
  it('stays in ready while the room is too loud to start', () => {
    const game = new QuietGame();
    for (let i = 0; i < 60; i++) game.update(DT, shout);
    expect(game.phase).toBe('ready');
    expect(game.distance).toBe(0);
  });

  it('starts once you hold quiet for a beat', () => {
    const game = new QuietGame();
    begin(game);
    expect(game.phase).toBe('playing');
  });

  it('resets the quiet hold if you make noise before it completes', () => {
    const game = new QuietGame();
    for (let i = 0; i < 20; i++) game.update(DT, quiet);
    game.update(DT, shout);
    for (let i = 0; i < 20; i++) game.update(DT, quiet);
    expect(game.phase).toBe('ready');
  });

  it('scores by sneaking past guards and shattering glass', () => {
    const game = new QuietGame();
    begin(game);
    sneakWell(game, 60 * 40);
    expect(game.phase).toBe('playing');
    expect(game.score).toBeGreaterThan(4);
  });

  it('gets caught if you stay loud through a whole guard zone', () => {
    const game = new QuietGame();
    begin(game);
    for (let i = 0; i < 60 * 15 && game.phase === 'playing'; i++) {
      game.update(DT, shout);
    }
    expect(game.phase).toBe('over');
  });

  it('lets a brief loud blip decay away instead of catching you', () => {
    const game = new QuietGame();
    begin(game);
    // Get well into the first guard's zone before the blip.
    for (let i = 0; i < 60 * 5; i++) game.update(DT, quiet);
    expect(game.phase).toBe('playing');
    for (let i = 0; i < 6; i++) game.update(DT, shout); // 100ms
    for (let i = 0; i < 60; i++) game.update(DT, quiet);
    expect(game.phase).toBe('playing');
  });

  it('crashes into a glass panel you never shout at', () => {
    const game = new QuietGame();
    begin(game);
    for (let i = 0; i < 60 * 60 && game.phase === 'playing'; i++) {
      game.update(DT, quiet);
    }
    expect(game.phase).toBe('over');
  });

  it('shatters a glass panel when you shout inside its window', () => {
    const game = new QuietGame();
    begin(game);
    while (game.nextObstacle()?.kind !== 'glass') {
      game.update(DT, quiet);
    }
    for (let i = 0; i < 60 * 20 && game.phase === 'playing'; i++) {
      const next = game.nextObstacle();
      game.update(DT, next?.kind === 'glass' ? shout : quiet);
      if (next?.kind === 'glass' && next.shattered) break;
    }
    expect(game.phase).toBe('playing');
  });

  it('gets less forgiving as the score climbs', () => {
    const game = new QuietGame();
    begin(game);
    const openingSpeed = game.speed();
    sneakWell(game, 60 * 40);
    expect(game.speed()).toBeGreaterThan(openingSpeed);
  });

  it('keeps the obstacle list bounded however long you play', () => {
    const game = new QuietGame();
    begin(game);
    sneakWell(game, 60 * 120);
    expect(game.obstacles.length).toBeLessThan(20);
  });

  it('starts clean after a reset', () => {
    const game = new QuietGame();
    begin(game);
    sneakWell(game, 60 * 20);
    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.score).toBe(0);
    expect(game.distance).toBe(0);
    expect(game.obstacles.length).toBe(6);
  });
});
