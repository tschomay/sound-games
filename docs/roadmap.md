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

## Phase 4 — Onset games — **shipped**

**Ships: A4 Sonar Maze**, then **A2 Clap Runner**.

Sonar Maze first: it needs only `onset` and `level`, both built, and it is the
best-looking idea in the set. Clap Runner second because it needs one genuinely
new detector — a classifier separating a *transient* (clap) from a *sustained
tone* (a held "aaah"), using zero-crossing rate and spectral flatness. That
classifier is the phase's real work; the runner is the thing that proves it.

**Done when** the transient/sustain classifier holds up across at least three
devices, checked in the scope. ⚠️ Partially verified — see "what actually
shipped" below: unit tests against synthetic signals pass, but the
three-device check itself could not be performed in this sandboxed
environment. That is the one open item carried out of this phase.

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

**Clap Runner shipped:** the phase's real work — `Frame` gained `zcr` (zero-
crossing rate, normalised as a fraction of adjacent samples that flip sign
rather than crossings-per-second, specifically so the number means the same
thing on a 44.1kHz and a 48kHz device) and `timbreClass`, a `'silence' |
'transient' | 'tonal' | 'noisy'` read from a new `TimbreClassifier`
(`engine/timbre-class.ts`) that combines `zcr` with the existing `flatness`.
`onset.ts` and `pitch.ts` are untouched, matching Phase 2/A4 precedent — see
ADR-0007 for the full design, including why both features have to agree
before the classifier commits to "tonal" or "noisy," and why an ambiguous
frame holds the last sustained read instead of picking a side (the entire
hysteresis mechanism, and the direct answer to this phase's own risk note
about flicker). `screens/scope.ts` got `ZCR` and `Timbre class` readout cells
before Clap Runner was built, per the cross-cutting rule this phase's brief
quotes directly. On top of that, `games/clap-runner/` is an auto-runner
reading three independent verbs off one classifier: a clap (`onset`, as
before — Clap Runner reuses the existing detector for this, the classifier's
own burst detection exists mainly to distinguish a decayed-away clap from a
sustained shout) starts a fixed-duration jump arc, and a low obstacle only
clears if its zone falls inside the arc's above-clearance window — genuine
timing skill, not a flag check. A held `timbreClass === 'tonal'` glides across
a gap for as long as it's held, straight off the classifier with no game-side
state of its own. A shout — `timbreClass === 'noisy'` *and* `level` above a
config threshold, a game-level call kept out of the shared classifier on
purpose (ADR-0007) — ground-pounds through a breakable obstacle. Every
obstacle fails hard the instant you're in its zone in the wrong state, closer
to Sonar Maze's wall than Quiet Game's forgiving guard meter, which fits a
runner where touching the wrong thing is supposed to just be over. No game
audio: like Sonar Maze, Clap Runner ships with no SFX, so ADR-0005's gating
path is wired (`timbreClass` gets forced to `'silence'` on a gated frame, same
as `onset`) but still unexercised by any real game.

**What actually shipped versus what's still open:** the classifier's *logic*
is unit-tested against synthetic signals — a clean sine wave reads as low
zero-crossing rate, a deterministic noise burst reads as high, and
`TimbreClassifier` is tested directly against representative feature values
covering silence, a clean tone, a brief burst promoted to sustained noise
after its hold window, the onset short-circuit, and the no-flicker-on-an-
ambiguous-frame case. `ClapRunner`'s rules are tested the same way every
other game's rules are — pure numbers in, no microphone. None of that is what
the phase's own "done when" asks for, though: **the three-device check could
not be performed in this sandboxed environment**, so the default thresholds
in `DEFAULT_TIMBRE_THRESHOLDS` are reasoned from first principles (how
zero-crossing rate scales with voiced-frequency content versus broadband
noise), not measured on a laptop, a phone, and headphones the way the
roadmap's "calibrate on real variance" item calls for. That is this phase's
one open item, and ADR-0007 names the most likely failure mode (a phone
mic's AGC or a noisy room pushing a clean "aaah"'s flatness up toward the
noisy band) and which numbers to loosen first if real hardware disagrees.

---

## Phase 5 — Recorded pitch, and a timbre spike — **shipped**

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

**Voice Line Rider shipped:** `games/voice-line-rider/` — `game.ts` is pure
rules (`VoiceLineRider`, unit-tested the same way every other game's rules
are), `index.ts` is the `GameDefinition` plus a `render`. The record/replay
split doesn't map onto `ready`/`playing`/`over` cleanly, so it wasn't given a
new `RoundPhase`: both recording and replaying live inside `phase ===
'playing'`, with a `mode: 'recording' | 'replaying'` field the render reads to
pick between two different pictures — a growing waveform, then a terrain-and-
marble scene — the same pattern Sonar Maze uses for `crashed`/`caught`. A round
starts on your first hummed note, same as Hum Flyer; for the next
`recordDuration` seconds (4 by default, configurable in `Config`, not
hardcoded) the pitch contour is sampled at a fixed `sampleInterval` into a
`contour: number[]`, holding the last pitch through a silent gap rather than
dropping to zero, so a breath mid-hum doesn't carve a cliff into the terrain.
Once recording ends the contour is fixed and a marble is simulated rolling
across it as a bead on a wire — `acceleration = -gravity * localSlope`, plus
exponential velocity damping so it actually settles instead of oscillating
forever — driven by `dt` alone. `update(dt, frame)` ignores `frame` completely
during replay: that's the whole point of "recorded then replayed," so there
was nothing to gain from also reading the mic, and the roadmap's suggested
"retry gesture" was left out in favour of the shell's existing "play again"
flow. The round ends when the marble settles (or a `maxReplayDuration` safety
cap is hit) and scores by how close it stopped to a goal marker placed at a
fixed fraction of the recorded contour: `score = max(0, 1000 - distance *
10)`, normalised against a fixed scale rather than the actual recorded contour
length so the "reached the goal" formatting threshold stays exact regardless
of small frame-timing variance in how many samples a real round captures.
`formatScore` reads `"Reached the goal!"` at/above that threshold and
`"N.N units short"` otherwise, matching the wording this phase's brief
suggested. `requires: 'pitchRange'` — the second game, after Hum Flyer, that
needs a hummed range calibrated. `headphonesRecommended: false`: the mic is
only read during the few-second recording window, and the replay that follows
needs nothing from it at all, so there's no continuous listening for a phone
speaker to bleed into. No new engine code was needed.

**A5 Vowel Steering spike shipped** as `games/vowel-steering-spike/` — a real,
registered game (`id: 'vowel-steering-spike'`), titled "Vowel Steering
(spike)" and described plainly on the menu as a feasibility test rather than
a finished game, deployed like every other game specifically so it can be
played on a real phone. Pitch (`frame.pitchNorm`) drives a vertical axis;
`frame.centroid` drives a horizontal one through a new `normaliseCentroid`,
log-scaled the same way `normalisePitch` scales a `PitchRange`, against a
fixed, reasoned (not calibrated) 500–3000Hz brightness range —
`DEFAULT_VOWEL_RANGE` in `games/vowel-steering-spike/game.ts`. A reticle
chases both readings toward a sequence of targets placed by a deterministic
Weyl sequence, same "reproducible over real RNG" precedent Sonar Maze set,
and both raw axis numbers render on screen continuously — `pitch: 0.62`,
`vowel: 0.41 (1400Hz)` — so a tester can watch, live, whether nudging pitch
alone visibly drags the vowel reading. See ADR-0008 for the full reasoning,
including a synthetic (numbers-only, no microphone) check of the one
concrete coupling this environment *could* establish without a human: for a
harmonic-rich voiced sound, spectral centroid is mathematically bounded
below by the fundamental itself, so some pitch-to-vowel bleed toward the
bright end is a certainty near the top of a singer's range, not a tuning
bug. **What that finding cannot do is answer the question this phase's own
"done when" actually asks.** Whether the two axes feel usably independent
over the *middle* of a normal hum range — where most of a round is actually
played — is a perceptual judgment that requires a human humming into a real
microphone on a real device, which nothing in this sandboxed environment can
substitute for. So this codebase does not decide it: `ideas.md`'s A5 entry
stays `planned`, not `built` or `parked`, and **the schedule-vs-park call
that Phase 5 formally needs to be "done" remains open, pending that
playtest.** Both halves of the phase are built and live — that's what
"shipped" means above — but the decision the phase's own success criterion
asks for is a separate, still-outstanding step.

---

## Phase 6 — Music input — **shipped**

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
⚠️ Built, wired, and visible on screen — not yet verified. Every piece named in
that sentence exists and is exercised by tests against synthetic signal, but
"looks stable and correct" is a judgment about real audio in a real room, which
nothing in this sandboxed environment can make. See "what actually shipped"
below for exactly what is, and isn't, checked.

**Risk:** high — the highest on the roadmap. Realtime beat tracking from a room
microphone is genuinely hard, and the honest failure mode is that mic-driven beat
games are mushy while file-driven ones are tight. Budget for the offline path to
be the good one.

**Source picker shipped:** the first of Phase 6's four "Ships" bullets —
everything except beat tracking, which is separate, still-open work.
`src/engine/source.ts`'s `createFileSource` had existed since Phase 0 with
nothing calling it; it is now reachable. `src/screens/source-picker.ts` adds
`sourceGate`, a shared mic-or-file choice used by both `scope.ts` (always —
the scope leads, per the cross-cutting rule) and `play.ts` (only for a
`GameDefinition` whose `sources` includes `'file'`; every current game is
`['mic']`, so this is plumbing with nothing visibly different yet). A game
that doesn't declare file support keeps the exact single-button "Open
microphone" gate it always had — no needless choice screen. `FileSource`
gained real `pause()` and `seek()` methods (its `stop()` tears down the whole
`AudioContext`, which a pause button cannot use), backed by a new,
independently unit-tested `PlaybackTransport` state machine
(`src/engine/transport.ts`) that touches no audio node — just a clock and
plain numbers, same "pure rules, testable" precedent as every game's logic.
`src/screens/transport-bar.ts` renders a play/pause button and a scrub slider
over that, appearing in both the scope and the game shell the moment a
loaded file is the active source. See ADR-0009 for the full design.
**Beat tracking is now wired in and visible in the scope.** The two trackers
from the phase's second piece (`engine/beat.ts`, `beat-causal.ts`,
`beat-offline.ts`, `fft.ts`) went from complete-but-unused to actually driving
`Frame.beat` on every session. `Frame` (`engine/types.ts`) gained a `beat:
BeatReading` field, defaulting to `NO_BEAT` exactly like `gated` and
`timbreClass` default to their inert values — every existing game still sees
`frame.beat === NO_BEAT` and is otherwise unchanged, since none of them read
it. The two trackers don't share a natural per-frame call shape (the causal
tracker needs real onset events fed to it every frame to track anything;
`BeatGridReader` needs the file's playback position, not the analyser's own
clock, since the two diverge on pause and seek), so `Analyser.read()` doesn't
call either tracker directly — it calls one `BeatInput` adapter
(`engine/beat-input.ts`), and `session.ts` builds the right concrete one
(`CausalBeatInput` wrapping a fresh `CausalBeatTracker` for `'mic'`,
`FileBeatInput` wrapping a `BeatGridReader` for `'file'`) or none at all. See
ADR-0011 for the full design, including why the clock question is solved by
`FileBeatInput` owning its own clock closure rather than `Analyser` branching
on which tracker it's holding.

For a file, that `BeatGridReader` needs a `BeatGrid`, which means calling
`analyseBeatGrid` — a real, human-noticeable ~780ms cost for a three-minute
track (ADR-0010's own measurement). That now happens in
`screens/source-picker.ts`, folded into the same awaited chain that already
keeps the gate's "busy" state up through `createFileSource`'s decode, so a
player sees one continuous busy period rather than a decode that finishes and
then silently hangs. A file with no findable beat (silence, noise, too short)
is `analyseBeatGrid` returning `null`, handled the same as never having
called it — `Frame.beat` stays `NO_BEAT`, not an error.

`screens/scope.ts` gained `BPM` and `Beat confidence` readout cells, plus a
new visual distinct from the existing green onset flash and red gated flash:
a small violet ring in the corner that sweeps continuously with `beatPhase`
(not a binary flash — `beatPhase` is continuous, and a human judges "locked
on" by watching the sweep's smoothness and pace far more easily than from a
per-beat blink) plus a disc at its centre that snaps bright on the `onBeat`
edge and decays. An empty, unfilled ring is itself informative — `bpm: null`
reads as "found nothing," not as a broken screen. This is the actual "stable
beat grid" visualisation the phase's done-when calls for; it is what a human
needs to be looking at to make the call the done-when actually asks for.

**What was tested, and what wasn't.** The wiring itself is unit-tested the
way `analyser.test.ts` already tested suppression (`fake-audio-context.ts`, no
real Web Audio): a new `beat-input.test.ts` checks both adapters forward the
right arguments and delegate `reset()` correctly, and new cases in
`analyser.test.ts` confirm `Frame.beat` defaults to `NO_BEAT` with nothing
wired in, that `Analyser.read()` feeds a beat input this frame's own
`t`/`onset`/`onsetStrength`, and that gating suppresses what reaches it the
same way it suppresses `Frame.onset`. Combined with ADR-0010's own synthetic-
signal tests of the trackers' actual tracking behaviour, every piece of code
in this phase has a test. **None of that is a substitute for what the
roadmap's own "done when" asks for**, and this codebase does not pretend
otherwise: whether the scope's beat pulse actually looks locked-on for a real
track played into a microphone across a real room, and exact for the same
track loaded as a file, requires a human at the scope with real hardware and
real music, which nothing in this sandboxed environment can do. That check —
not the code — is what remains open.

No `GameDefinition.sources` value changed, and the menu copy this phase's
original brief also asked for ("games declaring which sources they support,
and the menu explaining the difference") is still deferred: with no game yet
declaring `'file'`, there is nothing concrete for that copy to explain, so it
was not speculatively written. Revisit it when the first file-capable game
ships — Phase 7's Ecosystem Garden, as it turned out, not mic-only after all
(see Phase 7 below): `screens/menu.ts`'s game cards still say nothing about
which sources a game supports, so that specific piece of Phase 6's original
brief remains open even after Phase 7, carried forward rather than silently
dropped.

---

## Phase 7 — The beat-free music game — **shipped**

**Ships: B3 Ecosystem Garden.** Bass drives growth, mids spawn creatures, highs
are weather.

**Why before the beat games:** it needs only `bands`, so it works on a live
microphone with no beat tracking at all. That makes it the most robust category B
game and the right one to ship while beat tracking is still being tuned.

**Done when** a phone left listening to a room for a whole album produces a
garden worth looking at, without leaking memory or draining the battery. ⚠️
Partially verified — see "what actually shipped" below for exactly what is,
and isn't, checked. The mechanics, the management loop, memory boundedness,
and the file-source path are all verified; the literal "phone left listening
for a whole album" scenario needs a real device and real elapsed time, which
nothing in this sandboxed environment can provide.

**Risk:** low technically, medium as a design. It is the idea most at risk of
being pretty rather than fun, so give it a real management loop early or cut it.

**What actually shipped:** `games/ecosystem-garden/` — `game.ts` is pure
rules (`EcosystemGarden`, unit-tested the same way every other game's rules
are), `index.ts` is the `GameDefinition` plus a `render`. Only `Frame.level`
and `Frame.bands` are read, exactly as scoped — no onset, no pitch, no
timbre. The management loop the phase's risk note demanded: **bass** grows a
single `growth` scalar 0..1 (capped, never a stored array — see below);
**mids** spawn **creatures**, a capped array (`maxCreatures`, default 24)
that also pollinate (a small growth-rate bonus per living creature, the
"maybe they help" option from the brief); **highs**, smoothed, drive
transient `weather` (`'sun' | 'wind' | 'rain'`) that in turn nudges growth
and spawn rates while active and clears the moment the highs do; and a
**sustained loud passage** (`level` held above `predatorThreshold`) builds
pressure toward spawning a **predator** — a capped array (`maxPredators`,
default 6) — whose `aggression`, and therefore its health drain, escalates
the longer it goes unmanaged. The player's only tool is loudness itself, per
the brief: a **rising edge on `level` crossing `scareThreshold`** (a shout, a
clap-like spike) sends every active predator into a `fleeing` countdown,
after which it despawns and pays a score bonus — the exact same
threshold-crossing-on-`level` pattern `QuietGame` already uses for its
shout, aimed at a different consequence here. Garden `health` hits 0 →
`phase = 'over'`, a real loss; `score` accumulates every playing second,
scaled by current health (a neglected, half-dead garden earns less than a
thriving one) plus a flat bonus per predator actually repelled, so managing
predators is what the score rewards, not just idle survival time.
`formatScore` reads `"N garden points"`. A round starts once there's
sustained sound at all (`level` above a low presence threshold for a beat)
— the same "start on your first sound" precedent every prior game uses,
generalised to the one signal this game is allowed to read. **Bounded
memory, concretely:** plants are not a stored array at all — `growth` is one
scalar, and how many of `config.plantSlots` (a fixed number) are in bloom,
and how tall, is a pure function of that scalar recomputed by the render
every frame, so there is no plant state to leak over a multi-minute session.
Creatures and predators are the only two arrays that hold per-individual
state (they move), and both are hard-capped — new spawns are dropped once a
cap is hit rather than queued, a "carrying capacity," not a queue — so
neither array's length can grow without bound regardless of session length
or how loud the input stays. A unit test (`__tests__/game.test.ts`) drives 5
simulated minutes of alternating loud/scare input specifically to check both
arrays stay at or under their caps through real churn, not just steady
state. Rendering is native canvas draws (arcs, lines, gradients) with no
per-pixel work and no allocation scaled by session length, matching every
prior game's performance precedent.

**This is also the first game to declare `sources: ['mic', 'file']`,**
exercising Phase 6's source-picker/transport plumbing from inside a real
round for the first time. That was verified by actually driving it — headless
Chromium against a running `vite dev`, a synthetic multi-segment WAV
(bass → mid → high → sustained loud → a scare burst → silence) picked
through the real "Choose a file" control, with a calibration profile
pre-seeded into `localStorage` to skip the separately-shipped calibration
screen. Confirmed live: the gate offers both mic and file for this game
specifically; picking a file decodes and reaches a playable round with zero
console errors; the transport bar's play/pause and scrub genuinely work
against a live round (pausing freezes the input at silence without stopping
the round's own clock — the garden just has nothing to react to, same as a
quiet room); and the whole management loop — growth, a creature spawn,
predators escalating health drain, and a scripted scare burst clearing them
and paying its score bonus — ran correctly end-to-end on real decoded audio.
No shell code needed to change. Full detail, plus one real finding about
`level` being broadband-loudness-independent-of-band (a single loud pure
tone reads as "loud" the same as a loud noise burst — correct, but a
synthetic single-tone test fixture is a worse stand-in for "quiet music"
than a multi-tone or broadband one), is in ADR-0012, which also resolves
ADR-0009's open question about whether the transport bar should hide itself
during play: for this game, no — an ambient session is exactly the case
where pausing the room or scrubbing an album is a feature.

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
is four voice games on a shared shell. Phases 1–3 and the first half of Phase 4
use only detectors that already existed going in; Phase 4's second half adds
one more (the transient/sustain classifier), tested the same way — pure
numbers in, no microphone — but not yet checked against real hardware
variance. Category B is a bigger bet, and Phase 6 is where it is won or lost.
