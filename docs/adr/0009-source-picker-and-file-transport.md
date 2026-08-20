# The source picker is one shared gate; file playback gets its own state machine

Phase 6's first piece wires up `createFileSource` (ADR-0001) and `useSource`,
neither of which anything called before this. Two shell screens need the
same mic-or-file choice — `scope.ts` always, `play.ts` only for a
`GameDefinition` whose `sources` includes `'file'` — so it has to be one
reusable piece, not copied twice with two chances to drift.

## Decision: `sourceGate` replaces `overlay()` only where a choice exists

`src/screens/source-picker.ts` exports `sourceGate(message, onReady,
{ detail, allowFile })`. With `allowFile` false it renders exactly the old
single "Open microphone" button `overlay()` always rendered — no new choice
screen for a game that doesn't need one, per the task brief. With it true, a
second "Choose a file" button plus a hidden `<input type="file">` appear
alongside it; picking a file runs `createFileSource` + `useSource` and hands
back a `Session` through the same `onReady` callback the mic path uses, so
the caller (`scope.ts` or `play.ts`) never has to branch on *how* the session
was opened, only on `session.source.kind` afterward for the transport.

`overlay()` itself (`src/ui.ts`) is untouched, and `play.ts`'s mic-only path
still calls it verbatim — every existing game's gate is the same code it was
before this change, not a `sourceGate` call with `allowFile: false` standing
in for it, so there is zero behavioural surface for a regression to hide in.

## Decision: `FileSource` gets `pause()`/`seek()`, backed by a standalone `PlaybackTransport`

The brief's transport needs play/pause/seek, but `FileSource.stop()`
irreversibly closes its `AudioContext` — fine for leaving the screen, useless
for a pause button, since the same context is what the `Analyser` and the
session are built on. So `FileSource` gained real `pause()` and `seek()`
methods, and `play(offsetSeconds?)`'s no-argument case now resumes from
wherever `pause()` left it rather than always restarting at 0 (nothing called
`play()` before this change, so this is additive, not a break).

The position/paused bookkeeping behind those three methods is pulled out into
`src/engine/transport.ts`'s `PlaybackTransport` — a class that touches no
audio node at all, only a caller-supplied clock (`AudioContext.currentTime`
in practice) and plain numbers. `source.ts`'s only job is translating its
decisions (`play(now, offset)` returns where to start a buffer node; `seek`
returns the same, or nothing if paused) into actually starting or stopping
one. This is what makes the state machine unit-testable with Vitest the way
the rest of the engine is (`transport.test.ts`) without needing a Web Audio
polyfill the way exercising `createFileSource` itself would.

## Where the transport bar renders

`transportBar()` (`src/screens/transport-bar.ts`) is a thin view over
`FileSource` — play/pause button, a range input for scrubbing, elapsed/total
time — with no playback state of its own beyond "is the user's thumb
currently on the slider." It appears in both `scope.ts` and `play.ts`,
conditionally, the moment `isFileSource(session.source)` is true, in an empty
slot `div` that sits below the stage and takes no space when nothing has been
loaded. `scope.ts` also auto-starts the file at position 0 as soon as it
opens, since a scope with nothing playing has nothing to show.

## Consequences

- `Game`/`GameDefinition` (`engine/game.ts`) are unchanged — this is entirely
  shell wiring, same shape as ADR-0006's precedent for keeping input concerns
  out of the shared contract.
- No current game declares `'file'`, so `play.ts`'s new `supportsFile` branch
  is dead code until one does. It typechecks and the shared `sourceGate` path
  is exercised today by `scope.ts`, but the *branch* itself only gets a real
  test the day a file-capable game ships.
- Whether the transport bar should stay visible (and scrubbable) once a
  file-driven round is actually playing, or hide itself during play the way
  the mic gate disappears, is left to whoever builds that first game — there
  is no game yet to make that call concretely.
