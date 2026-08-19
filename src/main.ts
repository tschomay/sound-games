import './styles.css';
import { menuScreen } from './screens/menu';
import { calibrateScreen } from './screens/calibrate';
import { scopeScreen } from './screens/scope';
import { humFlyerScreen } from './games/hum-flyer/screen';
import { stopSession } from './engine/session';
import type { Screen } from './ui';

const ROUTES: Record<string, Screen> = {
  '': menuScreen,
  calibrate: calibrateScreen,
  scope: scopeScreen,
  'hum-flyer': humFlyerScreen,
};

const container = document.getElementById('app');
if (!container) throw new Error('#app is missing from the document.');
const root: HTMLElement = container;

let teardown: (() => void) | null = null;

function render(): void {
  teardown?.();
  root.replaceChildren();

  const route = window.location.hash.replace(/^#\/?/, '');
  const screen = ROUTES[route] ?? menuScreen;
  teardown = screen(root);
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
