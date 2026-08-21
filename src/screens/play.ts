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
import { shareScore } from '../engine/share';
import { isFileSource } from '../engine/source';
import { el, navigate, overlay, topbar, type Cleanup } from '../ui';
import { sourceGate } from './source-picker';
import { transportBar, type TransportBar } from './transport-bar';
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
  const transportSlot = el('div', {});
  root.appendChild(
    el('div', { class: 'screen' }, topbar(definition.title), stage, transportSlot),
  );

  const game = definition.create(profile ?? DEFAULT_PROFILE);
  let session: Session | null = null;
  let surface: Surface | null = null;
  let transport: TransportBar | null = null;
  let stopLoop: (() => void) | null = null;
  let resultsPanel: HTMLElement | null = null;
  let pausePanel: HTMLElement | null = null;
  let disposed = false;
  let paused = false;
  /** The phase we last reacted to, so results are shown once per round. */
  let seenPhase = game.phase;

  // Only games that actually declare file support get the mic-or-file choice
  // — every other game keeps the exact one-button gate it has always had.
  const supportsFile = definition.sources.includes('file');
  // Drop Siege (`sources: ['file']`) is the first game with no mic option at
  // all — see `source-picker.ts`'s doc comment for why `allowMic` exists.
  const supportsMic = definition.sources.includes('mic');
  let disposeGate: (() => void) | null = null;
  let gateRoot: HTMLElement;

  if (supportsFile) {
    const gate = sourceGate(definition.intro, (opened) => onSessionReady(opened), {
      detail: gateDetail(definition),
      allowFile: true,
      allowMic: supportsMic,
    });
    gateRoot = gate.root;
    disposeGate = gate.dispose;
  } else {
    const gate = overlay(definition.intro, 'Open microphone', () => void begin(), gateDetail(definition));
    gateRoot = gate.root;

    async function begin(): Promise<void> {
      gate.setBusy(true);
      try {
        const opened = await ensureMicSession();
        onSessionReady(opened);
      } catch (error) {
        if (disposed) return;
        gate.showError(error instanceof Error ? error.message : 'Could not open the microphone.');
      }
    }
  }
  stage.appendChild(gateRoot);

  const readyBanner = el(
    'div',
    { class: 'banner banner--ready' },
    el('strong', { text: definition.readyPrompt }),
    el('span', { text: game.readyHint }),
  );

  function onSessionReady(opened: Session): void {
    if (disposed) return;
    session = opened;
    // Build everything before dismissing the gate, so a failure here still
    // has somewhere to report itself.
    surface = createSurface(stage);
    if (isFileSource(opened.source)) {
      opened.source.play();
      transport = transportBar(opened.source);
      transportSlot.appendChild(transport.root);
    }
    stage.appendChild(readyBanner);
    gateRoot.remove();
    startFrameLoop();
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
    const share = el('button', { text: 'Share' });
    share.addEventListener('click', () => void shareResult(share));
    const back = el('button', { text: 'Back to games' });
    back.addEventListener('click', () => navigate(''));

    resultsPanel = el(
      'div',
      { class: 'overlay' },
      el('h1', { text: definition.formatScore(game.score) }),
      el('p', { text: resultDetail(definition, best, beaten) }),
      again,
      share,
      back,
    );
    stage.appendChild(resultsPanel);
  }

  /**
   * A client-only share of this locally-recorded score. `shareScore`
   * (`engine/share.ts`) owns the actual decision logic (Web Share API first,
   * clipboard fallback, what counts as a real failure); this just turns its
   * answer into a real, user-visible confirmation — never a silent no-op,
   * per the roadmap's own requirement, except for a player closing the native
   * share sheet on their own, which isn't a failure and has nothing to confirm.
   */
  async function shareResult(button: HTMLButtonElement): Promise<void> {
    const outcome = await shareScore(navigator, definition.title, definition.formatScore(game.score));
    if (outcome === 'shared') flashButton(button, 'Shared!');
    else if (outcome === 'copied') flashButton(button, 'Copied to clipboard!');
    else if (outcome === 'failed') flashButton(button, 'Could not share — try again');
  }

  /** Swap a button's label to a confirmation for a couple of seconds, then
   *  put it back — the closest thing a plain button has to a toast. */
  function flashButton(button: HTMLButtonElement, message: string): void {
    const original = button.textContent;
    button.textContent = message;
    button.disabled = true;
    setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = original;
      button.disabled = false;
    }, 2000);
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
    disposeGate?.();
    document.removeEventListener('visibilitychange', onVisibility);
    stopFrameLoop();
    transport?.dispose();
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
