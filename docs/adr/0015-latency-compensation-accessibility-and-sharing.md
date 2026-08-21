# Per-device latency compensation, per-game accessibility notes, and score sharing

Phase 9's final three "Ships" bullets, and the last work on the roadmap. Three
mostly-independent decisions; grouped into one ADR because none of them is
individually as load-bearing as Phase 6 or Phase 8's, and reading them together
is how they were actually reasoned about — the accessibility note for two of
the beat-driven games only reads honestly once the latency-compensation design
below has established that they need no sound from the player at all.

## 1. Latency compensation: measured once in `engine/latency.ts`, applied once in `engine/analyser.ts`

### The hazard, precisely

`docs/ideas.md` and `README.md`'s "Design notes" both establish that voice
input has a *given* detection latency (30–45ms to a confident pitch, 10–20ms to
a clap) that is inherent to the DSP, not something a specific device adds.
What varies by device is different: the gap between this app scheduling a
sound through the output bus and a listening microphone actually hearing it —
this device's own speaker/DAC/OS audio stack, plus whatever the analyser's own
buffering adds on the way back in. Rhythm-Gated Combat and Drop Siege are the
two games that judge a tap's timing against a beat instant, so a device with
unusually high output-to-input latency makes an objectively well-timed tap
read as late — not because the player mistimed anything, but because by the
time they've heard the beat that made them tap, this app's own clock already
thinks the beat happened however long ago the device's own latency is.

### Decision: measure it with a real loopback, not a synthetic estimate

There is no way to know a device's own audio latency without actually asking
it: play something, listen for it, time the round trip. `engine/latency.ts`
does exactly that — `LoopbackLatencyMeasurement` plays a short click through
the existing `OutputBus` and times its arrival against a fresh `OnsetDetector`
fed the analyser's *raw* spectrum every frame, using `AudioContext.currentTime`
on both ends so JS scheduling jitter (event loop delay, `requestAnimationFrame`
timing) never pollutes the measurement — only the audio hardware's own delay
does.

**Why the raw spectrum, not `Frame.onset`.** `OutputBus.playSfx` opens
ADR-0005's suppression window on the very click being measured — by design,
that's the mechanism that stops a game's own SFX from re-triggering its own
onset detector. Reusing `Frame.onset` here would mean the click is guaranteed
to read as *not* an onset, defeating the measurement before it starts. So the
measurement carries its own `OnsetDetector` instance, fed `analyser.spectrumView()`
directly, deliberately bypassing the suppression gate that every other
consumer of the analyser correctly respects.

**Several trials, aggregated by median, not one.** A single trial is one
sample of a system with real jitter (OS scheduling, a momentarily busy audio
thread). `LoopbackLatencyMeasurement` runs up to five (configurable), each with
its own timeout so one that never arrives doesn't hang the whole measurement,
and `summariseLatency` takes the median of however many came back clean —
resistant to one outlier in either direction, and reporting `null` rather than
a number built from too little evidence when fewer than `minSamples` trials
succeeded.

### Decision: apply it in `Analyser`/`BeatInput`, not in each game

The brief floated two shapes: compensate centrally so every consumer of
`Frame.beat` gets it for free, or have each beat-driven game read the profile
and adjust its own hit window. The central option won, for a reason specific
to this codebase's existing architecture rather than a general preference:
**Rhythm-Gated Combat and Drop Siege already read `frame.beat.beatPhase` (and
`onBeat`, `bpm`, `beatIndex`) through their own `Input` shape with no
transformation at all** — `index.ts` in both games copies those fields
straight off `Frame.beat` (see `rhythm-gated-combat/index.ts` and
`drop-siege/index.ts`). That means compensating inside the engine, before
`Frame.beat` is ever constructed, requires **zero changes to either game's
rules or wiring** — the exact "every consumer gets it for free" outcome the
brief described, realised as literally as it can be.

The mechanism (`beat-input.ts`): `BeatInput.advance` gained a fourth
parameter, `latencySeconds`, which `Analyser.read()` computes fresh every
frame from `this.profile.deviceLatencyMs` (so a profile update mid-session —
re-measuring, or loading a different player's profile — takes effect
immediately, the same way `normaliseLevel`/`normalisePitch` already re-read
`this.profile` every frame). Each concrete adapter applies it to its own idea
of "now": `CausalBeatInput` subtracts it from `t` before calling
`CausalBeatTracker.process`; `FileBeatInput` subtracts it from
`positionSeconds()` before calling `BeatGridReader.read`. Both adapters
already owned a different clock (ADR-0011's whole reason for existing), so
each was the natural, and only, place that could apply the shift to *its own*
clock without either adapter needing to know how the other one works.

**Why subtracting, not adding — the derivation.** Say a device's own
output-to-input latency is `L`. A beat the internal clock calls instant `t₀` is
not actually audible until real time `t₀ + L`. A player who taps the instant
they hear it taps at real time `≈ t₀ + L`. If the beat reading at that real
moment is computed straight off the *unshifted* clock, it reports the phase as
of `t₀ + L` — already `L` past the beat instant, which is exactly "an
objectively well-timed tap reads as late." Querying the tracker instead with
`(t₀ + L) - L = t₀` reports the phase as of the true beat instant — exactly on
time. So the compensation is: whatever instant a query actually happens at,
ask the tracker what the beat was doing `L` seconds earlier. That is subtract,
not add, and it is a pure, constant time-shift of the whole beat clock — which
is why it composes cleanly with everything both trackers already do (a
constant offset preserves every relative timing calculation inside
`CausalBeatTracker` and `BeatGridReader` untouched).

**What this single number can't distinguish, honestly.** The loopback
measures round-trip latency through *this device's own* speaker and mic. For
a file source (Drop Siege, and Rhythm-Gated Combat on file), that's exactly
the relevant chain — this device schedules the sound and this device's own
speaker is what makes it audible. For a mic source listening to *external*
music (a phone/speaker playing a track in the room, mic-only Rhythm-Gated
Combat), only the input-side half of the measurement — mic buffering, analyser
buffering, the onset detector's own latency — is actually relevant; the
output-side half (this device's speaker/DAC) measures a chain the external
music never travels through. There is no loopback-only way to split those two
components apart from a single measurement, so both games apply the one
number uniformly. This is named here rather than hidden, and is the reason
the roadmap's "what actually shipped" section calls the *mechanism* built and
tested but its *real-world accuracy* unverified.

### Decision: an optional, skippable step, reachable from the menu — not folded into `calibrate.ts`'s existing flow

`calibrate.ts`'s existing `Step`/`ROOM_STEPS`/`VOICE_STEPS` machinery is built
around "collect samples until a percentile settles" — level and pitch, both
continuous signals sampled many times a second. A loopback measurement is a
different shape entirely: discrete trials, each either "heard it" or "timed
out," nothing to average within a trial. Bending the existing `Step`
abstraction to fit would have meant either weakening it or growing a second,
parallel code path inside the same function — worse than a dedicated screen.

So `src/screens/latency-setup.ts` is its own screen, at its own route
(`#/latency-setup`), reached from a third row on the menu's `setupPanel` —
"Room" and "Voice control" already live there; "Device latency" is a natural
third, same `done`/`action`/`route` shape, same "optional, redoable, sent to
`calibrate` first if there's no room profile yet to attach a number to"
pattern `voiceSetupScreen` already established. Skipping it (or the mic
permission being denied, or every trial timing out) leaves `deviceLatencyMs`
at `0` — the existing calibration default, meaning "no compensation," a safe
and fully playable state rather than an error one. `calibration.ts`'s
`CalibrationProfile` gained the field as a version bump (`VERSION = 3`),
following the exact migration precedent version 2 set for `pitchRange`: an
old stored profile without the field is lifted forward with `deviceLatencyMs:
0`, never discarded.

### What was tested, and what wasn't

`engine/latency.ts`'s own logic — `LatencyTrial`'s begin/sample/timeout state
machine, `summariseLatency`'s aggregation, `createClickBuffer`'s envelope, and
`LoopbackLatencyMeasurement`'s full trial sequencing — is unit-tested end to
end with synthetic spectra and a `FakeAudioContext`/`OutputBus` pair (extended
with a `createBuffer`/`sampleRate` the existing fake didn't need before now),
the same "test the logic without real Web Audio" precedent `output.test.ts`
set in Phase 2. `beat-input.test.ts` and `analyser.test.ts` cover the
subtraction itself: both adapters shift their respective clock by exactly
`latencySeconds`, and `Analyser.read()` reads `profile.deviceLatencyMs` fresh
and converts it correctly. `calibration.test.ts` covers the version-3 shape
and its migration from both version 1 and version 2. A real, running
`vite preview` build was driven end to end with headless Chromium
(Playwright): a fresh visit to `#/latency-setup` with no profile redirects to
`#/calibrate`; with a seeded profile it shows the "Start" gate, mentions the
microphone; clicking Start opens a real `getUserMedia` session (Chromium's
fake-audio-device flag), runs the whole measurement loop against a real
`AudioContext`/`AnalyserNode`/`OutputBus`, and reaches a result screen that
correctly persists `deviceLatencyMs` back into `localStorage` — with zero
console errors. **What that run cannot establish, and does not pretend to:**
Chromium's fake capture device is a synthetic test pattern, not a real
speaker-to-microphone acoustic path, so the specific number it produced in
that run is an artifact of the fake device, not evidence about real hardware
latency. Confirming the *number* means something on a real phone, laptop, or
headphone set requires exactly that — real hardware this sandboxed
environment does not have — matching the same honest caveat every DSP-adjacent
phase since 4 has shipped with.

## 2. Accessibility: `GameDefinition.accessibilityNote`, filled in honestly for all nine games

### Decision: a required, plain-string field — no severity levels, no partial-credit taxonomy

`accessibilityNote: string` on `GameDefinition` (`engine/game.ts`), required
rather than optional, so a ninth game added later cannot forget to answer the
question the roadmap raised. No enum ("full"/"partial"/"none") was added on
top of the string: the honest answer genuinely varies in shape game to game —
some are flatly "not for you," some have a real secondary input worth naming,
one is entirely hands-off already — and a taxonomy would have forced every
answer into a box that doesn't fit some of them. A plain sentence or two,
read by a human on the menu, was judged more honest than a badge.

### The three kinds of honest answer that came out of writing all nine

- **Flatly not accessible without voice, with nowhere to hide it:** Hum Flyer,
  Voice Line Rider, Vowel Steering (spike), Clap Runner. Each is built around
  a specific voiced or percussive sound with no alternative input at all —
  the note says so plainly and points at Rhythm-Gated Combat or Drop Siege,
  the two games that need none.
- **Nuanced — a real secondary input exists, but doesn't cover the whole
  game:** Sonar Maze and Quiet Game. Sonar Maze's lane-switching is already a
  tap (ADR-0006), genuinely accessible on its own, but the maze-*revealing*
  verb is a clap-like transient with no substitute — the note says exactly
  which half is which, rather than reducing a two-part game to one verdict.
  Quiet Game's threshold is `Frame.level` alone, so it doesn't strictly
  require *voice* (a tap on a hard surface near the mic reads the same as a
  clap or a word), but it does require some sound on command — the note
  names that distinction rather than either overstating the requirement
  (it's not really "singing") or understating it (silence itself isn't
  optional).
- **Already fully accessible, stated as such rather than left to be
  inferred:** Ecosystem Garden, Rhythm-Gated Combat, Drop Siege. All three
  read music/bands/beat, never the player's own voice, and the two beat games
  already use a tap as their one player verb (ADR-0006 again). Ecosystem
  Garden's case is the most interesting: its one "player action" (a loud
  sound to scare off predators) is a rising edge on `Frame.level`, which a
  loud passage in a loaded file triggers exactly as well as a shout does — so
  the file-source path is not just accessible, it's *equally* the intended
  way to play, not a downgraded accommodation.

### Decision: surfaced on the menu card as a labelled, always-visible line — not a click-to-expand disclosure

The brief allowed either shape. A `<details>`/`<summary>` disclosure was
considered and dropped for a concrete DOM reason: every game card in
`screens/menu.ts` is already one whole `<button class="card">`, its click
handler navigating to the game — nesting a second interactive disclosure
element inside a `<button>` is invalid HTML (a button cannot contain another
interactive control) and would have meant restructuring the card's click
target away from "the whole card," a bigger change than this note warranted.
A plain `<p class="hint hint--access">`, prefixed `"Without voice: "` in a
`<strong>` so it reads as an answer rather than more marketing copy, sits
under the description on every card — discoverable by anyone who looks at a
card at all, with no click required, which is the more conservative reading
of "don't bury it in a place nobody would see it."

## 3. Score sharing: `engine/share.ts`'s `shareScore`, wired thinly into `play.ts`

### Decision: the decision logic is a pure, DOM-free function; `play.ts` only turns its answer into a button label

`shareScore(target, gameTitle, scoreText, url)` takes a small structural
`ShareTarget` (`{ share?(...): Promise<void>; clipboard: { writeText(...):
Promise<void> } }`) rather than the real global `navigator`, specifically so
its branching — try the Web Share API, treat a user cancel as
`'cancelled'` (not a failure), fall through to the clipboard on any other
share failure, report `'failed'` only when *both* paths are exhausted — is
unit-testable with a fake object and no browser at all, the same "pure logic,
testable" precedent every game's rules already follow. `screens/play.ts`'s
`shareResult` is four lines: call `shareScore(navigator, ...)`, map the
outcome to a button label. This mirrors the split `engine/latency.ts` /
`screens/latency-setup.ts` already draw in this same phase: real platform
interaction stays thin and at the edge; the decision that matters is pure and
tested in the middle.

### Decision: `'cancelled'` is not a failure

The brief's "a real user-visible confirmation either way" is about the two
*paths* (native share vs. clipboard), not about a player closing the native
share sheet on their own — that's not this app failing to do anything, it's
the player declining, and flashing "Could not share" at someone who just
changed their mind would be a false alarm. `shareScore` distinguishes an
`AbortError` (the standard way both Chromium and WebKit report a cancelled
share sheet) from every other rejection, and only the latter falls through to
the clipboard attempt.

### What was tested, and what wasn't

`share.test.ts` covers all four `ShareOutcome`s against fake targets: a
successful native share, a share-API-absent clipboard fallback, a cancelled
share reporting `'cancelled'` without ever touching the clipboard, a share
that rejects for a non-cancel reason correctly falling through to a
successful clipboard copy, and both paths failing together correctly
reporting `'failed'`. What was **not** driven end-to-end in a real browser is
the actual results-screen button: reaching `showResults()` requires playing a
real game to `phase === 'over'` through a live (or fake-device) microphone
session, which none of this phase's other Playwright checks needed and which
was judged not worth the added complexity given how thin the DOM wiring
around the already-tested `shareScore` actually is. This is a real, named gap
rather than a silent one: a second pass with a real device is the natural
place to also glance at the Share button in the results panel.

## Consequences

- Two games' rule files (`rhythm-gated-combat/game.ts`, `drop-siege/game.ts`)
  and their `index.ts` wiring are entirely unchanged by the latency work —
  the strongest evidence that the central-compensation decision above was the
  right one for *this* codebase's existing shape.
- `CalibrationProfile` is now at version 3; anything reading a persisted
  profile from before this phase gets `deviceLatencyMs: 0` rather than losing
  its `noiseFloorDb`/`loudDb`/`pitchRange`.
- Every `GameDefinition` now requires `accessibilityNote` — a ninth game
  added later fails to typecheck without one, by design.
- Score sharing needed no new dependency and no server: `navigator.share` and
  `navigator.clipboard` are both already-standard browser APIs, and nothing
  about a shared score needs to be verified or stored anywhere but the
  player's own device.
- This closes Phase 9's last three "Ships" bullets. Combined with the PWA
  shell and first-run explainer from the prior task, Phase 9 — and the
  roadmap's entire originally-planned scope — is shipped.
