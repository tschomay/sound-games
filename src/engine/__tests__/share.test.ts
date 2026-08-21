import { describe, expect, it, vi } from 'vitest';
import { SITE_URL, shareMessage, shareScore, shareSummary, type ShareTarget } from '../share';

describe('shareSummary / shareMessage', () => {
  it('reads as "title — score"', () => {
    expect(shareSummary('Hum Flyer', '12 gates')).toBe('Hum Flyer — 12 gates');
  });

  it('folds a link back into the clipboard message', () => {
    expect(shareMessage('Hum Flyer', '12 gates', 'https://example.test')).toBe(
      'Hum Flyer — 12 gates. Play at https://example.test',
    );
  });

  it('defaults to the live site URL', () => {
    expect(shareMessage('Hum Flyer', '12 gates')).toContain(SITE_URL);
  });
});

function fakeTarget(overrides: Partial<ShareTarget> = {}): ShareTarget {
  return {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('shareScore', () => {
  it('uses the Web Share API when it exists and succeeds', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const target = fakeTarget({ share });

    const outcome = await shareScore(target, 'Hum Flyer', '12 gates', 'https://example.test');

    expect(outcome).toBe('shared');
    expect(share).toHaveBeenCalledWith({
      title: 'Sound Games',
      text: 'Hum Flyer — 12 gates',
      url: 'https://example.test',
    });
    expect(target.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('falls back to the clipboard when navigator.share does not exist', async () => {
    const target = fakeTarget(); // no `share` at all

    const outcome = await shareScore(target, 'Hum Flyer', '12 gates', 'https://example.test');

    expect(outcome).toBe('copied');
    expect(target.clipboard.writeText).toHaveBeenCalledWith(
      'Hum Flyer — 12 gates. Play at https://example.test',
    );
  });

  it('reports "cancelled", not a failure, when the player closes the native share sheet', async () => {
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const share = vi.fn().mockRejectedValue(abortError);
    const target = fakeTarget({ share });

    const outcome = await shareScore(target, 'Hum Flyer', '12 gates');

    expect(outcome).toBe('cancelled');
    expect(target.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('falls back to the clipboard when share() rejects for a reason other than a cancel', async () => {
    const share = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const target = fakeTarget({ share });

    const outcome = await shareScore(target, 'Hum Flyer', '12 gates');

    expect(outcome).toBe('copied');
    expect(target.clipboard.writeText).toHaveBeenCalledOnce();
  });

  it('reports "failed" — never silently — when both the share API and the clipboard are unavailable', async () => {
    const target = fakeTarget({
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });

    const outcome = await shareScore(target, 'Hum Flyer', '12 gates');

    expect(outcome).toBe('failed');
  });
});
