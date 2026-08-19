import { describe, expect, it } from 'vitest';
import { HumFlyer, type Input } from '../game';

const DT = 1 / 60;

const silence: Input = { voiced: false, pitchNorm: null, level: 0 };
const humming = (pitchNorm: number): Input => ({ voiced: true, pitchNorm, level: 0.6 });

/** Fly the course perfectly by always singing the note the next gap sits at. */
function flyWell(game: HumFlyer, frames: number): void {
  for (let i = 0; i < frames; i++) {
    const target = game.nextGate()?.centre ?? 0.5;
    game.update(DT, humming(target));
  }
}

describe('HumFlyer', () => {
  it('waits for a sound before the course starts moving', () => {
    const game = new HumFlyer();
    for (let i = 0; i < 60; i++) game.update(DT, silence);
    expect(game.phase).toBe('ready');
    expect(game.distance).toBe(0);
  });

  it('takes off when you start humming', () => {
    const game = new HumFlyer();
    game.update(DT, humming(0.5));
    expect(game.phase).toBe('flying');
  });

  it('scores when you sing the melody', () => {
    const game = new HumFlyer();
    flyWell(game, 60 * 20);
    expect(game.phase).toBe('flying');
    expect(game.score).toBeGreaterThan(3);
  });

  it('crashes if you hold one note through the whole melody', () => {
    const game = new HumFlyer();
    for (let i = 0; i < 60 * 20 && game.phase !== 'crashed'; i++) {
      game.update(DT, humming(0.9));
    }
    expect(game.phase).toBe('crashed');
  });

  it('lets you take a breath without falling out of the sky', () => {
    const game = new HumFlyer();
    flyWell(game, 120);
    const height = game.height;
    for (let i = 0; i < 9; i++) game.update(DT, silence); // 150ms
    expect(game.phase).toBe('flying');
    expect(game.height).toBeCloseTo(height, 2);
  });

  it('falls when you stop making a sound', () => {
    const game = new HumFlyer();
    flyWell(game, 120);
    const height = game.height;
    for (let i = 0; i < 30; i++) game.update(DT, silence);
    expect(game.height).toBeLessThan(height);
  });

  it('ends the round if you stay silent all the way down', () => {
    const game = new HumFlyer();
    game.update(DT, humming(0.5));
    for (let i = 0; i < 60 * 10 && game.phase !== 'crashed'; i++) game.update(DT, silence);
    expect(game.phase).toBe('crashed');
  });

  it('speeds up and tightens the gaps as you go', () => {
    const game = new HumFlyer();
    const openingSpeed = game.speed();
    const openingGap = game.gates[0].halfGap;
    flyWell(game, 60 * 30);
    expect(game.speed()).toBeGreaterThan(openingSpeed);
    expect(game.nextGate()!.halfGap).toBeLessThan(openingGap);
  });

  it('never lets the gaps close past the playable minimum', () => {
    const game = new HumFlyer();
    flyWell(game, 60 * 240);
    for (const gate of game.gates) {
      expect(gate.halfGap).toBeGreaterThanOrEqual(game.config.minHalfGap);
    }
  });

  it('keeps the course bounded however long you fly', () => {
    const game = new HumFlyer();
    flyWell(game, 60 * 240);
    expect(game.gates.length).toBeLessThan(20);
  });

  it('starts clean after a reset', () => {
    const game = new HumFlyer();
    flyWell(game, 60 * 20);
    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.score).toBe(0);
    expect(game.distance).toBe(0);
    expect(game.height).toBe(0.5);
  });

  it('remembers your best score across rounds', () => {
    const game = new HumFlyer();
    flyWell(game, 60 * 20);
    const best = game.score;
    game.reset();
    expect(game.best).toBe(best);
  });
});
