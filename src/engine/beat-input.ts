/**
 * The one call shape `Analyser.read()` always uses for beat tracking, however
 * differently the two trackers themselves want to be called. See ADR-0011.
 *
 * `CausalBeatTracker` needs real onset events fed to it every frame to track
 * anything at all — its own `read(now)` is documented as `process(now,
 * false)`, which starves it of exactly the input it needs. `BeatGridReader`
 * wants the file's playback position, not the analyser's own clock, since the
 * two diverge on pause and seek. `Analyser` doesn't want to know either of
 * those things; it just wants to call one method the same way every frame,
 * whether it's holding one of these, the other, or nothing. These two classes
 * are what let it — each closes over which concrete tracker (if any) it is
 * wrapping and its own idea of "now", and exposes the same `advance`.
 */
import type { BeatReader, BeatReading } from './beat';
import type { CausalBeatTracker } from './beat-causal';

export interface BeatInput {
  /**
   * @param t the analyser's own clock — seconds since it started (`Frame.t`).
   * Only `CausalBeatInput` uses this; `FileBeatInput` has its own clock (the
   * file's playback position) and ignores it.
   * @param onset this frame's onset flag, already gated (forced false during
   * output-bus suppression, same as `Frame.onset`) — real onset input is what
   * the causal tracker needs to track anything.
   * @param onsetStrength paired with `onset`, same as `Frame.onsetStrength`.
   */
  advance(t: number, onset: boolean, onsetStrength: number): BeatReading;
  /** Forget any per-frame edge state. Call after a seek or a round restart. */
  reset(): void;
}

/** The mic path: feeds the causal tracker real onset events every frame. */
export class CausalBeatInput implements BeatInput {
  constructor(private readonly tracker: CausalBeatTracker) {}

  advance(t: number, onset: boolean, onsetStrength: number): BeatReading {
    return this.tracker.process(t, onset, onsetStrength);
  }

  reset(): void {
    this.tracker.reset();
  }
}

/**
 * The file path: reads a precomputed grid at the file's own playback
 * position rather than the analyser's clock (see the module doc comment),
 * and ignores onset input entirely — the grid was already fit to the whole
 * track before playback started, so per-frame onset events have nothing left
 * to tell it. Takes a `BeatReader`, not the concrete `BeatGridReader`, since
 * nothing here needs anything beyond that interface.
 */
export class FileBeatInput implements BeatInput {
  constructor(
    private readonly reader: BeatReader,
    private readonly positionSeconds: () => number,
  ) {}

  advance(_t: number, _onset: boolean, _onsetStrength: number): BeatReading {
    return this.reader.read(this.positionSeconds());
  }

  reset(): void {
    this.reader.reset();
  }
}
