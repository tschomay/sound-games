/**
 * Play/pause/seek bookkeeping for `FileSource` (`source.ts`), factored out of
 * the Web Audio calls so it is plain arithmetic a test can drive with numbers
 * instead of a real `AudioContext` — see AGENTS.md's "pure rules, testable"
 * convention, and ADR-0009 for why this exists as its own module.
 *
 * This class does not touch any audio node. It only tracks "what position is
 * the track at, and is it meant to be playing" against a caller-supplied
 * clock (`AudioContext.currentTime` in practice); `source.ts` is the only
 * thing that translates its decisions into starting or stopping a buffer
 * source node.
 */
export class PlaybackTransport {
  private startedAt = 0;
  private startOffset = 0;
  /** Frozen position while paused; null while playing. */
  private pausedAt: number | null = 0;

  constructor(private readonly duration: number) {}

  get playing(): boolean {
    return this.pausedAt === null;
  }

  /** Seconds into the track right now. */
  position(now: number): number {
    if (this.pausedAt !== null) return this.pausedAt;
    return clamp(this.startOffset + (now - this.startedAt), 0, this.duration);
  }

  /**
   * Start playing. With no offset, resumes from wherever it was paused (or 0
   * if it was never started) — the behaviour a bare "play" button wants.
   * Returns the offset actually started from, so the caller knows where to
   * start the underlying buffer node.
   */
  play(now: number, offsetSeconds?: number): number {
    const at = clamp(offsetSeconds ?? this.pausedAt ?? 0, 0, this.duration);
    this.startedAt = now;
    this.startOffset = at;
    this.pausedAt = null;
    return at;
  }

  /** Freeze at the current position. A no-op if already paused. */
  pause(now: number): void {
    if (this.pausedAt !== null) return;
    this.pausedAt = this.position(now);
  }

  /**
   * Jump to `offsetSeconds`. Keeps whatever playing/paused state it was in —
   * scrubbing while paused should not start audio, and scrubbing while
   * playing should not stop it. Returns the clamped offset, so the caller
   * knows whether (and where) to restart the buffer node.
   */
  seek(now: number, offsetSeconds: number): number {
    const at = clamp(offsetSeconds, 0, this.duration);
    if (this.pausedAt !== null) this.pausedAt = at;
    else {
      this.startedAt = now;
      this.startOffset = at;
    }
    return at;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
