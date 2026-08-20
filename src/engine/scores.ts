/** Best score per game, kept on the device. */
const STORAGE_KEY = 'sound-games:best';

type Scores = Record<string, number>;

function read(): Scores {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const scores: Scores = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) scores[id] = value;
    }
    return scores;
  } catch {
    return {};
  }
}

export function bestScore(gameId: string): number {
  return read()[gameId] ?? 0;
}

/** Records a score if it beats the stored one. Returns true when it did. */
export function recordScore(gameId: string, score: number): boolean {
  if (!Number.isFinite(score)) return false;
  const scores = read();
  if ((scores[gameId] ?? 0) >= score) return false;
  scores[gameId] = score;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scores));
  } catch {
    // Private browsing — the score just won't persist.
  }
  return true;
}

export function clearScores(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
