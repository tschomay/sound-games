import { loadProfile } from '../engine/calibration';
import { el, navigate, type Cleanup } from '../ui';
import type { CalibrationProfile } from '../engine/types';

/**
 * What a game needs measured before it can run. Games declare it rather than
 * checking themselves, so the menu can say *why* something is locked — see
 * ADR-0004.
 */
type Requirement = 'room' | 'pitchRange';

interface Entry {
  route: string;
  title: string;
  description: string;
  requires: Requirement | null;
}

const ENTRIES: Entry[] = [
  {
    route: 'calibrate',
    title: 'Calibrate',
    description: 'Measure your room, and optionally your voice. Do this first, and again whenever you change device or room.',
    requires: null,
  },
  {
    route: 'hum-flyer',
    title: 'Hum Flyer',
    description: 'Hum to fly. Higher note, higher flight. Thread the gaps.',
    requires: 'pitchRange',
  },
  {
    route: 'scope',
    title: 'Signal scope',
    description: 'Live view of every detector. For tuning, and for working out why a game is misreading you.',
    requires: null,
  },
];

export function menuScreen(root: HTMLElement): Cleanup {
  const profile = loadProfile();

  const cards = ENTRIES.map((entry) => {
    const missing = unmetRequirement(entry.requires, profile);
    const card = el(
      'button',
      { class: 'card', 'data-disabled': missing ? 'true' : 'false' },
      el('h2', { text: entry.title }),
      el('p', { text: entry.description }),
      missing ? el('span', { class: 'tag', text: missing }) : null,
    );
    card.addEventListener('click', () => navigate(missing ? 'calibrate' : entry.route));
    return card;
  });

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
        el('p', { class: 'hint', text: statusText(profile) }),
      ),
    ),
  );

  return () => {
    root.replaceChildren();
  };
}

/** The label to show on a locked card, or null when the game is playable. */
function unmetRequirement(
  requires: Requirement | null,
  profile: CalibrationProfile | null,
): string | null {
  if (requires === null) return null;
  if (profile === null) return 'Calibrate first';
  if (requires === 'pitchRange' && profile.pitchRange === null) return 'Needs voice setup';
  return null;
}

function statusText(profile: CalibrationProfile | null): string {
  if (!profile) return 'Not calibrated yet.';
  if (!profile.pitchRange) {
    return 'Room calibrated. Voice control not set up yet.';
  }
  const { lowHz, highHz } = profile.pitchRange;
  return `Calibrated, with a voice range of ${Math.round(lowHz)}–${Math.round(highHz)} Hz.`;
}
