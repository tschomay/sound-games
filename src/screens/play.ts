/**
 * The shell every game is played inside.
 *
 * Owns the microphone gate, the canvas, the frame loop, pausing, restarts, the
 * results screen and high scores — so a game only implements rules and a
 * picture. See `engine/game.ts`.
 */
import { ensureMicSession, stopSession } from '../engine/session';
import { createSurface, startLoop, type Surface } from '../engine/canvas';
import { DEFAULT_PROFILE, loadProfile } from '../engine/calibration';
import { bestScore, recordScore } from '../engine/scores';
import { el, navigate, overlay, topbar, type Cleanup } from '../ui';
import type { GameDefinition } from '../engine/game';

export function playScreen(root: HTMLElement, definition: GameDefinition): Cleanup {
  const profile = loadProfile();
  if (!meetsRequirement(definition, profile)) {
    navigate(profile && definition.requires === 'pitchRange' ? 'voice-setup' : 'calibrate');
    return () => {};
  }

  const stage = el('div', { class: 'stage' });
  root.appendChild(el('div', { class: 'screen' }, topbar(definition.title), stage));

  const game = definition.create(profile ?? DEFAULT_PROFILE);
  let surface: Surface | null = null;
  let stopLoop: (() => void) | null = null;
  let disposed = false;
  let paused = false;
  /** The phase we last reacted to, so results are shown once per round. */
  let seenPhase = game.phase;

  const gate = overlay(definition.intro, 'Open microphone', () => void begin(), definition.introDetail);
  stage.appendChild(gate.root);

  const readyBanner = el(
    'div',
    { class: 'banner banner--ready' },
    el('strong', { text: definition.readyPrompt }),
    el('span', { text: game.readyHint }),
  );

  async function begin(): Promise<void> {
    gate.setBusy(true);
    try {
      const session = await ensureMicSession();
      if (disposed) return;
      gate.root.remove();
      surface = createSurface(stage);
      stage.appendChild(readyBanner);
      stopLoop = startLoop((dt) => {
        const frame = session.analyser.read();
        if (!paused) game.update(dt, frame);
        if (surface) game.render(surface);
        syncPhase();
      });
    } catch (error) {
      gate.showError(error instanceof Error ? error.message : 'Could not open the microphone.');
    }
  }

  function syncPhase(): void {
    if (game.phase === seenPhase) return;
    seenPhase = game.phase;
    readyBanner.style.display = game.phase === 'ready' ? '' : 'none';
    if (game.phase === 'over') showResults();
  }

  function showResults(): void {
    const score = game.score;
    const beaten = recordScore(definition.id, score);
    const best = bestScore(definition.id);

    const again = el('button', { class: 'btn-primary', text: 'Play again' });
    again.addEventListener('click', () => {
      panel.remove();
      game.reset();
      // reset() puts the game back to 'ready'; adopt that without re-showing
      // results for the round that just ended.
      seenPhase = game.phase;
      readyBanner.querySelector('span')!.textContent = game.readyHint;
      readyBanner.style.display = '';
    });
    const back = el('button', { text: 'Back to games' });
    back.addEventListener('click', () => navigate(''));

    const panel = el(
      'div',
      { class: 'overlay' },
      el('h1', { text: definition.formatScore(score) }),
      el('p', {
        text: beaten ? 'A new best.' : `Best so far: ${definition.formatScore(best)}.`,
      }),
      again,
      back,
    );
    stage.appendChild(panel);
  }

  // A backgrounded tab gets no microphone audio, so a round left running while
  // the player is elsewhere would quietly fail on their behalf.
  const onVisibility = (): void => {
    if (document.visibilityState !== 'hidden' || game.phase !== 'playing' || paused) return;
    paused = true;
    const resume = el('button', { class: 'btn-primary', text: 'Resume' });
    const panel = el('div', { class: 'overlay' }, el('h1', { text: 'Paused' }), resume);
    resume.addEventListener('click', () => {
      panel.remove();
      paused = false;
    });
    stage.appendChild(panel);
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', onVisibility);
    stopLoop?.();
    surface?.dispose();
    stopSession();
    root.replaceChildren();
  };
}

function meetsRequirement(
  definition: GameDefinition,
  profile: ReturnType<typeof loadProfile>,
): boolean {
  if (definition.requires === null) return true;
  if (profile === null) return false;
  if (definition.requires === 'pitchRange') return profile.pitchRange !== null;
  return true;
}
