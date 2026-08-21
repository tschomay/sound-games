import { beforeEach, describe, expect, it } from 'vitest';
import { menuScreen } from '../menu';
import { GAMES } from '../../games/registry';
import { DEFAULT_PROFILE, saveProfile } from '../../engine/calibration';

describe('menuScreen accessibility notes', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders every game with a non-empty accessibility note on its card', () => {
    for (const game of GAMES) {
      expect(game.accessibilityNote.trim().length).toBeGreaterThan(0);
    }
  });

  it('shows each game\'s accessibility note text on its card in the menu', () => {
    const root = document.createElement('div');
    menuScreen(root);
    // Game cards carry `data-disabled`; the tools section's cards (the
    // signal scope) reuse the same `.card` class but not that attribute.
    const cards = Array.from(root.querySelectorAll('button.card[data-disabled]'));
    expect(cards).toHaveLength(GAMES.length);

    GAMES.forEach((game, index) => {
      const card = cards[index];
      expect(card.querySelector('.hint--access')?.textContent).toContain(
        game.accessibilityNote,
      );
    });
  });

  it('labels the accessibility line so it reads as an answer, not more description', () => {
    const root = document.createElement('div');
    menuScreen(root);
    const firstNote = root.querySelector('.hint--access');
    expect(firstNote?.querySelector('strong')?.textContent?.toLowerCase()).toContain('voice');
  });
});

describe('menuScreen device latency setup row', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('offers a "Measure" action, routed through calibrate, before anything is calibrated', () => {
    const root = document.createElement('div');
    menuScreen(root);
    const rows = Array.from(root.querySelectorAll('.setup-row'));
    const latencyRow = rows.find((row) => row.textContent?.includes('Device latency'));
    expect(latencyRow?.querySelector('button')?.textContent).toBe('Measure');
    expect(latencyRow?.getAttribute('data-done')).toBe('false');
  });

  it('offers "Redo" and reports the measured figure once a device latency is on file', () => {
    saveProfile({ ...DEFAULT_PROFILE, deviceLatencyMs: 42 });

    const root = document.createElement('div');
    menuScreen(root);
    const rows = Array.from(root.querySelectorAll('.setup-row'));
    const latencyRow = rows.find((row) => row.textContent?.includes('Device latency'));
    expect(latencyRow?.querySelector('button')?.textContent).toBe('Redo');
    expect(latencyRow?.getAttribute('data-done')).toBe('true');
    expect(latencyRow?.textContent).toContain('42');
  });
});
