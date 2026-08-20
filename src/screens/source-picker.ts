/**
 * The mic/file choice behind the gesture-gated overlay every audio screen
 * opens with. One shared module because `scope.ts` and `play.ts` both need
 * the same choice — see ADR-0001 and ADR-0009.
 *
 * When a game (or the scope) has no use for a file, `allowFile` is left
 * false and this renders exactly the old single "Open microphone" button —
 * no needless choice screen for the common case.
 */
import { ensureMicSession, useSource, type Session } from '../engine/session';
import { analyseBeatGrid } from '../engine/beat-offline';
import { createFileSource } from '../engine/source';
import { el } from '../ui';

export interface SourceGateOptions {
  detail?: string;
  /** Offer "choose a file" alongside the microphone. Default false. */
  allowFile?: boolean;
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

  const text = el('p', { text: message });
  const micButton = el('button', {
    class: 'btn-primary',
    text: options.allowFile ? 'Use microphone' : 'Open microphone',
  });
  const fileButton = options.allowFile ? el('button', { text: 'Choose a file' }) : null;
  const fileInput = el('input', {
    type: 'file',
    accept: 'audio/*',
    class: 'file-input',
  }) as HTMLInputElement;

  function setBusy(busy: boolean): void {
    micButton.disabled = busy;
    if (fileButton) fileButton.disabled = busy;
  }

  function showError(errorText: string): void {
    text.textContent = errorText;
    text.className = 'error';
    setBusy(false);
  }

  micButton.addEventListener('click', () => {
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

  const actions = fileButton
    ? el('div', { class: 'gate-actions' }, micButton, fileButton, fileInput)
    : micButton;

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
