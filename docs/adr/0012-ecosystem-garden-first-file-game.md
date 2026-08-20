# Ecosystem Garden is the first `sources: ['mic', 'file']` game, and answers ADR-0009's open question

Phase 6 built and wired the source picker and file transport (ADR-0009,
ADR-0011) but every game shipped through Phase 6 declared `sources: ['mic']`,
so `screens/play.ts`'s file branch was dead code — exercised only by
`scope.ts`. B3 Ecosystem Garden (`docs/ideas.md`) is the first
`GameDefinition` to declare `sources: ['mic', 'file']`, which makes it the
first real user of that plumbing from inside a round, not just the scope.

## Verification: driven end-to-end against the real dev server, not just read

Rather than only reading the code path, this was exercised with headless
Chromium (Playwright, available globally in this sandbox at
`/opt/node22/lib/node_modules/playwright`) against `vite dev`: a synthetic
multi-segment WAV (bass tone → mid tone → high tone → sustained loud noise →
a quiet gap then a loud burst → silence) was decoded through the real
`createFileSource` → `analyseBeatGrid` → `useSource` chain via the actual
"Choose a file" button and hidden `<input type="file">`, with a calibration
profile pre-seeded into `localStorage` to skip the calibration screen (a
separate, already-shipped flow, not what this session needed to re-verify).

Confirmed live, not just by reading the code:

- The gate offers both "Use microphone" and "Choose a file" for this game
  specifically (every other game's gate still shows only the single
  microphone button — confirmed unaffected).
- Picking a file decodes, analyses a beat grid (unused by this game but run
  unconditionally by `source-picker.ts` for every file, per ADR-0011), and
  reaches `onSessionReady` with zero console/page errors.
- The transport bar renders, and its play/pause and scrub controls actually
  work against a live game round: pausing freezes `level`/`bands` at zero
  (silence) without stopping `game.update` itself — the round's clock keeps
  running (score keeps accumulating at its silence/full-health baseline
  rate, matching `game.ts`'s design, not a bug), it simply has no audio to
  react to, exactly like a quiet room. Resuming and scrubbing both picked the
  session back up correctly, with the very next `Frame.bands` reflecting the
  new playback position immediately.
- End-to-end, the whole management loop actually ran on real decoded audio:
  growth rose during the bass segment, a creature spawned during the mid
  segment, predators spawned and their `aggression` escalated during the
  sustained loud segment (health fell from 100 to ~15 across four
  unmanaged predators), and the scripted quiet-gap-then-burst produced a
  real rising edge across `scareThreshold` that flipped every active
  predator to `fleeing`, after which they despawned and `score` jumped from
  the repel bonus.

One real finding from this, worth recording for whoever builds the next
file-source game: `Frame.level` is broadband RMS loudness, independent of
which `bands` are active, so a synthetic pure-tone test segment at a
comfortable amplitude already reads as "loud" (`level` pinned at 1) under
`normaliseLevel`'s default calibration — there's no such thing as a
"quiet mid content" segment unless its amplitude is turned down
independently of its frequency. That's correct, intentional behaviour (a
loud passage in a real track raises `level` for the same reason), not a bug;
it just means a single-tone synthetic fixture is a poor stand-in for "quiet
music with some mid content" and a broadband or multi-tone mix is a better
one for the next person testing against synthetic audio.

## Decision: the transport bar stays visible and interactive during play

ADR-0009 explicitly left open "[w]hether the transport bar should stay
visible (and scrubbable) once a file-driven round is actually playing, or
hide itself during play." Ecosystem Garden makes no change to `play.ts` to
hide it — the existing default (visible, always) is correct for this game
specifically: an ambient, playlist-length session is exactly the case where
being able to pause the room or scrub to a different part of an album is a
feature, not a distraction, and the round handles a paused/silent input
gracefully by design (idles; nothing decays, nothing new spawns). This
doesn't resolve the question generally — a fast-reflex file-driven game later
might reasonably want to hide the bar — but it's now a decision made with a
real game behind it rather than an open question with none.

## Consequences

- No changes were needed to `screens/play.ts`, `source-picker.ts`,
  `transport-bar.ts`, or any other shell file — confirms ADR-0009's design
  holds for a real game exactly as advertised.
- `EcosystemGarden` (`src/games/ecosystem-garden/game.ts`) reads only
  `level` and `bands` from `Frame`, by design (see the roadmap's Phase 7
  section) — it does not read `Frame.beat`, so it says nothing about beat
  tracking quality on file vs mic; that remains Phase 8's open question.
- The synthetic-WAV harness (`make-wav.js` / `drive*.js`, used only for this
  verification and not part of the shipped codebase) is a reusable pattern —
  headless Chromium plus a generated multi-segment WAV plus a pre-seeded
  calibration profile in `localStorage` — for whoever next needs to exercise
  a file-driven game against real decoded audio without a physical device.
