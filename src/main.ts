import './styles.css';
import { menuScreen } from './screens/menu';
import { calibrateScreen, voiceSetupScreen } from './screens/calibrate';
import { scopeScreen } from './screens/scope';
import { playScreen } from './screens/play';
import { findGame } from './games/registry';
import { stopSession } from './engine/session';
import type { Screen } from './ui';

/** Routes that are not games. Games come from the registry, keyed by id. */
const SCREENS: Record<string, Screen> = {
  '': menuScreen,
  calibrate: calibrateScreen,
  'voice-setup': voiceSetupScreen,
  scope: scopeScreen,
};

function screenFor(route: string): Screen {
  const fixed = SCREENS[route];
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
  teardown = screenFor(window.location.hash.replace(/^#\/?/, ''))(root);
}

window.addEventListener('hashchange', render);

// A backgrounded tab gets no microphone audio anyway, and holding the mic open
// leaves the recording indicator lit, which reads as spyware.
window.addEventListener('pagehide', () => {
  teardown?.();
  teardown = null;
  stopSession();
});

render();
