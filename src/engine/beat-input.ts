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
 *
 * **Latency compensation lives here too, per adapter, for the same reason.**
 * `Analyser` passes the player's measured device latency (see
 * `engine/latency.ts`) on every call; each adapter subtracts it from its own
 * idea of "now" before asking its tracker/reader what the beat is doing. That
 * shifts every consumer of `Frame.beat` (`beatPhase`, `onBeat`, `beatIndex`)
 * to report what the beat was doing `latencySeconds` ago — exactly what a
 * device with that much output-to-input delay is *currently* making audible —
 * so a tap that lands when the player actually hears a beat reads as on time,
 * not late. See ADR-0015 for why this is the one central point rather than
 * each beat-driven game reading the profile and adjusting its own hit window.
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
   * @param latencySeconds this device's measured output-to-input latency, 0
   * when unmeasured. Subtracted from whichever clock this adapter actually
   * reads — see the module doc comment.
   */
  advance(t: number, onset: boolean, onsetStrength: number, latencySeconds?: number): BeatReading;
  /** Forget any per-frame edge state. Call after a seek or a round restart. */
  reset(): void;
}

/** The mic path: feeds the causal tracker real onset events every frame. */
export class CausalBeatInput implements BeatInput {
  constructor(private readonly tracker: CausalBeatTracker) {}

  advance(t: number, onset: boolean, onsetStrength: number, latencySeconds = 0): BeatReading {
    return this.tracker.process(t - latencySeconds, onset, onsetStrength);
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

  advance(_t: number, _onset: boolean, _onsetStrength: number, latencySeconds = 0): BeatReading {
    return this.reader.read(this.positionSeconds() - latencySeconds);
  }

  reset(): void {
    this.reader.reset();
  }
}
