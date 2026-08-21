/**
 * The one-time, app-wide microphone explainer. `main.ts`'s router shows this
 * ahead of *any* route — game, calibration, or the scope — the first time
 * someone ever opens the app, before a specific game's own mic gate
 * (`ui.ts`'s `overlay()`, or `sourceGate` in `source-picker.ts`) ever gets a
 * chance to ask the browser for permission. See docs/adr/0014.
 *
 * This is not a replacement for those per-game gates — it never opens a
 * session or touches the microphone itself, it only explains why the app is
 * about to ask, once, before the first of them appears.
 */
import { el, type Cleanup } from '../ui';

const COPY = [
  "Every game here listens to your voice, a clap, or the music you bring — that's the whole point.",
  'Everything runs on this device: the microphone signal is analysed right in the page, never recorded, and never sent anywhere.',
  "In a moment, a game will ask your browser for microphone access. That's normal — this is just the explanation before that prompt arrives cold.",
];

export function firstRunScreen(root: HTMLElement, onContinue: () => void): Cleanup {
  const button = el('button', { class: 'btn-primary', text: 'Got it' });
  button.addEventListener('click', onContinue);

  root.appendChild(
    el(
      'div',
      { class: 'screen screen--scroll' },
      el(
        'div',
        { class: 'stack' },
        el('h1', { text: 'Before we ask for your microphone' }),
        ...COPY.map((text) => el('p', { text })),
        button,
      ),
    ),
  );

  return () => {
    root.replaceChildren();
  };
}
