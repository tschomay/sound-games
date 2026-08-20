# Roadmap

How the nine concepts in [`ideas.md`](./ideas.md) become one finished app.

The sequencing is driven by a single observation: **games are cheap, capabilities
are expensive.** Hum Flyer took an afternoon; the pitch detector and calibration
flow underneath it took the rest. So the phases below are ordered by *capability*
— each one lands a piece of shared machinery and then collects the games that
machinery unlocks, rather than building games one at a time and rewriting the
engine underneath each.

Phases are ordered by dependency, not by calendar. Each has a **done when** that
can be checked rather than argued about.

---

## Phase 0 — Shipped

The audio engine (`level`, `pitch`, `onset`, `bands`, `timbre`), the two-part
calibration flow, the signal scope, and Hum Flyer. Deployed, tested, and live.

---

## Phase 1 — The game shell — **shipped**

**Why first:** every remaining game needs the same furniture, and building it
once is the difference between eight games and eight variations on a prototype.
Right now Hum Flyer owns its own round lifecycle, its own restart handling and
its own game-over banner, none of which is reusable.

**Ships**

- A `Game` interface — `update(dt, frame)`, `render(surface)`, declared
  requirements, declared supported audio sources — and a registry the menu builds
  itself from, replacing today's hand-maintained `ENTRIES` list.
- Round lifecycle as one shared thing: ready → playing → over, with pause on tab
  blur (a backgrounded tab gets no microphone audio, so today's games silently
  freeze mid-round).
- A results screen and locally persisted high scores.
- Hum Flyer refactored onto it, as proof the interface fits a real game.

**Done when** Hum Flyer has lost its bespoke lifecycle code and a new game can be
added by writing one file and registering it. ✅

**What actually shipped:** `engine/game.ts` (the `Game` / `GameDefinition`
contract), `engine/scores.ts` (best score per game), `screens/play.ts` (the
shell), and `games/registry.ts`, which both the menu and the router are now built
from. Hum Flyer lost its microphone gate, canvas handling, render loop, restart
wiring and on-canvas banners, and is now a definition plus rules plus a `render`.
Round phases are one shared vocabulary — `ready` / `playing` / `over` — rather
than each game inventing its own.

Pausing turned out to matter more than expected: a backgrounded tab receives no
microphone audio, so before this a round left running while the player was
elsewhere would quietly fail on their behalf.

---

## Phase 2 — Sound output, and ducking — **shipped**

**Why here:** no game currently makes a sound, which is why we have not yet been
bitten by hazard 2 in `ideas.md` — *game audio re-enters the microphone*. The
moment a game plays a hit sound through a phone speaker, its own onset detector
hears it and fires. Every game from Phase 3 onward wants audio, so this has to
land first.

**Ships**

- A small output bus with music and SFX channels.
- Detector gating: a short suppression window around anything the game plays, so
  our own effects cannot be mistaken for the player.
- A headphone hint on games where it matters, and a "detector is hearing the
  game" warning surfaced in the scope.

**Done when** a game can play a percussive SFX through a speaker without its own
onset detector counting it. ✅

**What actually shipped:** `engine/output.ts` (the `OutputBus` — music and SFX
`GainNode` channels on the session's shared `AudioContext`, with a
`suppressedUntil` window that `playSfx` opens and `startMusic`/`stopMusic`
briefly touch), and `Analyser.read()` in `engine/analyser.ts` now takes an
optional `SuppressionSource` it consults once per frame to force `onset` off
and freeze `level`, reporting the result as a new `Frame.gated`. `session.ts`
builds one `OutputBus` per session and wires it into the `Analyser` it
constructs, so gating comes for free from being inside the shared session — no
game has had to opt in yet, because no game plays sound yet. `onset.ts` and
`pitch.ts` were untouched, as intended: the analyser is the only thing that
asks. `screens/scope.ts` gained a `Gated` readout cell and a red flash distinct
from the green onset flash. `GameDefinition.headphonesRecommended` replaces
Hum Flyer's ad hoc `introDetail` string with a structured flag `screens/play.ts`
renders as a standard line on the microphone gate. See ADR-0005 for the
reasoning, including why music is not gated for its whole duration.

**What's still unverified:** there is no game yet that plays sound, so the
220ms default suppression window is reasoned from first principles (SFX +
room reverb through a phone speaker), not measured. The roadmap's stated
fallback — requiring headphones for onset-driven games — is still on the table
once Phase 3+ actually exercises this against a real speaker.

**Risk:** medium, and easy to underestimate. If gating proves unreliable on
speakers, the fallback is requiring headphones for onset-driven games — which
should be a deliberate decision, not a discovery.

---

## Phase 3 — The level-only game — **shipped**

**Ships: A3 Quiet Game.** Stay below a volume threshold to sneak past guards;
shout deliberately to break glass or throw a distraction.

**Why now:** it needs only `level`, which is built, tested, and calibrated. It is
the cheapest complete game on the list, which makes it the right way to prove the
Phase 1 shell against something that is not Hum Flyer.

**Done when** it is playable start to finish on a phone with no new engine code. ✅

**What actually shipped:** `games/quiet-game/` — `game.ts` is pure rules
(`QuietGame`, unit-tested exactly like `HumFlyer`), `index.ts` is the
`GameDefinition` plus a `render`. An auto-scrolling corridor of two obstacle
kinds, both read from `Frame.level` alone: **guards**, a zone you must cross
with level under a sneak threshold or a per-obstacle suspicion meter fills and
catches you; and **glass panels**, which you must cross while shouting above a
higher threshold or you crash into them unbroken. Shattering a glass panel also
buys a few seconds where guards ignore your volume entirely — the "throw a
distraction" half of the pitch, folded into the same shatter action rather than
built as a second mechanic. A round starts once you hold quiet for a beat,
mirroring Hum Flyer's "start on your first sound" but inverted, which doubles as
the joke the idea was pitched on. `requires: 'room'` — no pitch range needed, so
a player who has only done the room half of calibration can play immediately.
`headphonesRecommended: false`: no game audio, and the only detector in play is
level, so there is nothing for headphones to protect. No new engine code was
needed — confirms `engine/game.ts`'s contract holds for a game shaped nothing
like Hum Flyer.

**Risk:** very low. Held.

---

## Phase 4 — Onset games

**Ships: A4 Sonar Maze**, then **A2 Clap Runner**.

Sonar Maze first: it needs only `onset` and `level`, both built, and it is the
best-looking idea in the set. Clap Runner second because it needs one genuinely
new detector — a classifier separating a *transient* (clap) from a *sustained
tone* (a held "aaah"), using zero-crossing rate and spectral flatness. That
classifier is the phase's real work; the runner is the thing that proves it.

**Done when** the transient/sustain classifier holds up across at least three
devices, checked in the scope.

**Risk:** medium. Clap detection is reliable; *distinguishing* two kinds of vocal
sound is where this could disappoint. Build the classifier readout into the scope
before building the game around it.

**Sonar Maze shipped:** an auto-advancing corridor of `lanes` (3) parallel
tracks, dark by default. Every `spacing` world units a fork walls off two of
the three lanes; you have to already be in the one open lane by the time you
reach it. Which lane that is stays hidden — genuine fog of war — until a
clap's wavefront reaches the fork: `onset` triggers it, `level` sets how far
it reaches, and revealed geometry stays revealed for the rest of the round
(you're mapping it, not just lighting it). A hunter drifts forward from behind
at a base speed kept just under the player's starting speed, so an unclapped
round lets it fall behind on its own; every clap raises an "alertness" value
(scaled by `level`) that both speeds the hunter up — past the player's own top
speed at full alertness — and locks its lane-tracking on harder, and that
value decays when you stay quiet. That is the see-more/get-eaten loop from the
pitch: reading the maze costs noise, and noise is exactly what draws the
threat in. The hunter ignores the maze's walls entirely (it's not navigating
by sight, it's homing on noise) and its "randomness" is a deterministic
sine-based wander rather than real RNG, both simplifications made to keep the
rules small and the tests reproducible — see the doc comment on
`src/games/sonar-maze/game.ts`. Lane changes are a tap (top/bottom half of the
screen), not a voice input — the game's one audio verb is already fully spent
on the clap, and `onset`/`level` are the only detectors in scope here — see
ADR-0006 for why that's a deliberate, scoped exception to "voice as
controller" rather than a change to the project's general lean. Rendering
stays to native canvas arcs, gradients and rects — no per-pixel work — per the
risk note above.

---

## Phase 5 — Recorded pitch, and a timbre spike

**Ships: A6 Voice Line Rider.** Hum for a few seconds; the contour becomes
terrain; a marble rolls down what you sang.

Cheap, and interesting for an architectural reason: the input is *recorded then
replayed*, so detection latency stops mattering entirely. It is the one game here
where we can be slow and exact rather than fast and approximate.

**Then a timebox: A5 Vowel Steering.** Two analog axes from one voice — pitch
vertical, vowel horizontal. The most original idea on the list and the most
likely to fail, because spectral centroid moves with pitch, so the two axes will
bleed into each other.

**Done when** either the spike shows two usably independent axes and the game is
scheduled, or it is written up and moved to `parked` in `ideas.md`. Both are
acceptable outcomes; carrying it indefinitely as "planned" is not.

---

## Phase 6 — Music input

**Why here:** this is the wall between the two categories, and it is the biggest
single piece of work in the project. Nothing in category B can start until it
lands.

**Ships**

- A source picker: live microphone or a loaded file, per ADR-0001, including the
  awkward parts — decoding, a playback transport, and seeking.
- Two beat trackers agreeing on one output shape: a **causal** realtime one for
  the mic, and an **offline** whole-file one that returns a complete beat grid
  before play starts.
- Games declaring which sources they support, and the menu explaining the
  difference rather than silently offering a worse experience.
- Beat visualisation in the scope, because beat tracking is impossible to tune
  blind.

**Done when** the scope can show a stable beat grid for a track played into the
microphone across a room, and an exact one for the same track loaded as a file.

**Risk:** high — the highest on the roadmap. Realtime beat tracking from a room
microphone is genuinely hard, and the honest failure mode is that mic-driven beat
games are mushy while file-driven ones are tight. Budget for the offline path to
be the good one.

---

## Phase 7 — The beat-free music game

**Ships: B3 Ecosystem Garden.** Bass drives growth, mids spawn creatures, highs
are weather.

**Why before the beat games:** it needs only `bands`, so it works on a live
microphone with no beat tracking at all. That makes it the most robust category B
game and the right one to ship while beat tracking is still being tuned.

**Done when** a phone left listening to a room for a whole album produces a
garden worth looking at, without leaking memory or draining the battery.

**Risk:** low technically, medium as a design. It is the idea most at risk of
being pretty rather than fun, so give it a real management loop early or cut it.

---

## Phase 8 — Beat-driven games

**Ships: B1 Rhythm-Gated Combat**, then **B2 Reactive Runner / Tower Defense**.

B1 is the strongest concept in the whole project — the music changes your
*verbs*, not just the visuals — and it works on both sources, with the file path
adding a look-ahead telegraph. B2 is file-only by nature: knowing a boss arrives
at the drop means seeing the whole track in advance, which live audio cannot do.
B2 also needs song *section* detection on top of the beat grid, which is why it
comes last.

**Done when** a player can bring their own music and have the game feel authored
to it.

**Risk:** medium, and almost entirely inherited from Phase 6.

---

## Phase 9 — Making it an app

**Ships**

- Installable PWA with an offline shell, so it works as a phone app.
- A first-run flow that explains the microphone before requesting it, rather than
  the browser prompt arriving cold.
- Per-device latency compensation, measured once, applied everywhere.
- Accessibility: every game needs a stated answer for players who cannot use
  voice input, even if that answer is "this one is not for you, try these".
- Score sharing.

**Done when** someone can install it, hand their phone to a friend, and have that
friend understand what to do without being told.

---

## Cross-cutting, continuously

- **Performance budget.** Every detector runs per animation frame on a phone.
  Pitch detection is already decimated for this reason; beat tracking will need
  the same scrutiny. Profile on a real mid-range Android, not a laptop.
- **The scope leads.** Every new detector gets a scope readout *before* a game
  depends on it. This has already paid for itself twice.
- **Pure rules, testable.** Game logic stays in modules that take numbers and
  know nothing about microphones — the reason 44 tests run with no audio
  hardware.
- **Calibrate on real variance.** Test on a laptop at arm's length, a phone in
  hand, and with headphones, because that spread is what actually breaks these
  games.

---

## Sequencing at a glance

| Phase | Lands | Unlocks |
| --- | --- | --- |
| 1 | Game shell | everything after it |
| 2 | Output + ducking | any game with sound |
| 3 | — | A3 Quiet Game |
| 4 | Transient/sustain classifier | A4 Sonar Maze, A2 Clap Runner |
| 5 | — | A6 Voice Line Rider, A5 spike |
| 6 | Music input + beat tracking | all of category B |
| 7 | — | B3 Ecosystem Garden |
| 8 | Section detection | B1 Rhythm Combat, B2 Reactive TD |
| 9 | PWA, latency, a11y | shipping it as an app |

**Shortest path to a varied, complete-feeling app:** phases 1 → 2 → 3 → 4. That
is four voice games on a shared shell, using only detectors that already exist
and are already tested. Category B is a bigger bet, and Phase 6 is where it is
won or lost.
