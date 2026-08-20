/**
 * The shell every game is played inside.
 *
 * Owns the microphone gate, the canvas, the frame loop, pausing, restarts, the
 * results screen and high scores — so a game only implements rules and a
 * picture. See `engine/game.ts`.
 */
import { ensureMicSession, stopSession, type Session } from '../engine/session';
import { createSurface, startLoop, type Surface } from '../engine/canvas';
import { DEFAULT_PROFILE, loadProfile } from '../engine/calibration';
import { recordScore } from '../engine/scores';
import { el, navigate, overlay, topbar, type Cleanup } from '../ui';
import type { CalibrationProfile } from '../engine/types';
import type { GameDefinition } from '../engine/game';

export function playScreen(root: HTMLElement, definition: GameDefinition): Cleanup {
  const profile = loadProfile();
  if (!meetsRequirement(definition, profile)) {
    // Replace, so the route that bounced us doesn't sit in history waiting to
    // bounce us again on Back.
    navigate(profile && definition.requires === 'pitchRange' ? 'voice-setup' : 'calibrate', {
      replace: true,
    });
    return () => {};
  }

  const stage = el('div', { class: 'stage' });
  root.appendChild(el('div', { class: 'screen' }, topbar(definition.title), stage));

  const game = definition.create(profile ?? DEFAULT_PROFILE);
  let session: Session | null = null;
  let surface: Surface | null = null;
  let stopLoop: (() => void) | null = null;
  let resultsPanel: HTMLElement | null = null;
  let pausePanel: HTMLElement | null = null;
  let disposed = false;
  let paused = false;
  /** The phase we last reacted to, so results are shown once per round. */
  let seenPhase = game.phase;

  const gate = overlay(definition.intro, 'Open microphone', () => void begin(), gateDetail(definition));
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
      session = await ensureMicSession();
      if (disposed) return;
      // Build everything before dismissing the gate, so a failure here still
      // has somewhere to report itself.
      surface = createSurface(stage);
      stage.appendChild(readyBanner);
      gate.root.remove();
      startFrameLoop();
    } catch (error) {
      if (disposed) return;
      gate.showError(error instanceof Error ? error.message : 'Could not open the microphone.');
    }
  }

  function startFrameLoop(): void {
    const active = session;
    if (stopLoop || !active) return;
    stopLoop = startLoop((dt) => {
      const frame = active.analyser.read();
      if (!paused) game.update(dt, frame);
      if (surface) game.render(surface);
      syncPhase();
    });
  }

  function stopFrameLoop(): void {
    stopLoop?.();
    stopLoop = null;
  }

  function syncPhase(): void {
    if (game.phase === seenPhase) return;
    seenPhase = game.phase;
    readyBanner.style.display = game.phase === 'ready' ? '' : 'none';
    // Any transition out of 'over' means a new round: never leave a stale
    // results panel sitting on top of live play.
    if (game.phase !== 'over') dismissResults();
    if (game.phase === 'over') showResults();
  }

  function dismissResults(): void {
    resultsPanel?.remove();
    resultsPanel = null;
  }

  function dismissPause(): void {
    pausePanel?.remove();
    pausePanel = null;
    paused = false;
  }

  function showResults(): void {
    // Nothing left to react to, and analysing microphone audio frame after
    // frame behind a static panel is pure waste.
    stopFrameLoop();
    dismissPause();

    const { best, beaten } = recordScore(definition.id, game.score);

    const again = el('button', { class: 'btn-primary', text: 'Play again' });
    again.addEventListener('click', playAgain);
    const back = el('button', { text: 'Back to games' });
    back.addEventListener('click', () => navigate(''));

    resultsPanel = el(
      'div',
      { class: 'overlay' },
      el('h1', { text: definition.formatScore(game.score) }),
      el('p', { text: resultDetail(definition, best, beaten) }),
      again,
      back,
    );
    stage.appendChild(resultsPanel);
  }

  function playAgain(): void {
    dismissResults();
    dismissPause();
    game.reset();
    // Adopt whatever reset() produced rather than assuming 'ready', so a game
    // that starts a round immediately doesn't get a banner over live play.
    seenPhase = game.phase;
    const hint = readyBanner.querySelector('span');
    if (hint) hint.textContent = game.readyHint;
    readyBanner.style.display = game.phase === 'ready' ? '' : 'none';
    startFrameLoop();
  }

  // A backgrounded tab gets no microphone audio, so a round left running while
  // the player is elsewhere would quietly fail on their behalf.
  const onVisibility = (): void => {
    if (document.visibilityState !== 'hidden') return;
    if (paused || surface === null || game.phase === 'over') return;
    paused = true;
    const resume = el('button', { class: 'btn-primary', text: 'Resume' });
    resume.addEventListener('click', () => {
      dismissPause();
      // The context is often suspended by the time a tab comes back.
      void session?.source.context.resume();
    });
    pausePanel = el('div', { class: 'overlay' }, el('h1', { text: 'Paused' }), resume);
    stage.appendChild(pausePanel);
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', onVisibility);
    stopFrameLoop();
    surface?.dispose();
    stopSession();
    root.replaceChildren();
  };
}

function resultDetail(definition: GameDefinition, best: number, beaten: boolean): string {
  if (beaten) return 'A new best.';
  // A first round that scores nothing shouldn't be told its best is nothing.
  if (best <= 0) return 'Give it another go.';
  return `Best so far: ${definition.formatScore(best)}.`;
}

/** The rendering convention for `GameDefinition.headphonesRecommended`. */
const HEADPHONES_HINT = 'Headphones recommended.';

function gateDetail(definition: GameDefinition): string | undefined {
  if (!definition.headphonesRecommended) return definition.introDetail;
  return definition.introDetail
    ? `${definition.introDetail} ${HEADPHONES_HINT}`
    : HEADPHONES_HINT;
}

function meetsRequirement(
  definition: GameDefinition,
  profile: CalibrationProfile | null,
): boolean {
  if (definition.requires === null) return true;
  if (profile === null) return false;
  if (definition.requires === 'pitchRange') return profile.pitchRange !== null;
  return true;
}
