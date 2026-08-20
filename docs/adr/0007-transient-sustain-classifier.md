# Classify transient vs. sustained tone from zero-crossing rate + flatness

A2 Clap Runner needs three independent verbs from one microphone: clap = jump,
held "aaah" = glide, shout = ground-pound. `onset.ts` already gives a clean
clap detector (spectral flux against an adaptive threshold), and `flatness`
already existed on `Frame`. What was missing was the thing the phase brief
names directly: a classifier that reads a sustained sound's *shape* — tonal
(periodic, like a held vowel) versus noisy (broadband, like a shout) — using
zero-crossing rate alongside flatness, per `ideas.md`'s A2 entry.

## Decision

**Zero-crossing rate lands on `Frame` as `zcr`, computed in `analyser.ts`
from the same `timeDomain` buffer already read for `level`.** It is
normalised as a *fraction of adjacent sample pairs that flip sign* (0..1)
rather than crossings per second. That choice is specifically about the
phase's own "done when": *"holds up across at least three devices."* Crossings
per second would need scaling by sample rate to compare across devices at
44.1kHz vs 48kHz; the per-sample fraction is already normalised, so the same
waveform reads the same number regardless of what a given phone's audio
hardware happens to run at. It's exactly the same reasoning `level` already
gets from calibration (ADR-0003) — comparable numbers across devices — just
applied to a feature that's cheap to normalise for free instead of needing a
measured profile.

**The classification itself is its own module, `engine/timbre-class.ts`,
`TimbreClassifier`.** It takes `zcr`, `flatness`, `level`, and (optionally) the
frame's own `onset` flag, and returns one of `'silence' | 'transient' |
'tonal' | 'noisy'` (the `Timbre` type, on `types.ts` next to `Bands` — the
shape lives with the other detector outputs, the class that computes it lives
in its own file, same split `Bands`/`analyser.ts` already uses). This mirrors
ADR-0005 and ADR-0006's precedent of keeping a new concern in its own module
rather than tangling it into `onset.ts` or `pitch.ts`, which stay untouched.

**Both features have to agree before the classifier commits to an extreme.**
A clean tone sits low on both zcr and flatness; noise sits high on both; real
voices move the two together rather than independently, so requiring both
avoids one feature's threshold on its own from making the call. A frame that
lands between the two bands — neither clearly tonal nor clearly burst-like —
holds whatever the classifier's last sustained read was, rather than picking
a side. That's deliberately the *entire* hysteresis mechanism: no smoothing
buffer, no exponential average, just "don't leave a stable state on an
ambiguous frame." It is what stops a voice hovering near a threshold from
flickering tonal/noisy frame to frame, which is exactly the failure mode the
roadmap's risk note names ("distinguishing two kinds of vocal sound is where
this could disappoint").

**A burst-shaped frame reads `'transient'` for a short hold window, then gets
promoted to `'noisy'` if it keeps going.** `onset.ts`'s flux-based detector is
still the more precise instrument for finding *where* a transient starts —
when it fires, the classifier short-circuits straight to `'transient'` rather
than waiting on its own frame count. But `onset` alone can't tell a clap from
the first instant of a shout, both of which look broadband; duration is what
actually separates them, so the classifier's own zcr/flatness-based burst
detection carries a hold-frame count (default 4, ~65ms at 60fps) purely to
distinguish "this decayed away like a clap" from "this kept going, it's a
shout."

**Shout, as a game verb, is "noisy" *and* loud (`level` above a
config threshold), decided in `clap-runner/game.ts`, not baked into the
classifier itself.** The classifier's job is shape (tonal vs. noisy); how
loud counts as "deliberate" is a game-specific call — Quiet Game already made
an equivalent call with its own `shoutThreshold`, independent of any
detector. Keeping it out of `TimbreClassifier` keeps the classifier reusable
by any future game that wants the shape read without the same loudness
opinion.

**Thresholds are first-pass estimates, not measurements**
(`DEFAULT_TIMBRE_THRESHOLDS` in `timbre-class.ts`): reasoned from how
zero-crossing rate scales with frequency — a voiced fundamental in the
70–1000Hz range this codebase already targets for pitch sits at a small
fraction of the sample rate, broadband noise sits close to the 0.5 ceiling for
uncorrelated samples — not tuned against real hardware. Unit tests cover the
logic against synthetic sine/noise waveforms and hand-fed representative
zcr/flatness values (`engine/__tests__/analyser.test.ts`,
`engine/__tests__/timbre-class.test.ts`), which is what "the classifier holds
up across at least three devices" cannot be, absent real devices. That
validation — a laptop, a phone in hand, headphones — is exactly the "calibrate
on real variance" cross-cutting item and remains open; see the roadmap's
Phase 4 entry for what shipped versus what's still unverified.

**A scope readout landed before the game**, per the roadmap's own
cross-cutting rule ("build the classifier readout into the scope before
building the game around it — this has already paid for itself twice"):
`screens/scope.ts` gained `ZCR` and `Timbre class` cells alongside the
existing `Flatness`/`Gated` ones, so a real device disagreeing with these
thresholds is visible without needing Clap Runner running at all.

## Consequences

- `Frame` gained two fields (`zcr`, `timbreClass`) computed unconditionally
  every read, same cost pattern as `centroid`/`flatness` — cheap, and every
  game gets them whether it uses them or not.
- `timbreClass` is forced to `'silence'` while a frame is gated (ADR-0005),
  the same treatment `onset` gets, so a game's own SFX can't be misread as a
  shout or a held tone. The classifier is still *fed* the real numbers every
  gated frame — same reasoning as `onset.ts`'s flux history — so its
  hysteresis state doesn't go stale and misfire the instant the gate closes.
- Clap Runner ships with no game audio at all, so this gating path is
  currently unexercised by any real game — same position Phase 2 shipped in,
  now inherited by a second phase.
- If real-device testing shows the thresholds wrong, `DEFAULT_TIMBRE_THRESHOLDS`
  is the one place to retune — the classifier's control flow (agree-on-both,
  hold-on-ambiguous, hold-frames-before-promoting-to-noisy) shouldn't need to
  change, only the numbers.
- The most likely real-device failure mode: a phone mic's own AGC or a noisy
  room raising the effective noise floor could push `flatness` up on a clean
  "aaah", nudging it toward the ambiguous band or past `burstFlatness`
  entirely. If that happens, `tonalFlatness`/`burstFlatness` are the first
  numbers to loosen — see `ideas.md` hazard 3 on why the mic's own DSP is
  already fighting this codebase before any classifier gets involved.
