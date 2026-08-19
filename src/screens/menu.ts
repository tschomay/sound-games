import { isCalibrated, loadProfile } from '../engine/calibration';
import { el, navigate, type Cleanup } from '../ui';

interface Entry {
  route: string;
  title: string;
  description: string;
  /** Games that read a calibration profile are listed but held back until one
   *  exists — see ADR-0003. */
  needsCalibration?: boolean;
}

const ENTRIES: Entry[] = [
  {
    route: 'calibrate',
    title: 'Calibrate',
    description: 'Measure your room and your voice. Do this first, and again whenever you change device or room.',
  },
  {
    route: 'hum-flyer',
    title: 'Hum Flyer',
    description: 'Hum to fly. Higher note, higher flight. Thread the gaps.',
    needsCalibration: true,
  },
  {
    route: 'scope',
    title: 'Signal scope',
    description: 'Live view of every detector. For tuning, and for working out why a game is misreading you.',
  },
];

export function menuScreen(root: HTMLElement): Cleanup {
  const calibrated = isCalibrated();
  const profile = loadProfile();

  const cards = ENTRIES.map((entry) => {
    const locked = entry.needsCalibration === true && !calibrated;
    const card = el(
      'button',
      { class: 'card', 'data-disabled': locked ? 'true' : 'false' },
      el('h2', { text: entry.title }),
      el('p', { text: entry.description }),
      locked ? el('span', { class: 'tag', text: 'Calibrate first' }) : null,
    );
    card.addEventListener('click', () => navigate(locked ? 'calibrate' : entry.route));
    return card;
  });

  const status = profile
    ? `Calibrated for ${Math.round(profile.lowHz)}–${Math.round(profile.highHz)} Hz.`
    : 'Not calibrated yet.';

  root.appendChild(
    el(
      'div',
      { class: 'screen screen--scroll' },
      el(
        'div',
        { class: 'stack' },
        el('h1', { text: 'Sound Games' }),
        el('p', { text: 'Games you play with your voice. Headphones recommended.' }),
        ...cards,
        el('p', { class: 'hint', text: status }),
      ),
    ),
  );

  return () => {
    root.replaceChildren();
  };
}
