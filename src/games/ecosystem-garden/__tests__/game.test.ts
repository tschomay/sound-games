import { describe, expect, it } from 'vitest';
import { EcosystemGarden, type Input } from '../game';

const DT = 1 / 60;

const silence: Input = { level: 0, bands: { bass: 0, lowMid: 0, mid: 0, high: 0 } };
const bassy: Input = { level: 0.3, bands: { bass: 0.9, lowMid: 0.2, mid: 0.1, high: 0.05 } };
const middy: Input = { level: 0.3, bands: { bass: 0.1, lowMid: 0.2, mid: 0.9, high: 0.05 } };
const highs: Input = { level: 0.3, bands: { bass: 0.1, lowMid: 0.1, mid: 0.1, high: 0.9 } };
const loud: Input = { level: 0.8, bands: { bass: 0.3, lowMid: 0.3, mid: 0.3, high: 0.3 } };
const scare: Input = { level: 0.95, bands: { bass: 0.1, lowMid: 0.1, mid: 0.1, high: 0.1 } };
const moderate: Input = { level: 0.3, bands: { bass: 0.2, lowMid: 0.2, mid: 0.2, high: 0.2 } };

/** Sustain some sound long enough to leave the 'ready' phase. */
function begin(game: EcosystemGarden, input: Input = moderate): void {
  for (let i = 0; i < 60; i++) game.update(DT, input);
}

describe('EcosystemGarden', () => {
  it('stays in ready while the room is silent', () => {
    const game = new EcosystemGarden();
    for (let i = 0; i < 120; i++) game.update(DT, silence);
    expect(game.phase).toBe('ready');
    expect(game.elapsed).toBe(0);
  });

  it('starts once there is sustained sound', () => {
    const game = new EcosystemGarden();
    begin(game);
    expect(game.phase).toBe('playing');
  });

  it('grows from sustained bass energy', () => {
    const game = new EcosystemGarden();
    begin(game);
    const before = game.growth;
    for (let i = 0; i < 60 * 5; i++) game.update(DT, bassy);
    expect(game.growth).toBeGreaterThan(before);
  });

  it('caps growth at 1 no matter how long bass plays', () => {
    const game = new EcosystemGarden();
    begin(game);
    for (let i = 0; i < 60 * 600; i++) game.update(DT, bassy);
    expect(game.growth).toBeLessThanOrEqual(1);
  });

  it('spawns creatures from sustained mid energy', () => {
    const game = new EcosystemGarden();
    begin(game);
    expect(game.creatures.length).toBe(0);
    for (let i = 0; i < 60 * 5; i++) game.update(DT, middy);
    expect(game.creatures.length).toBeGreaterThan(0);
  });

  it('keeps the creature population capped', () => {
    const game = new EcosystemGarden();
    begin(game);
    for (let i = 0; i < 60 * 300; i++) game.update(DT, middy);
    expect(game.creatures.length).toBeLessThanOrEqual(game.config.maxCreatures);
  });

  it('turns sustained high energy into rainy weather', () => {
    const game = new EcosystemGarden();
    begin(game);
    expect(game.weather).toBe('sun');
    for (let i = 0; i < 60 * 3; i++) game.update(DT, highs);
    expect(game.weather).toBe('rain');
  });

  it('weather clears again once the highs stop', () => {
    const game = new EcosystemGarden();
    begin(game);
    for (let i = 0; i < 60 * 3; i++) game.update(DT, highs);
    expect(game.weather).toBe('rain');
    for (let i = 0; i < 60 * 3; i++) game.update(DT, silence);
    expect(game.weather).toBe('sun');
  });

  it('sustained loud passages escalate into a predator', () => {
    const game = new EcosystemGarden();
    begin(game);
    expect(game.predators.length).toBe(0);
    for (let i = 0; i < 60 * 15 && game.predators.length === 0; i++) {
      game.update(DT, loud);
    }
    expect(game.predators.length).toBeGreaterThan(0);
  });

  it('an unmanaged predator drains health and can end the round', () => {
    const game = new EcosystemGarden();
    begin(game);
    // Get a predator spawned, then keep the music loud (but never crossing the
    // scare threshold) so nothing ever scares it off.
    for (let i = 0; i < 60 * 300 && game.phase === 'playing'; i++) {
      game.update(DT, loud);
    }
    expect(game.phase).toBe('over');
    expect(game.destroyed).toBe(true);
    expect(game.health).toBe(0);
  });

  it('a deliberate loud burst scares a predator off and stops the damage', () => {
    const game = new EcosystemGarden();
    begin(game);
    for (let i = 0; i < 60 * 15 && game.predators.length === 0; i++) {
      game.update(DT, loud);
    }
    expect(game.predators.length).toBeGreaterThan(0);
    const healthBeforeScare = game.health;
    const scoreBeforeScare = game.score;

    // A rising edge across the scare threshold: quiet first, then the burst.
    game.update(DT, silence);
    game.update(DT, scare);
    expect(game.predators.some((p) => p.fleeing)).toBe(true);

    // Ride out the flee duration in silence; the predator should be gone and
    // health should have stopped draining (it may even have regenerated).
    for (let i = 0; i < 60 * 3; i++) game.update(DT, silence);
    expect(game.predators.length).toBe(0);
    expect(game.health).toBeGreaterThanOrEqual(healthBeforeScare);
    expect(game.score).toBeGreaterThan(scoreBeforeScare);
  });

  it('regenerates health once every predator is gone', () => {
    const game = new EcosystemGarden();
    begin(game);
    for (let i = 0; i < 60 * 15 && game.predators.length === 0; i++) {
      game.update(DT, loud);
    }
    game.update(DT, silence);
    game.update(DT, scare);
    for (let i = 0; i < 60 * 3; i++) game.update(DT, silence);
    expect(game.predators.length).toBe(0);
    const health = game.health;
    for (let i = 0; i < 60 * 2; i++) game.update(DT, silence);
    expect(game.health).toBeGreaterThanOrEqual(health);
  });

  it('keeps predator and creature lists bounded through a very long session', () => {
    const game = new EcosystemGarden();
    begin(game);
    for (let i = 0; i < 60 * 60 * 5 && game.phase === 'playing'; i++) {
      // Alternate loud and quiet so predators keep spawning and getting
      // scared off, exercising the churn, not just steady state.
      const frame = Math.floor(i / 300) % 2 === 0 ? loud : scare;
      game.update(DT, frame);
    }
    expect(game.predators.length).toBeLessThanOrEqual(6);
    expect(game.creatures.length).toBeLessThanOrEqual(24);
  });

  it('accumulates score while the garden survives', () => {
    const game = new EcosystemGarden();
    begin(game);
    for (let i = 0; i < 60 * 10; i++) game.update(DT, moderate);
    expect(game.score).toBeGreaterThan(0);
  });

  it('stops scoring once the garden is destroyed', () => {
    const game = new EcosystemGarden();
    begin(game);
    for (let i = 0; i < 60 * 300 && game.phase === 'playing'; i++) {
      game.update(DT, loud);
    }
    expect(game.phase).toBe('over');
    const score = game.score;
    for (let i = 0; i < 60; i++) game.update(DT, loud);
    expect(game.score).toBe(score);
  });

  it('starts clean after a reset', () => {
    const game = new EcosystemGarden();
    begin(game);
    for (let i = 0; i < 60 * 20; i++) game.update(DT, loud);
    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.score).toBe(0);
    expect(game.health).toBe(game.config.maxHealth);
    expect(game.growth).toBe(0);
    expect(game.creatures.length).toBe(0);
    expect(game.predators.length).toBe(0);
  });
});
