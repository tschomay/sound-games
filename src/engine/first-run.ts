/**
 * Whether the app-wide "why this app wants your microphone" explainer has
 * already been shown, once, ever — see `screens/first-run.ts` and
 * docs/adr/0014. Same versioned-key-plus-try/catch shape as
 * `engine/calibration.ts`: a bumped `VERSION` re-shows the explainer if its
 * wording ever changes enough to matter, and storage failures (private
 * browsing) degrade quietly rather than throwing.
 */
const STORAGE_KEY = 'sound-games:first-run';
const VERSION = 1;

/** True once the explainer has been shown for this stored version. */
export function hasSeenFirstRun(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === String(VERSION);
  } catch {
    // Private browsing, or storage disabled: treat as unseen. The explainer
    // will simply show again next time too — there is nowhere to remember it.
    return false;
  }
}

export function markFirstRunSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(VERSION));
  } catch {
    // Ignore — the flag just won't persist, same tradeoff as above.
  }
}
