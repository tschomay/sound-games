import { describe, expect, it } from 'vitest';
import { ClapRunner, DEFAULT_CONFIG, type Config, type Input } from '../game';

const DT = 1 / 60;

const idle: Input = { onset: false, level: 0, timbreClass: 'silence' };
const clap: Input = { onset: true, level: 0.7, timbreClass: 'transient' };
const glide: Input = { onset: false, level: 0.5, timbreClass: 'tonal' };
const shout: Input = { onset: false, level: 0.7, timbreClass: 'noisy' };

function run(game: ClapRunner, frames: number, input: Input = idle): void {
  for (let i = 0; i < frames; i++) {
    if (game.phase === 'over') return;
    game.update(DT, input);
  }
}

/**
 * How long, after a clap, the jump arc stays at/above `lowClearance` — the
 * window a low obstacle's crossing has to fit inside. Mirrors `jumpHeight()`
 * in `../game.ts`; kept separate on purpose so this is a check *against* that
 * implementation, not a copy of it.
 */
function clearanceWindow(config: Config): { start: number; duration: number } {
  const k = 1 - config.lowClearance / config.jumpPeakHeight;
  const half = Math.sqrt(k) * config.jumpDuration;
  const centre = config.jumpDuration / 2;
  return { start: centre - half / 2, duration: half };
}

/** Clap if a low obstacle is close enough that its zone will land under the
 *  arc's clearance window; idle otherwise. Used by the full-run test. */
function jumpInput(game: ClapRunner, config: Config): Input {
  if (game.jumping) return idle;
  const next = game.nextObstacle();
  if (!next || next.kind !== 'low') return idle;
  const window = clearanceWindow(config);
  const leadDistance = (window.start + window.duration / 2) * game.speed();
  return next.x - next.halfWidth - game.distance <= leadDistance ? clap : idle;
}

describe('ClapRunner defaults', () => {
  it('leaves enough clearance-window slack to clear a low obstacle at the slowest (start) speed', () => {
    // Regression guard: this exact arithmetic caught a real bug during
    // development, where the window was narrower than the crossing time and
    // no clap timing could ever clear the first obstacle. Speed only rises
    // from here, which shortens the crossing further, so start speed is the
    // hardest case.
    const crossing = (2 * DEFAULT_CONFIG.lowHalfWidth) / DEFAULT_CONFIG.startSpeed;
    const window = clearanceWindow(DEFAULT_CONFIG);
    expect(window.duration).toBeGreaterThan(crossing);
  });
});

describe('ClapRunner', () => {
  it('stays in ready until the first clap', () => {
    const game = new ClapRunner();
    run(game, 60);
    expect(game.phase).toBe('ready');
    expect(game.distance).toBe(0);
  });

  it('starts the round and a jump on the first clap', () => {
    const game = new ClapRunner();
    game.update(DT, clap);
    expect(game.phase).toBe('playing');
    expect(game.jumping).toBe(true);
  });

  it('jumpHeight is 0 before jumping, rises then falls back to 0 by the end of the arc', () => {
    const game = new ClapRunner();
    expect(game.jumpHeight()).toBe(0);
    game.update(DT, clap);
    run(game, 1); // one tick into the arc — 0 exactly at takeoff, by design
    const early = game.jumpHeight();
    expect(early).toBeGreaterThan(0);

    run(game, Math.round(DEFAULT_CONFIG.jumpDuration / DT / 2));
    const mid = game.jumpHeight();
    expect(mid).toBeGreaterThan(early);

    run(game, Math.round(DEFAULT_CONFIG.jumpDuration / DT));
    expect(game.jumpHeight()).toBe(0);
    expect(game.jumping).toBe(false);
  });

  it('crashes into a low obstacle if you never clap for it', () => {
    const game = new ClapRunner();
    game.update(DT, clap); // starts the round; this jump resolves long before the obstacle
    run(game, 600);
    expect(game.phase).toBe('over');
    expect(game.score).toBe(0);
  });

  it('clears a low obstacle when a clap times the jump arc over its zone', () => {
    // A lenient clearance/width isolates the collision *logic* from the
    // exact tuning of the default numbers (covered separately above): a wide
    // window and a narrow zone make the timing forgiving enough to drive
    // deterministically without hand-computing the physics down to the frame.
    const config: Config = { ...DEFAULT_CONFIG, lowClearance: 0.2, lowHalfWidth: 0.05 };
    const game = new ClapRunner(config);
    game.update(DT, clap); // starting jump — resolves long before the obstacle
    run(game, 90);

    const obstacle = game.nextObstacle();
    if (!obstacle || obstacle.kind !== 'low') throw new Error('expected a low obstacle first');

    const window = clearanceWindow(config);
    const leadDistance = (window.start + window.duration / 2) * game.speed();
    const clapAt = obstacle.x - obstacle.halfWidth - leadDistance;
    while (game.distance < clapAt) game.update(DT, idle);
    game.update(DT, clap);
    run(game, 180);

    expect(game.phase).toBe('playing');
    expect(game.score).toBeGreaterThanOrEqual(1);
  });

  it('glides across a gap while holding a sustained tone', () => {
    // Low obstacles neutralised (0 clearance needed — grounded already clears
    // them) so the run reaches the gap without needing jump timing here too.
    // Stop as soon as the gap (the second obstacle) is cleared, before
    // running into the breakable one right behind it — that one needs a
    // shout, which is a different test's job.
    const config: Config = { ...DEFAULT_CONFIG, lowClearance: 0 };
    const game = new ClapRunner(config);
    game.update(DT, clap);
    for (let i = 0; i < 2000 && game.phase === 'playing' && game.score < 2; i++) {
      game.update(DT, glide);
    }

    expect(game.phase).toBe('playing');
    expect(game.score).toBe(2); // the low, then the gap
  });

  it('crashes into a gap without gliding', () => {
    const config: Config = { ...DEFAULT_CONFIG, lowClearance: 0 };
    const game = new ClapRunner(config);
    game.update(DT, clap);
    run(game, 2000); // idle: clears the neutralised low, then hits the gap
    expect(game.phase).toBe('over');
    expect(game.score).toBe(1);
  });

  it('pounds through a breakable obstacle while shouting', () => {
    const config: Config = { ...DEFAULT_CONFIG, lowClearance: 0 };
    const game = new ClapRunner(config);
    game.update(DT, clap);
    // Clear the (neutralised) low and the gap by gliding, then stop right at
    // the gap so the next obstacle — the breakable one — still needs pounding.
    for (let i = 0; i < 2000 && game.phase === 'playing' && game.score < 2; i++) {
      game.update(DT, glide);
    }
    expect(game.score).toBe(2);

    for (let i = 0; i < 1500 && game.phase === 'playing' && game.score < 3; i++) {
      game.update(DT, shout);
    }

    expect(game.phase).toBe('playing');
    expect(game.score).toBe(3);
  });

  it('crashes into a breakable obstacle without ground-pounding', () => {
    const config: Config = { ...DEFAULT_CONFIG, lowClearance: 0 };
    const game = new ClapRunner(config);
    game.update(DT, clap);
    run(game, 3000, glide); // glide clears the neutralised low and the gap, not the breakable
    expect(game.phase).toBe('over');
    expect(game.score).toBe(2);
  });

  it('clears every obstacle kind across a full, well-played run', () => {
    const config: Config = { ...DEFAULT_CONFIG, lowClearance: 0.2, lowHalfWidth: 0.05 };
    const game = new ClapRunner(config);
    game.update(DT, clap);
    run(game, 90);

    for (let i = 0; i < 8000 && game.score < 9 && game.phase === 'playing'; i++) {
      const next = game.nextObstacle();
      if (next?.kind === 'gap') game.update(DT, glide);
      else if (next?.kind === 'breakable') game.update(DT, shout);
      else game.update(DT, jumpInput(game, config));
    }

    expect(game.phase).toBe('playing');
    expect(game.score).toBeGreaterThanOrEqual(9);
  });

  it('score increases speed up to the configured cap', () => {
    const game = new ClapRunner();
    expect(game.speed()).toBe(DEFAULT_CONFIG.startSpeed);
    game.score = 1000;
    expect(game.speed()).toBe(DEFAULT_CONFIG.maxSpeed);
  });

  it('resets cleanly back to a fresh ready round', () => {
    const game = new ClapRunner();
    game.update(DT, clap);
    run(game, 600);
    expect(game.phase).toBe('over');

    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.score).toBe(0);
    expect(game.distance).toBe(0);
    expect(game.jumping).toBe(false);
  });
});
