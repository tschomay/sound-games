import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Overtone, normaliseBrightness, type Config, type Input } from '../game';

const DT = 1 / 60;

const silent: Input = { centroid: 0, bassLevel: 0, level: 0 };
const present = (overrides: Partial<Input> = {}): Input => ({
  centroid: 800,
  bassLevel: 0,
  level: 0.5,
  ...overrides,
});
const bassHit: Input = present({ bassLevel: 0.9 });
const bassLow: Input = present({ bassLevel: 0.1 });

/** Sustain enough presence to leave 'ready'. */
function begin(game: Overtone, frames = 30): void {
  for (let i = 0; i < frames; i++) game.update(DT, present());
}

describe('normaliseBrightness', () => {
  it('maps the low end of the range to 0 and the high end to 1', () => {
    expect(normaliseBrightness(DEFAULT_CONFIG.centroidLowHz)).toBeCloseTo(0, 5);
    expect(normaliseBrightness(DEFAULT_CONFIG.centroidHighHz)).toBeCloseTo(1, 5);
  });

  it('maps the geometric mean to 0.5, since the scale is log-spaced', () => {
    const mid = Math.sqrt(DEFAULT_CONFIG.centroidLowHz * DEFAULT_CONFIG.centroidHighHz);
    expect(normaliseBrightness(mid)).toBeCloseTo(0.5, 5);
  });

  it('clamps outside the range and treats non-positive Hz as 0', () => {
    expect(normaliseBrightness(1)).toBe(0);
    expect(normaliseBrightness(50_000)).toBe(1);
    expect(normaliseBrightness(0)).toBe(0);
    expect(normaliseBrightness(-10)).toBe(0);
  });
});

describe('Overtone clearance defaults', () => {
  it('leaves enough clearance-window slack to clear an obstacle at the slowest (start) speed', () => {
    // Regression guard mirroring Clap Runner's own test: this arithmetic
    // catches a config change that quietly makes the first obstacle
    // untimeable no matter how well the tap is placed.
    const crossing = (2 * DEFAULT_CONFIG.obstacleHalfWidth) / DEFAULT_CONFIG.startSpeed;
    const k = 1 - DEFAULT_CONFIG.clearance / DEFAULT_CONFIG.jumpPeakHeight;
    const windowDuration = Math.sqrt(k) * DEFAULT_CONFIG.jumpDuration;
    expect(windowDuration).toBeGreaterThan(crossing);
  });
});

describe('Overtone', () => {
  it('stays in ready while there is no sound', () => {
    const game = new Overtone();
    for (let i = 0; i < 120; i++) game.update(DT, silent);
    expect(game.phase).toBe('ready');
    expect(game.distance).toBe(0);
    expect(game.score).toBe(0);
  });

  it('does not start on a brief burst of sound', () => {
    const game = new Overtone();
    for (let i = 0; i < 5; i++) game.update(DT, present());
    expect(game.phase).toBe('ready');
  });

  it('starts once presence is sustained for the hold time', () => {
    const game = new Overtone();
    begin(game);
    expect(game.phase).toBe('playing');
  });

  it('resets the presence hold if sound drops before the hold time is met', () => {
    const game = new Overtone();
    const framesShortOfHold = Math.round(DEFAULT_CONFIG.readyHoldTime / DT) - 2;
    for (let i = 0; i < framesShortOfHold; i++) game.update(DT, present());
    expect(game.phase).toBe('ready');
    game.update(DT, silent); // drops presence, resetting the hold timer
    for (let i = 0; i < framesShortOfHold; i++) game.update(DT, present());
    expect(game.phase).toBe('ready'); // would have started already if the hold hadn't reset
  });

  it('accumulates score as distance travelled once playing', () => {
    const game = new Overtone();
    begin(game);
    expect(game.phase).toBe('playing');
    const scoreAfterStart = game.score;
    for (let i = 0; i < 60; i++) game.update(DT, present());
    expect(game.score).toBeGreaterThan(scoreAfterStart);
    expect(game.score).toBeCloseTo(game.distance, 10);
  });

  it('does not advance distance while still in ready', () => {
    const game = new Overtone();
    for (let i = 0; i < 20; i++) game.update(DT, present());
    // Not yet past readyHoldTime, so distance must still be 0.
    expect(game.distance).toBe(0);
  });

  it('speed ramps up with distance and caps at maxSpeed', () => {
    const game = new Overtone();
    expect(game.speed()).toBe(DEFAULT_CONFIG.startSpeed);
    begin(game);
    game.distance = 1_000_000;
    expect(game.speed()).toBe(DEFAULT_CONFIG.maxSpeed);
  });

  it('pushes new terrain samples toward bright input, smoothed rather than snapped', () => {
    const game = new Overtone();
    begin(game);

    const bright = present({ centroid: DEFAULT_CONFIG.centroidHighHz * 2 }); // clamps to 1
    // One single frame of extreme brightness should barely move a
    // newly-pushed leading sample: a jittery frame must not bake a spike in.
    game.update(DT, bright);
    game.update(DT, present()); // back to mid brightness
    const leadingAfterOneFrame = game.terrain[game.terrain.length - 1].height;
    expect(leadingAfterOneFrame).toBeLessThan(0.6);

    // Sustained bright input, long enough for the chase to mostly converge
    // and for fresh samples to be pushed while it's converged, should push
    // terrain height close to 1.
    for (let i = 0; i < 300; i++) game.update(DT, bright);
    const leadingAfterSustained = game.terrain[game.terrain.length - 1].height;
    expect(leadingAfterSustained).toBeGreaterThan(0.9);
  });

  it('flattens terrain toward dark/warm input the same way', () => {
    const game = new Overtone();
    begin(game);
    const dark = present({ centroid: DEFAULT_CONFIG.centroidLowHz / 2 }); // clamps to 0
    for (let i = 0; i < 300; i++) game.update(DT, dark);
    const leading = game.terrain[game.terrain.length - 1].height;
    expect(leading).toBeLessThan(0.1);
  });

  it('interpolates heightAt between the two nearest samples', () => {
    const game = new Overtone();
    game.terrain = [
      { x: 0, height: 0 },
      { x: 1, height: 1 },
    ];
    expect(game.heightAt(0)).toBe(0);
    expect(game.heightAt(1)).toBe(1);
    expect(game.heightAt(0.5)).toBeCloseTo(0.5, 10);
  });

  it('spawns an obstacle on a bass rising edge', () => {
    const game = new Overtone();
    begin(game);
    expect(game.obstacles).toHaveLength(0);
    game.update(DT, bassLow); // stays under threshold, no edge yet
    expect(game.obstacles).toHaveLength(0);
    game.update(DT, bassHit); // rising edge across bassThreshold
    expect(game.obstacles).toHaveLength(1);
  });

  it('does not spawn on a sustained bass note, only on the rising edge', () => {
    const game = new Overtone();
    begin(game);
    game.update(DT, bassHit);
    expect(game.obstacles).toHaveLength(1);
    for (let i = 0; i < 30; i++) game.update(DT, bassHit); // held above threshold
    expect(game.obstacles).toHaveLength(1);
  });

  it('respects the spawn cooldown between separate bass hits', () => {
    const game = new Overtone();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit); // first rising edge
    expect(game.obstacles).toHaveLength(1);

    game.update(DT, bassLow); // drop back under threshold
    game.update(DT, bassHit); // a second rising edge, immediately after
    expect(game.obstacles).toHaveLength(1); // still within cooldown

    for (let i = 0; i < Math.ceil(DEFAULT_CONFIG.spawnCooldown / DT) + 2; i++) {
      game.update(DT, bassLow);
    }
    game.update(DT, bassHit); // a third edge, now past the cooldown
    expect(game.obstacles).toHaveLength(2);
  });

  it('places a spawned obstacle at the current leading terrain edge', () => {
    const game = new Overtone();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    const obstacle = game.obstacles[0];
    const leading = game.terrain[game.terrain.length - 1];
    expect(obstacle.x).toBe(leading.x);
    expect(obstacle.groundHeight).toBe(leading.height);
  });

  it('jumpHeight is 0 before jumping, rises then falls back to 0 by the end of the arc', () => {
    const game = new Overtone();
    begin(game); // the arc only advances while playing
    expect(game.jumpHeight()).toBe(0);
    game.jump();
    game.update(DT, present());
    const early = game.jumpHeight();
    expect(early).toBeGreaterThan(0);

    for (let i = 0; i < Math.round(DEFAULT_CONFIG.jumpDuration / DT / 2); i++) game.update(DT, present());
    const mid = game.jumpHeight();
    expect(mid).toBeGreaterThan(early);

    for (let i = 0; i < Math.round(DEFAULT_CONFIG.jumpDuration / DT); i++) game.update(DT, present());
    expect(game.jumpHeight()).toBe(0);
    expect(game.jumping).toBe(false);
  });

  it('re-tapping mid-air restarts the jump arc', () => {
    const game = new Overtone();
    begin(game);
    game.jump();
    for (let i = 0; i < 20; i++) game.update(DT, present());
    expect(game.jumping).toBe(true);
    game.jump();
    expect(game.jumpElapsed).toBe(0);
  });

  it('ends the round when an obstacle is crossed without enough jump height', () => {
    const config: Config = { ...DEFAULT_CONFIG, obstacleHalfWidth: 0.3 };
    const game = new Overtone(config);
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit); // spawns a rock right at the leading edge

    // Never jump: ride straight into it.
    for (let i = 0; i < 3000 && game.phase === 'playing'; i++) {
      game.update(DT, present());
    }
    expect(game.phase).toBe('over');
  });

  it('survives an obstacle when a well-timed tap clears it', () => {
    const config: Config = { ...DEFAULT_CONFIG, obstacleHalfWidth: 0.05 };
    const game = new Overtone(config);
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    const obstacle = game.obstacles[0];

    // Time the tap so the arc's peak lands right on the obstacle.
    const leadDistance = (config.jumpDuration / 2) * game.speed();
    const approachTarget = obstacle.x - obstacle.halfWidth - leadDistance;
    for (let i = 0; i < 2000 && game.distance < approachTarget; i++) {
      game.update(DT, present());
    }
    expect(game.distance).toBeGreaterThanOrEqual(approachTarget); // sanity: approach actually reached
    game.jump();
    for (let i = 0; i < Math.round(config.jumpDuration / DT) + 5 && game.phase === 'playing'; i++) {
      game.update(DT, present());
    }

    expect(game.phase).toBe('playing');
    expect(game.obstacles[0].cleared).toBe(true);
  });

  it('drops terrain and obstacles well behind the player without growing without bound', () => {
    const game = new Overtone();
    begin(game);
    for (let i = 0; i < 60 * 30; i++) {
      const bass = i % 40 === 0 ? bassHit : bassLow;
      game.update(DT, present({ bassLevel: bass.bassLevel }));
    }
    expect(game.terrain.length).toBeLessThan(50);
    expect(game.obstacles.length).toBeLessThan(50);
  });

  it('resets cleanly back to a fresh ready round', () => {
    const game = new Overtone();
    begin(game);
    game.jump();
    for (let i = 0; i < 60; i++) game.update(DT, present());
    const distanceBefore = game.distance;
    expect(distanceBefore).toBeGreaterThan(0);

    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.score).toBe(0);
    expect(game.distance).toBe(0);
    expect(game.jumping).toBe(false);
    expect(game.obstacles).toHaveLength(0);
    expect(game.terrain.every((sample) => sample.height === 0.5)).toBe(true);
  });
});
