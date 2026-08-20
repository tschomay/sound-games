import { beforeEach, describe, expect, it } from 'vitest';
import { bestScore, clearScores, recordScore } from '../scores';

describe('scores', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reports zero for a game never played', () => {
    expect(bestScore('hum-flyer')).toBe(0);
  });

  it('reports the standing best when a score does not beat it', () => {
    recordScore('hum-flyer', 6);
    expect(recordScore('hum-flyer', 1)).toEqual({ best: 6, beaten: false });
  });

  it('records a first score', () => {
    expect(recordScore('hum-flyer', 4)).toEqual({ best: 4, beaten: true });
    expect(bestScore('hum-flyer')).toBe(4);
  });

  it('keeps the better score and says whether the best was beaten', () => {
    recordScore('hum-flyer', 7);
    expect(recordScore('hum-flyer', 3)).toEqual({ best: 7, beaten: false });
    expect(bestScore('hum-flyer')).toBe(7);
    expect(recordScore('hum-flyer', 8)).toEqual({ best: 8, beaten: true });
    expect(bestScore('hum-flyer')).toBe(8);
  });

  it('does not treat matching the best as beating it', () => {
    recordScore('hum-flyer', 5);
    expect(recordScore('hum-flyer', 5)).toEqual({ best: 5, beaten: false });
  });

  it('keeps games separate', () => {
    recordScore('hum-flyer', 5);
    recordScore('quiet-game', 2);
    expect(bestScore('hum-flyer')).toBe(5);
    expect(bestScore('quiet-game')).toBe(2);
  });

  it('rejects a score that is not a real number', () => {
    expect(recordScore('hum-flyer', Number.NaN)).toEqual({ best: 0, beaten: false });
    expect(bestScore('hum-flyer')).toBe(0);
  });

  it('survives junk in storage', () => {
    localStorage.setItem('sound-games:best', '{ not json');
    expect(bestScore('hum-flyer')).toBe(0);
    expect(recordScore('hum-flyer', 3)).toEqual({ best: 3, beaten: true });
  });

  it('ignores non-numeric entries rather than reporting them as scores', () => {
    localStorage.setItem('sound-games:best', JSON.stringify({ 'hum-flyer': 'lots' }));
    expect(bestScore('hum-flyer')).toBe(0);
  });

  it('clears everything', () => {
    recordScore('hum-flyer', 5);
    clearScores();
    expect(bestScore('hum-flyer')).toBe(0);
  });
});
