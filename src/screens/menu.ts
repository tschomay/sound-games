import { loadProfile } from '../engine/calibration';
import { bestScore } from '../engine/scores';
import { GAMES } from '../games/registry';
import { el, navigate, type Cleanup } from '../ui';
import type { CalibrationProfile } from '../engine/types';
import type { GameDefinition, Requirement } from '../engine/game';

/** The scope is a tool rather than a game, so it is listed separately. */
const TOOLS = [
  {
    route: 'scope',
    title: 'Signal scope',
    description:
      'Live view of every detector. For tuning, and for working out why a game is misreading you.',
  },
];

export function menuScreen(root: HTMLElement): Cleanup {
  const profile = loadProfile();

  const cards = GAMES.map((game) => gameCard(game, profile));
  const tools = TOOLS.map((tool) => {
    const card = el(
      'button',
      { class: 'card' },
      el('h2', { text: tool.title }),
      el('p', { text: tool.description }),
    );
    card.addEventListener('click', () => navigate(tool.route));
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
        ...tools,
      ),
    ),
  );

  return () => {
    root.replaceChildren();
  };
}

function gameCard(game: GameDefinition, profile: CalibrationProfile | null): HTMLElement {
  const missing = unmetRequirement(game.requires, profile);
  const best = bestScore(game.id);
  const card = el(
    'button',
    { class: 'card', 'data-disabled': missing ? 'true' : 'false' },
    el('h2', { text: game.title }),
    el('p', { text: game.description }),
    el(
      'p',
      { class: 'hint hint--access' },
      el('strong', { text: 'Without voice: ' }),
      game.accessibilityNote,
    ),
    missing
      ? el('span', { class: 'tag', text: missing })
      : best > 0
        ? el('span', { class: 'tag tag--ready', text: `Best: ${game.formatScore(best)}` })
        : null,
  );
  // A locked game sends you to the step it is waiting on, not to the top of a
  // flow you have already done.
  card.addEventListener('click', () =>
    navigate(missing ? (profile ? 'voice-setup' : 'calibrate') : game.id),
  );
  return card;
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
    setupRow({
      label: 'Device latency',
      detail:
        profile?.deviceLatencyMs != null && profile.deviceLatencyMs > 0
          ? `~${Math.round(profile.deviceLatencyMs)}ms compensated in Rhythm-Gated Combat and Drop Siege`
          : 'Optional — sharpens tap timing in the two beat-driven games',
      done: (profile?.deviceLatencyMs ?? 0) > 0,
      action: (profile?.deviceLatencyMs ?? 0) > 0 ? 'Redo' : 'Measure',
      route: profile ? 'latency-setup' : 'calibrate',
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
