# Wiring the two beat trackers into `Frame`, and where offline analysis runs

ADR-0010 built both trackers and left two things open, deliberately: "Wiring a
`BeatReading` onto `Frame` and drawing it in the scope is a separate piece of
work." This ADR is that piece.

## Decision: a per-tracker adapter, not a watered-down `BeatReader`

`Analyser.read()` needs one call it always makes the same way, once a frame,
regardless of which tracker (if any) it's holding. `BeatReader.read(now)` —
the interface both trackers already implement — looked like the obvious
candidate, but it isn't: `CausalBeatTracker`'s own `read(now)` is documented
as `process(now, false)`, i.e. calling it alone starves the tracker of the
onset events it needs to track anything at all. Widening `BeatReader` itself
to take onset input would have forced `BeatGridReader` to grow parameters it
has no use for, for the sake of a caller (`Analyser`) that isn't `BeatReader`'s
only consumer — the tests in `beat-causal.test.ts` and `beat-offline.test.ts`
still want the plain interface.

So `engine/beat-input.ts` adds a second, narrower interface that exists only
for this call site:

```ts
interface BeatInput {
  advance(t: number, onset: boolean, onsetStrength: number): BeatReading;
  reset(): void;
}
```

and two adapters that implement it: `CausalBeatInput` wraps a
`CausalBeatTracker` and forwards straight to `process(t, onset,
onsetStrength)`; `FileBeatInput` wraps any `BeatReader` (in practice a
`BeatGridReader`) and calls `reader.read(...)`, ignoring `onset` and
`onsetStrength` entirely — the grid was already fit to the whole track before
playback started, so per-frame onset events have nothing left to tell it.
`Analyser` takes an optional `BeatInput` the same way it already takes an
optional `SuppressionSource` (ADR-0005): absent by default, so `Frame.beat` is
`NO_BEAT` for every game that doesn't wire one in, which today is all of them.

## Decision: `FileBeatInput` owns its own clock, and ignores the one `Analyser` hands it

The other mismatch ADR-0010 flagged: `CausalBeatTracker` wants the analyser's
own running clock (`Frame.t`), but `BeatGridReader` wants the file's actual
playback position (`FileSource.position()`), and the two diverge the moment a
file is paused or scrubbed — `Frame.t` keeps advancing with wall-clock time
regardless. Rather than have `Analyser` branch on which kind of clock to pass
into a single `now` parameter (which would mean `Analyser` needing to know
which concrete tracker it's holding — exactly the thing this design is trying
to avoid), `FileBeatInput` takes its own `positionSeconds: () => number`
closure at construction and never looks at the `t` `Analyser` hands it.
`session.ts` supplies `() => (source as FileSource).position()` when it builds
one, so the clock choice is made once, where the concrete source is known,
and `Analyser.read()` stays oblivious to it — it always calls
`beatInput.advance(t, onset, onsetStrength)` and lets the adapter decide what
of that it actually wants.

## Decision: the beat-grid analysis runs in `source-picker.ts`, in the same awaited chain as the decode

`analyseBeatGrid` takes a decoded `AudioBuffer` and is a real synchronous cost
— ADR-0010 measured ~780ms for a three-minute track. It needed a home that
isn't `source.ts` (decoding only) and isn't `session.ts` (which would make
every session opener pay for it, including ones that never read
`Frame.beat`). `screens/source-picker.ts` already awaits `createFileSource`
behind a `setBusy(true)` while it decodes, so the file-picking flow is:
decode, yield one tick (`setTimeout(resolve, 0)`, so the disabled button
actually paints before the block below), analyse, then call `useSource(source,
beatGrid)`. The gate stays visibly busy through both costs, not just the
first. `useSource`/`openSession` (`session.ts`) now take an optional
`BeatGrid | null` alongside the source and build a `FileBeatInput` from it
when present; `analyseBeatGrid` returning `null` (silence, noise, a track too
short to argue about) is handled the same way as never having called it at
all — `Frame.beat` stays `NO_BEAT`, not an error.

## Consequences

- `engine/beat.ts`, `beat-causal.ts`, `beat-offline.ts` are unchanged — this
  ADR only adds a caller-facing adapter layer on top, matching the "new
  concern in its own module" precedent ADR-0005 through ADR-0010 all followed.
- The mic path (`ensureMicSession`) always builds a fresh `CausalBeatTracker`
  per session; it is not reset or rebuilt mid-session, so its tempo lock
  persists across whatever a game does with the same open microphone session,
  same as every other detector's per-session state.
- Nothing currently calls `BeatInput.reset()` outside its own tests. Both
  concrete `BeatReader`s already handle a seek or restart internally
  (`BeatGridReader` detects a position jump on its own; the causal tracker
  forgets a stale tempo after `staleAfterSeconds`), so there was nothing that
  needed it wired up yet. It's there for whichever game ends up wanting an
  explicit "forget everything, we just restarted" moment.
- This still doesn't answer the roadmap's Phase 6 "done when" — that requires
  a human at the scope with a real microphone and real music. See the
  roadmap's "what actually shipped" for Phase 6.
