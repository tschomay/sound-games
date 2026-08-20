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
        setupPanel(profile),
        ...cards,
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

/**
 * Calibration state, stated plainly and each half separately actionable.
 *
 * This used to be one line of hint text under the games, which made the two
 * halves invisible: someone who had calibrated saw nothing to suggest voice
 * control was a separate, optional thing they could add or redo.
 */
function setupPanel(profile: CalibrationProfile | null): HTMLElement {
  const rows = [
    setupRow({
      label: 'Room',
      detail: profile
        ? `Noise floor ${Math.round(profile.noiseFloorDb)} dB`
        : 'Not measured yet — every game needs this',
      done: profile !== null,
      action: profile ? 'Redo' : 'Set up',
      route: 'calibrate',
    }),
    setupRow({
      label: 'Voice control',
      detail: profile?.pitchRange
        ? `Range ${Math.round(profile.pitchRange.lowHz)}–${Math.round(profile.pitchRange.highHz)} Hz`
        : 'Optional — only for games you play by humming',
      done: profile?.pitchRange != null,
      action: profile?.pitchRange ? 'Redo' : 'Set up',
      // Without a room profile there is nothing to add a range to, so start at
      // the beginning instead of dropping them into a half-finished flow.
      route: profile ? 'voice-setup' : 'calibrate',
    }),
  ];
  return el('section', { class: 'setup' }, ...rows);
}

interface SetupRow {
  label: string;
  detail: string;
  done: boolean;
  action: string;
  route: string;
}

function setupRow(row: SetupRow): HTMLElement {
  const button = el('button', { class: 'btn-ghost setup-action', text: row.action });
  button.addEventListener('click', () => navigate(row.route));
  return el(
    'div',
    { class: 'setup-row', 'data-done': row.done ? 'true' : 'false' },
    el(
      'div',
      { class: 'setup-text' },
      el('strong', { text: row.label }),
      el('span', { class: 'hint', text: row.detail }),
    ),
    button,
  );
}
