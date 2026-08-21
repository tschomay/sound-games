import './styles.css';
import { menuScreen } from './screens/menu';
import { calibrateScreen, voiceSetupScreen } from './screens/calibrate';
import { scopeScreen } from './screens/scope';
import { playScreen } from './screens/play';
import { firstRunScreen } from './screens/first-run';
import { findGame } from './games/registry';
import { stopSession } from './engine/session';
import { hasSeenFirstRun, markFirstRunSeen } from './engine/first-run';
import { registerServiceWorker } from './engine/service-worker';
import type { Screen } from './ui';

registerServiceWorker(import.meta.env.DEV);

/** Routes that are not games. Games come from the registry, keyed by id. */
const SCREENS: Record<string, Screen> = {
  '': menuScreen,
  calibrate: calibrateScreen,
  'voice-setup': voiceSetupScreen,
  scope: scopeScreen,
};

function screenFor(route: string): Screen {
  // hasOwn, not a plain lookup: `#/toString` would otherwise resolve an
  // Object.prototype member and hand the router a function that is not a screen.
  const fixed = Object.hasOwn(SCREENS, route) ? SCREENS[route] : undefined;
  if (fixed) return fixed;
  const game = findGame(route);
  if (game) return (root) => playScreen(root, game);
  return menuScreen;
}

const container = document.getElementById('app');
if (!container) throw new Error('#app is missing from the document.');
const root: HTMLElement = container;

let teardown: (() => void) | null = null;

function render(): void {
  teardown?.();
  root.replaceChildren();
  // Intercepts the very first route the app ever renders, regardless of which
  // game or screen the player was actually headed to — a one-time, app-wide
  // explainer ahead of any game's own mic gate. See engine/first-run.ts.
  if (!hasSeenFirstRun()) {
    teardown = firstRunScreen(root, () => {
      markFirstRunSeen();
      render();
    });
    return;
  }
  teardown = screenFor(window.location.hash.replace(/^#\/?/, ''))(root);
}

window.addEventListener('hashchange', render);

// A backgrounded tab gets no microphone audio anyway, and holding the mic open
// leaves the recording indicator lit, which reads as spyware.
window.addEventListener('pagehide', (event) => {
  stopSession();
  // A page frozen into the back/forward cache is restored with this exact DOM
  // and no script re-run, so tearing the screen down here would bring the
  // player back to a blank page with no way out but a reload.
  if (event.persisted) return;
  teardown?.();
  teardown = null;
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) render();
});

render();
