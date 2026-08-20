/**
 * Play/pause and scrub for a loaded `FileSource`. Purely a thin view over
 * `FileSource`'s own `play`/`pause`/`seek`/`position` (see `engine/source.ts`
 * and the state machine behind it in `engine/transport.ts`) — this file holds
 * no playback state of its own beyond "is the user currently dragging the
 * scrubber," so it never needs unit tests the way `PlaybackTransport` does.
 */
import { el } from '../ui';
import type { FileSource } from '../engine/source';

export interface TransportBar {
  root: HTMLElement;
  dispose(): void;
}

const POLL_MS = 200;

export function transportBar(source: FileSource): TransportBar {
  const duration = Math.max(0.01, source.buffer.duration);

  const playPause = el('button', { class: 'btn-ghost transport-play', 'aria-label': 'Play' }, '▶');
  const seek = el('input', {
    class: 'transport-seek',
    type: 'range',
    min: '0',
    max: String(duration),
    step: '0.01',
  }) as HTMLInputElement;
  const time = el('span', { class: 'transport-time hint' }, formatRange(0, duration));

  // While the player is actively dragging, don't let the poll below fight
  // their thumb by snapping the slider back to the live playback position.
  let scrubbing = false;

  playPause.addEventListener('click', () => {
    if (source.playing()) source.pause();
    else source.play();
    sync();
  });

  seek.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  seek.addEventListener('input', () => {
    time.textContent = formatRange(Number(seek.value), duration);
  });
  seek.addEventListener('change', () => {
    source.seek(Number(seek.value));
    scrubbing = false;
    sync();
  });

  function sync(): void {
    const playing = source.playing();
    playPause.textContent = playing ? '⏸' : '▶';
    playPause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (scrubbing) return;
    const position = source.position();
    seek.value = String(position);
    time.textContent = formatRange(position, duration);
  }

  sync();
  // FileSource has no "position changed" event, so a slow poll keeps the
  // scrubber honest during playback without a full render loop for a bar
  // that only needs to be roughly right, not per-frame.
  const interval = window.setInterval(sync, POLL_MS);

  const root = el('div', { class: 'transport' }, playPause, seek, time);
  return {
    root,
    dispose() {
      window.clearInterval(interval);
    },
  };
}

function formatRange(position: number, duration: number): string {
  return `${formatTime(position)} / ${formatTime(duration)}`;
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
