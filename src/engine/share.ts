/**
 * Score sharing: a client-only share of a locally-recorded score. Nothing
 * about it needs to be verifiable or stored remotely, and there's no server
 * component — see `docs/roadmap.md`'s Phase 9 section. `screens/play.ts`'s
 * `showResults()` is the only caller; `shareScore` below is the pure decision
 * logic (which path was taken, and whether it actually worked), kept free of
 * the DOM so it can be unit-tested with a fake `navigator`-shaped object
 * instead of a real browser and a real game session.
 */

/** The live site, per `README.md`. */
export const SITE_URL = 'https://sound-games.vercel.app';

/**
 * The human-readable half of a share, shared by both paths: the Web Share
 * API's `text` field (which gets its own separate `url` field alongside it,
 * so the link doesn't belong in here) and the clipboard fallback (which has
 * nowhere else to put the link, so `shareMessage` below folds it in).
 */
export function shareSummary(gameTitle: string, scoreText: string): string {
  return `${gameTitle} — ${scoreText}`;
}

/** What actually gets copied to the clipboard when the Web Share API isn't
 *  available (or declines the share): the summary plus a link back, in one
 *  string, since a copied string is all a clipboard fallback has to work with. */
export function shareMessage(gameTitle: string, scoreText: string, url: string = SITE_URL): string {
  return `${shareSummary(gameTitle, scoreText)}. Play at ${url}`;
}

/** The bit of `Navigator` this needs — a structural subset so a test can hand
 *  in a plain object instead of a real browser. `share` is optional, exactly
 *  like the real API: its absence is how a browser says "no native sheet". */
export interface ShareTarget {
  share?(data: { title?: string; text?: string; url?: string }): Promise<void>;
  clipboard: { writeText(text: string): Promise<void> };
}

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

/**
 * Try the Web Share API first, falling back to the clipboard when it isn't
 * available or declines the payload. Never fails silently: the return value
 * always says what actually happened, so a caller can give the player a real
 * confirmation either way — the one exception is `'cancelled'`, a player
 * closing the native share sheet on their own, which is not a failure and
 * has nothing to confirm.
 */
export async function shareScore(
  target: ShareTarget,
  gameTitle: string,
  scoreText: string,
  url: string = SITE_URL,
): Promise<ShareOutcome> {
  if (typeof target.share === 'function') {
    try {
      await target.share({ title: 'Sound Games', text: shareSummary(gameTitle, scoreText), url });
      return 'shared';
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
      // Some platforms expose `navigator.share` but still reject certain
      // payloads or contexts — fall through to the clipboard below rather
      // than reporting failure when a second path might still work.
    }
  }

  try {
    await target.clipboard.writeText(shareMessage(gameTitle, scoreText, url));
    return 'copied';
  } catch {
    return 'failed';
  }
}
