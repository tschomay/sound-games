# Vowel Steering ships as a spike, with a fixed centroid range instead of calibration

A5 Vowel Steering (`ideas.md`) is the roadmap's own named risk: "spectral
centroid moves with pitch, so the two axes will bleed into each other,"
flagged "Needs a spike before it gets committed to." Phase 5's "done when"
asks for exactly one of two outcomes — the spike shows two usably independent
axes and the game gets scheduled, or it gets written up and moved to `parked`
— and names both as acceptable, with "carrying it indefinitely as 'planned'"
as the one outcome that isn't.

That verdict is a perceptual judgment — does moving pitch alone visibly drag
the vowel reading around, on a real voice, on a real device — that nothing
running in this sandbox can make. So this ADR record a narrower decision:
what the spike itself is built out of, so a human tester (and, later,
whoever reads this after they've tried it) has something concrete to reason
from.

## Decision

**`games/vowel-steering-spike/` ships as a real, registered game**
(`id: 'vowel-steering-spike'`), not a local-only prototype — per
`README.md`'s deploy flow, registering it in `games/registry.ts` is what
gets it onto a phone at all, which is the only environment that can answer
the question it exists to ask. Its title, description and intro all say
"spike" and "feasibility test" in plain language, specifically so it can
never be mistaken for a finished, committed game by a player or a future
maintainer skimming the menu.

**Centroid gets a fixed, hand-reasoned Hz range — 500–3000Hz
(`DEFAULT_VOWEL_RANGE`) — log-scaled the same way `normalisePitch`
(`engine/calibration.ts`) scales a `PitchRange`, rather than a calibrated
one.** Pitch gets calibration (ADR-0004) because a hummed range varies
enormously person to person and calibration is cheap to ask for once. Adding
an equivalent "sing 'ee', now sing 'oo'" calibration step for centroid would
have been the more principled long-term answer, but building a whole new
calibration flow for a value this spike might immediately park is the wrong
order of investment — commit to the harness only if the spike says the axis
is worth it. 500–3000Hz is reasoned, not measured: adult-voice F2 (the
formant that separates front vowels like "ee" from back vowels like "oo")
runs roughly 800–2500Hz in the literature, and spectral centroid — a
whole-spectrum brightness average, not a formant tracker, which is exactly
the crudeness the roadmap's risk note calls out — sits somewhat above and
below that band depending on harmonic content. The range is log-scaled
because, like pitch, a given proportional change in brightness should read
as the same-sized move regardless of where in the range it starts.
`normaliseCentroid(hz, range)` (`games/vowel-steering-spike/game.ts`) is a
pure function of `hz` alone — it never receives a pitch value — specifically
so that if the two axes do bleed into each other, that has to be shown to be
a property of the acoustic signal, not an artifact hiding in this arithmetic.

**The mechanic is a reticle on a 2D field, chasing `(vowelNorm, pitchNorm)`
toward a sequence of targets**, spaced by a deterministic Weyl sequence
(repeated addition of an irrational, mod 1) rather than `Math.random()` —
the same "reproducible pseudo-randomness over real RNG" precedent Sonar Maze
set (ADR-0006's sibling reasoning, `games/sonar-maze/game.ts`). The chase
uses the same exponential-blend pattern Hum Flyer uses for its pitch
follower, so per-frame jitter doesn't read as the reticle vibrating.
Deliberately minimal: it does not need to be fun, it needs to make bleed (or
its absence) visible.

**Both raw axis readings render on screen at all times** — `pitch: 0.62` and
`vowel: 0.41 (1400Hz)` — not just the reticle's resulting position. This is
the actual instrument the spike exists to provide: a tester can watch the
`vowel:` number while deliberately sliding pitch up and down and see, in
real time, whether it holds still or drags. It's the same purpose
`screens/scope.ts`'s live readouts serve, embedded directly in the game
instead of a separate diagnostic screen, because the two axes need to be
felt (steering) and read (numbers) in the same moment for the test to mean
anything.

## What the synthetic analysis could and couldn't check

Unit tests (`games/vowel-steering-spike/__tests__/game.test.ts`) cover two
different things, deliberately kept separate:

1. **`normaliseCentroid`'s own arithmetic** — range endpoints map to 0/1, the
   geometric mean of the range maps to 0.5, out-of-range values clamp rather
   than extrapolate, non-positive Hz doesn't produce NaN/Infinity, and the
   function takes no pitch argument at all. This confirms the *code* adds no
   coupling beyond what's already in the signal.
2. **A synthetic model of the real acoustic coupling the roadmap already
   named**, to make it concrete instead of hypothetical. Spectral centroid of
   a harmonic-rich voiced sound is a weighted average of harmonic
   frequencies `k * f0` for `k = 1, 2, 3, ...`, so it is bounded below by the
   fundamental: `centroid = f0 * (sum of a_k * k) / (sum of a_k) >= f0`,
   since every `k >= 1`. A test builds synthetic decaying-harmonic spectra at
   several pitches and rolloff shapes and confirms that bound holds, then
   shows the consequence: the *darkest reachable* `vowelNorm` at a given
   pitch rises as pitch rises, and at a high enough note (tested around
   B4/~494Hz, a plausible top of a calibrated hum range) the fundamental
   alone can already sit inside the 500–3000Hz vowel range, so "as dark as
   possible" stops being reachable near 0 at all.

**This is the one concrete, non-hand-wavy finding from the sandboxed
analysis: at the top of a singer's comfortable range, some amount of
pitch-to-vowel bleed toward the bright end is a mathematical certainty for
any harmonic-rich voice, not a tuning problem.** How large that effect feels
in practice, over the *middle* of a typical hum range where the fundamental
sits well below 500Hz — which is most of where this spike is actually
played — is exactly the open, unmeasurable-from-here half of the question.
Nothing here says whether the bleed is small enough to still feel like two
usable axes; only a human humming into a real microphone can make that call
(see the roadmap's Phase 5 entry, and `games/vowel-steering-spike/index.ts`'s
own intro copy, for why this codebase deliberately doesn't fabricate that
verdict).

## Consequences

- `games/vowel-steering-spike/` adds no new engine code: it reads
  `Frame.pitchNorm` and `Frame.centroid`, exactly as they already exist, and
  does its own normalisation locally rather than adding a second calibrated
  range to `engine/calibration.ts`. If the spike is later scheduled as a
  real game, promoting `DEFAULT_VOWEL_RANGE` into an actual calibration step
  (mirroring `PitchRange`) is the natural next piece of work — this ADR's
  500–3000Hz guess is exactly the number a "sing ee, sing oo" calibration
  step would replace with a measurement.
- `docs/roadmap.md`'s Phase 5 entry is marked shipped in the sense that both
  halves have landed and deployed — Voice Line Rider as a finished game, this
  spike as a finished spike — but the schedule-vs-park decision the phase's
  own "done when" calls for is explicitly still open, pending that human
  playtest. `docs/ideas.md`'s A5 entry stays `planned` until that verdict
  lands; this codebase does not mark it `built` or `parked` on its own
  authority.
- If real-device testing shows the bleed is too strong across the *whole*
  range, not just its top, the first thing to revisit is whether spectral
  centroid is the wrong feature entirely — a narrower formant estimate (e.g.
  tracking F2 directly via LPC, which this codebase doesn't currently have)
  might separate more cleanly than a whole-spectrum brightness average can,
  at the cost of being a meaningfully bigger build than this spike.
