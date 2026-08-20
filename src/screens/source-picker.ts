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
      createFileSource(file)
        .then((source) => {
          if (disposed) return;
          onReady(useSource(source));
        })
        .catch(() => {
          if (!disposed) showError('Could not read that file — try a different one.');
        });
    });
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
