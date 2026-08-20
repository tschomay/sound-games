# Sonar Maze steers by tap, not by voice

Sonar Maze's whole hook — from `ideas.md` — is the clap: a wavefront that
lights up the maze, louder clap reaches further, and every clap is noise the
hunter can follow. That is one verb, and it is already a full one. The maze
also needs a second, independent verb — which lane you're in — decided *before*
a fork, not as a reaction to seeing one, since seeing one already used the
clap.

Category A's framing is "voice as controller," and the natural instinct is to
find a second vocal axis for lane choice the way Vowel Steering (A5) pairs
pitch with vowel shape. Two reasons that doesn't fit here:

1. `onset`/`level` are the only detectors this game is scoped to use (see
   `ideas.md` and the Phase 4 roadmap entry) — no pitch, no timbre. There is no
   second voice axis on the table without adding a new detector, which the
   phase brief explicitly rules out for this game.
2. Even with one available, overloading it onto the clap itself is worse than
   it sounds: a clap that also has to encode direction (e.g. by pitch or
   loudness) muddies the one signal the wavefront depends on for its radius,
   right at the moment precision matters most.

So lane changes are a tap: top half of the screen steers up a lane, bottom
half steers down. `SonarMaze.steer(direction)` is a plain method on the rules
class, independent of `update(dt, input)` — it takes a bare `-1 | 1`, so it
carries no more DOM/touch knowledge into the pure rules than a keyboard or a
gamepad would. `index.ts` attaches a `pointerdown` listener directly to the
canvas the shell hands `render()`; the `Game` interface itself (`engine/game.ts`)
gets no new members; the shell (`screens/play.ts`) stays exactly as sound-only
as before.

## Decision

Sonar Maze reads two independent inputs: `onset`/`level` from the Frame for the
clap (illumination + hunter alertness), and screen taps, wired up inside the
game's own `index.ts`, for lane steering. This is a deliberate, scoped
deviation from hands-free voice control for one game, not a change to the
project's general lean — see A4's entry in `ideas.md` for the reasoning the
phase brief gave for allowing it.

## Consequences

- `Game`/`GameDefinition` (`engine/game.ts`) are unchanged. Any future game
  that wants a second, non-audio input channel can follow the same pattern —
  attach to `surface.canvas` from inside its own `render()` — without the
  shell needing to know input exists.
- Sonar Maze is not purely hands-free. That's a real trade against the
  project's general framing, made once, for the one game whose pitch is
  explicitly "clap-revealed visibility," not "voice replaces every input."
- If a later phase adds a detector that could plausibly carry lane choice
  (say, a left/right lean read from stereo mic channels, if that ever
  existed), swapping the tap for it only touches this file — `steer()`'s
  signature doesn't care where the `-1 | 1` came from.
