/**
 * The mic/file choice behind the gesture-gated overlay every audio screen
 * opens with. One shared module because `scope.ts` and `play.ts` both need
 * the same choice — see ADR-0001 and ADR-0009.
 *
 * When a game (or the scope) has no use for a file, `allowFile` is left
 * false and this renders exactly the old single "Open microphone" button —
 * no needless choice screen for the common case.
 *
 * `allowMic` defaults true and exists for the opposite edge: Drop Siege
 * (`docs/ideas.md` B2) is the first `GameDefinition` whose `sources` is
 * `['file']` alone, no mic option at all — "knowing a boss arrives at the
 * drop requires seeing the whole track in advance, which live mic
 * fundamentally cannot do." Before this only `allowFile` existed, and it only
 * ever *added* the file button alongside the mic one, so a file-only game had
 * no way to get a gate without a microphone button that would have opened a
 * session type the game can't use. See `play.ts`'s call site.
 */
import { ensureMicSession, useSource, type Session } from '../engine/session';
import { analyseBeatGrid } from '../engine/beat-offline';
import { createFileSource } from '../engine/source';
import { el } from '../ui';

export interface SourceGateOptions {
  detail?: string;
  /** Offer "choose a file" alongside the microphone. Default false. */
  allowFile?: boolean;
  /** Offer the microphone at all. Default true — set false for a game whose
   *  `sources` is `['file']` alone. Requires `allowFile: true`; a gate with
   *  neither would have no way to ever start a session. */
  allowMic?: boolean;
}

export interface SourceGate {
  root: HTMLElement;
  /** Stop reacting to in-flight requests — call from the screen's own cleanup. */
  dispose(): void;
}

export function sourceGate(
  message: string,
  onReady: (session: Session) => void,
  options: SourceGateOptions = {},
): SourceGate {
  let disposed = false;
  const allowMic = options.allowMic ?? true;

  const text = el('p', { text: message });
  const micButton = allowMic
    ? el('button', {
        class: 'btn-primary',
        text: options.allowFile ? 'Use microphone' : 'Open microphone',
      })
    : null;
  // Primary styling follows whichever button is the sole way to start a
  // session: the mic when present (unchanged from before `allowMic`
  // existed), the file button when it's the only one offered at all.
  const fileButton = options.allowFile
    ? el('button', { class: allowMic ? '' : 'btn-primary', text: 'Choose a file' })
    : null;
  const fileInput = el('input', {
    type: 'file',
    accept: 'audio/*',
    class: 'file-input',
  }) as HTMLInputElement;

  function setBusy(busy: boolean): void {
    if (micButton) micButton.disabled = busy;
    if (fileButton) fileButton.disabled = busy;
  }

  function showError(errorText: string): void {
    text.textContent = errorText;
    text.className = 'error';
    setBusy(false);
  }

  micButton?.addEventListener('click', () => {
    setBusy(true);
    ensureMicSession()
      .then((session) => {
        if (!disposed) onReady(session);
      })
      .catch((error) => {
        if (!disposed) {
          showError(error instanceof Error ? error.message : 'Could not open the microphone.');
        }
      });
  });

  if (fileButton) {
    fileButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0] ?? null;
      // Clear it immediately so picking the same file again still fires 'change'.
      fileInput.value = '';
      if (!file) return;
      setBusy(true);
      void loadFile(file);
    });
  }

  /**
   * Decode, then beat-analyse, then hand back a session — one awaited chain
   * so the gate stays visibly busy through both, not just the decode. Beat-
   * grid analysis is a real, synchronous cost (~780ms for a three-minute
   * track per ADR-0010's measurement) that has nowhere else to live: it isn't
   * file decoding (`source.ts`'s job) and doing it lazily inside `session.ts`
   * would make every session opener pay for it even when nothing reads
   * `Frame.beat`. See ADR-0011.
   */
  async function loadFile(file: File): Promise<void> {
    try {
      const source = await createFileSource(file);
      if (disposed) return;
      // Yield one tick so the disabled-button "busy" state actually paints
      // before the synchronous analysis below blocks the main thread.
      await yieldToPaint();
      if (disposed) return;
      // A file with no findable beat (silence, noise, too short) is
      // `analyseBeatGrid` returning null, not an error — Frame.beat just
      // stays NO_BEAT for this session, same as a game that wires up no beat
      // tracker at all.
      const beatGrid = analyseBeatGrid(source.buffer);
      if (disposed) return;
      onReady(useSource(source, beatGrid));
    } catch {
      if (!disposed) showError('Could not read that file — try a different one.');
    }
  }

  // Exactly one lone button (the common case, either mic-only or, now,
  // file-only) skips the 'gate-actions' box only one of them ever needed;
  // both present is the only case that's actually a choice.
  const actions =
    micButton && fileButton
      ? el('div', { class: 'gate-actions' }, micButton, fileButton, fileInput)
      : (micButton ?? el('div', {}, fileButton, fileInput));

  const root = el(
    'div',
    { class: 'overlay' },
    text,
    actions,
    options.detail ? el('p', { class: 'hint', text: options.detail }) : null,
  );

  return {
    root,
    dispose() {
      disposed = true;
    },
  };
}

/** One macrotask's worth of a yield — enough for the browser to paint the
 *  "busy" state set just before it's called, before a synchronous block. */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
