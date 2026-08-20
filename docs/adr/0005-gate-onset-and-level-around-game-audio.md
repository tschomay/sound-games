# Gate onset and level around game audio with a short suppression window

No game made a sound before Phase 2. The moment one does, its own onset
detector will hear its speaker output and fire — hazard 2 in `ideas.md`, and
the reason Phase 2 has to land before any game with sound.

Three ways to avoid it: duck the game's own audio, gate detection while it
plays, or require headphones. Ducking the *game's* audio doesn't help — the
hazard is the microphone hearing the room, not the game hearing itself.
Requiring headphones everywhere is the safe answer but a bad default: most of
the games this unlocks (Phase 3+) are meant to be picked up and played on a
phone speaker with no setup. So: gate.

## Decision

`OutputBus` (`src/engine/output.ts`) owns two `GainNode` channels — music and
SFX — on the session's shared `AudioContext`, and tracks a single
`suppressedUntil` timestamp against `context.currentTime`. Every `playSfx`
call pushes that timestamp forward by a configurable window (default 220ms,
chosen to cover a percussive SFX and its room reverberation through a phone
speaker — unverified on real hardware, and the first thing to tune from the
scope if games built on this feel wrong).

`Analyser.read()` (`src/engine/analyser.ts`) takes an optional
`SuppressionSource` — just `{ isSuppressed(): boolean }` — and, when it
reports true for a frame: forces `onset` false and `onsetStrength` 0, and
freezes `level` at its last un-gated value instead of reporting whatever the
game's own speaker output produced. The frame carries the result as `gated`,
for the scope and for any game logic that wants to know. `onset.ts` and
`pitch.ts` know nothing about this — the analyser is the only thing that asks,
per the phase brief's steer to keep detectors free of output concerns.

`session.ts` builds one `OutputBus` per session, on the same `AudioContext` as
the mic source, and wires it into the `Analyser` it constructs — so a game
gets gating for free just by being inside the shared session, with no
per-game wiring.

**Music is not gated for its duration.** A continuous loop isn't a single
event to suppress around; gating it for as long as it plays would just zero
out `level`/`onset` for the whole game. Only the short attack/decay of
`startMusic`/`stopMusic` gets the same short window `playSfx` does, on the
theory that starting or stopping a source is itself a small transient. A game
that wants sustained `level`/`onset` detection *while* music plays is asking
for something gating cannot give it — that's what `headphonesRecommended`
(`src/engine/game.ts`) is for: a structured flag on `GameDefinition`, rendered
by `screens/play.ts` as a standard line on the microphone gate, so every game
that needs the hint doesn't invent its own copy of the sentence. Hum Flyer's
ad hoc `introDetail` string carrying "Headphones recommended." was the thing
that prompted pulling it out.

## Consequences

- A game plays SFX via `session.output` (or wherever Phase 3+ decides to
  expose it — no game consumes this yet, so that call site doesn't exist
  yet) and gets suppression automatically; it does not need to know the
  window exists.
- The suppression window is a guess sized from reasoning about SFX + room
  reverb, not from measurement. The roadmap already flags this phase medium
  risk for exactly this reason — if it proves unreliable on real speakers, the
  documented fallback is requiring headphones for onset-driven games, and that
  should be a deliberate call once real games exercise it, not a silent
  discovery.
- Freezing `level` rather than zeroing it during a gated frame is deliberate:
  a hard drop to 0 is itself a discontinuity a game could misread as "the room
  went silent," and the point of gating is to look like nothing happened.
- The onset detector is still fed every frame during suppression so its
  rolling flux history doesn't go stale and cause a spurious threshold
  reaction the instant the gate closes — only the reported result is
  overridden, not the detector's internal state.
