# Two beat trackers: an offline whole-file grid and a causal realtime one

ADR-0001 committed this project to two audio sources and noted the consequence
in one line: *"Beat tracking needs two implementations — a causal realtime one
and an offline whole-file one — that agree on the same output shape."* Phase 6's
brief is blunter still about how that will turn out: **"Budget for the offline
path to be the good one"**, and *"the honest failure mode is that mic-driven beat
games are mushy while file-driven ones are tight."*

This ADR records what was built for both, and — because none of it has met real
audio — where each is expected to fail.

## Decision: one `BeatReading`, two things that produce it

`engine/beat.ts` holds the shared shape and nothing else:

```ts
interface BeatReading {
  bpm: number | null;        // null when there isn't enough signal to say
  beatPhase: number | null;  // 0..1 inside the current beat; null when bpm is
  onBeat: boolean;           // edge, not level: first reading at/after a beat
  confidence: number;        // 0..1
  beatIndex: number | null;  // which beat this is
}
```

`beatIndex` is the one addition to the shape the brief sketched. It costs
nothing — both trackers already count beats internally to make `onBeat` an edge —
and it is what a game needs to do anything on a multiple of the beat ("every
fourth beat", a bar-length telegraph). It carries an explicit caveat in its doc
comment: for the offline grid it counts from the first beat of the track, for the
causal tracker from whenever it locked on, and **neither knows where the bar
line is.** Downbeat detection is a separate problem and is not solved here.

Both trackers implement `BeatReader` — `read(now)` plus `reset()` — so the
scope, and later a game, can hold one without knowing which it has. `read` is
documented as a *tick*, not a pure query: the causal tracker advances its
prediction inside it, and both use the gap between successive calls to decide
whether `onBeat` fires. It must be called once per frame, in order. The `now` it
takes means different things on each side — playback position for the grid,
analyser clock for the causal one — which is unavoidable and is called out at
the interface rather than left to be discovered.

`onBeat` is deliberately an *edge that is late rather than early*: it fires on
the first reading at or after the beat instant, never before. At 60fps that is at
most 17ms of lateness, and a beat flash that is consistently a frame late is a
far smaller problem than one that sometimes arrives before the sound.

## Decision: the offline tracker fits one rigid grid to the whole file

`engine/beat-offline.ts`, in three stages.

**1. A log-compressed spectral-flux envelope at 100 Hz.** Conceptually the same
measurement `onset.ts` makes, but `onset.ts` is built around a live
`AnalyserNode` and a rolling median threshold, so it could not be reused
directly — this computes its own STFT over the buffer's samples. The audio is
downmixed and decimated to ~22 kHz first (the same trick `pitch.ts` uses to make
its maths affordable), then windowed at 512 samples — about 23ms — with a 10ms
hop. The short window is the deliberate choice: frequency resolution barely
matters for flux, but **window length is what limits how precisely an onset can
be placed in time, and the grid's phase accuracy comes straight out of that.**
Magnitudes are log-compressed as `log(1 + 1000·m)` before differencing, so a loud
chorus does not drown out a quiet verse's contribution to the tempo. A moving
average over ±150ms is then subtracted and the result half-wave rectified:
autocorrelation measures periodicity *about the mean*, and an un-detrended flux
envelope is entirely positive, so its mean would swamp the beat structure.

This needed an FFT, which is why `engine/fft.ts` now exists — a hand-rolled
radix-2 transform with precomputed twiddles, ~100 lines, no dependency. A
four-minute track is ~24,000 transforms; a naive DFT would be tens of billions of
multiplies. `pitch.ts` escapes needing one because NSDF is a time-domain method;
spectral flux has no such escape.

**2. Autocorrelation proposes; a grid fit disposes.** This is the part that took
several attempts, and the reasoning is worth recording because the obvious
approaches are wrong in instructive ways.

The autocorrelation of an onset envelope *cannot* distinguish a tempo from twice
or half of it — every multiple of a period is also a period, by its measure. The
textbook fix is a comb filter that rewards energy on a candidate's beats and
penalises energy exactly halfway between them, which correctly kills the
half-tempo reading. **It was implemented, and it fails on ordinary music.** For a
kick-and-hat pattern the "halfway between" points are the hats — real onsets — so
the penalty guts the *true* tempo, while a candidate at one-and-a-half times the
beat has its penalty points land on nothing and escapes unscathed. Tuning the
penalty coefficient does not fix it; it only moves which of the two cases breaks.

So the autocorrelation was demoted to a *proposer*. It hands over every
periodicity it can see (local maxima of a harmonic sum of the ACF, up to four,
plus the top proposal's own double and half so the octave question is always
put), and each proposal is then fitted as an actual beat grid and scored on how
well it explains the track:

- **Recall** — the share of the envelope's energy that lands on a beat,
  discounted by the share a grid of that tempo would catch from a featureless
  envelope. A grid at *half* the true tempo fails this: it walks past every other
  beat.
- **Evenness** — how evenly that energy is spread over the grid's beats,
  measured as a participation ratio over the per-beat energies. A grid at *twice*
  the true tempo passes recall perfectly — it catches everything the correct grid
  catches — and fails this, because every second beat lands on nothing. The
  participation ratio is 1 when every beat carries the same energy and exactly
  1/2 when half of them carry it all, which is the double-tempo case, and it
  needs no threshold for "does this beat have a hit on it".

Recall and evenness multiplied is what a candidate is ranked and trusted on, with
a mild log-normal tempo prior centred on 120 BPM (`beat.ts`) breaking the ties
that remain genuinely symmetric. **The half-versus-double question is only
decidable at all because these two measures fail in opposite directions**; that
is the central design idea of this module.

**3. Period and phase are refined against the whole file at once.** Each proposal
is pinned down by scanning candidate periods within ±4% and scoring each with a
two-harmonic DFT of the envelope at that beat rate — the frequency-domain form of
sliding a comb of impulses over the track and asking how much energy it catches.
The second harmonic is included because it sharpens the peak and keeps the search
working on material whose offbeats are nearly as strong as its beats; it is safe
*here and nowhere else*, because the band is already pinned to one proposal and
no octave candidate is in reach to be confused by it. Phase comes separately,
from folding the envelope onto one beat and taking a weighted circular mean near
the fullest bin — a mean over the *whole* fold would land halfway between the
kick and the hat.

**Precision comes from the length of the track**, which is the entire reason this
path is the good one. An error of δ in the period displaces the last beat of an
N-beat track by N·δ, so the fit decoheres as soon as that reaches a fraction of a
beat. A whole track's worth of beats is a far longer lever than the eight seconds
the causal tracker has.

**The grid is rigid.** `BeatGrid` carries `bpm`, `period`, `offset`, a
materialised `beats[]` for look-ahead rendering, `confidence` and `duration`, and
`offset`/`period` are the source of truth — `BeatGridReader` works from those, so
`beats[k]` is exactly the instant the reader computes for beat `k`. No per-beat
snapping to local onsets: a track with a steady tempo gets a grid that is stable
by construction, which is what the phase's "done when" asks for. The cost is that
nothing here follows tempo drift; see the limitations below.

## Decision: the causal tracker votes on tempo and locks phase

`engine/beat-causal.ts`. It ingests one moment at a time — `process(now, onset,
strength)`, taking exactly what `Frame` already carries (`t`, `onset`,
`onsetStrength`) so wiring it in needs no new detector.

**Tempo comes from an inter-onset-interval histogram**, Dixon-style: every pair
of onsets within 2s of each other votes for the period it implies, *and* for that
period divided by 2..6, because a gap of two or three beats is evidence about the
beat too. Votes are weighted by both onsets' strengths, by recency, and down by
the divisor used, and are smeared with a Gaussian over ~2% of the period so two
performances of the same tempo two bins apart reinforce rather than split. This
was chosen over autocorrelating a live flux envelope because it needs only onset
*times* — a handful of numbers a frame instead of a rolling spectrogram — which
is the right cost for something running inside a game loop.

**Phase comes from a first-order lock.** The predicted beat is nudged 20% of the
way toward any onset that lands within a quarter-beat of it; onsets further away
are ignored rather than allowed to drag the prediction onto a syncopation. A
quarter beat is where an onset stops being better explained as a late beat and
starts being better explained as an offbeat, and locking onto those is exactly
how a tracker ends up confidently half a beat out.

There is no period term in the phase loop — the histogram is recomputed on every
onset and is the sole authority on tempo. That is a deliberate simplification: a
PLL period term would have fought the histogram for control with no clear owner,
and one fewer knob is worth more here than the precision it might have bought.

Three mechanisms exist purely to keep it honest, and each was added because
testing showed it was needed:

- **Slow adaptation with a patience counter.** A new estimate within 12% of the
  current tempo is blended in at 30%; one further away is *not* blended, because
  crossing a large gap gradually would spend several seconds reporting tempi
  nothing in the room is playing. It has to repeat three times before the old
  tempo is abandoned and the new one taken whole.
- **Phase re-anchoring after four consecutive misses.** Without it the tracker
  can lock itself out: a prediction far enough from the beat is never corrected,
  because every correction is gated on being close already. This was found by
  testing a tempo change — the tracker adapted its *tempo* correctly and then sat
  at 0.34 confidence forever because its *phase* could not recover.
- **Forgetting.** Five seconds with no onset and the estimate is dropped
  entirely, back to `bpm: null`. Coasting on a tempo nothing has confirmed is
  precisely the dishonesty `confidence` exists to prevent.

**`confidence` multiplies three things** — has it heard enough onsets, did the
histogram actually pick a tempo out of the noise, and are predicted beats landing
where onsets land — so being bad at any one of them is enough to say so. The last
is what catches the tracker being confidently half a beat out: the tempo can be
exactly right while the phase is not.

## Decision: 60–180 BPM, and a prior at 120

Both trackers default to the same range. It covers essentially all dance, pop and
rock at the level a listener taps their foot, and keeping the window just over an
octave means most half/double confusions fall *outside* it rather than having to
be argued about — a 128 BPM track's eighth notes at 256 are simply not
candidates. Both take the range as an option, and both respect it: the offline
one clamps its refinement band to it, so a narrowed range yields a tempo inside
that range or nothing.

Human tempo perception is not uniform over that range, so both weight candidates
by a log-normal prior centred at 120 BPM with a width of 0.9 octaves (the shape
Ellis's beat-tracking work uses). It is wide enough to only break genuine ties.
It is doing real work: a bare click track has no acoustic way of knowing it isn't
at half speed, and the prior is the only thing that settles it.

## What the synthetic tests establish

`engine/__tests__/synthetic-audio.ts` builds deterministic click tracks — seeded
PRNG throughout, because a flaky DSP test is worse than none — as decoded audio
satisfying a structural `DecodedAudio` (which a real `AudioBuffer` also
satisfies), following the precedent `fake-audio-context.ts` set for testing
Web-Audio-adjacent code with no Web Audio available.

Measured, on synthetic signal:

- **Offline recovers the tempo essentially exactly.** 70, 92, 128 and 174 BPM all
  come back within 0.01 BPM on a 20-second click track. On a *three-minute* track
  at 128 BPM it returns 128.002 with every beat inside 5ms of a click — the case
  that would expose a wrong period as accumulated drift. Analysis takes ~780ms
  for three minutes of 44.1 kHz audio.
- **Offline resolves kick-and-hat to the beat**, not to the eighths, the half, or
  the one-and-a-half that broke the comb-filter version.
- **Offline says nothing rather than something wrong**: `null` for silence, for
  unstructured noise, and for a track too short to argue about.
- **Causal is loose but honest.** It finds a steady tempo within 3 BPM across the
  range, taking 1.5–3s to lock; reports `bpm: null` for the first couple of
  beats and through twenty seconds of silence; ramps confidence from 0 to ~0.98
  over about eight seconds rather than starting high; predicts beats landing
  within 40ms of the real ones; adapts a 120→150 change within ~15s while still
  reading 120 two seconds after the change; forgets when the music stops and
  re-locks cleanly when it returns.
- **The precision claim is a test, not an assertion.** Both trackers are run on
  the same 128 BPM material and the offline error is asserted to be under 0.1 BPM,
  the causal under 3 BPM, and the offline error strictly smaller.

## Consequences and honest limitations

**Nothing here has heard real audio.** Every number above comes from synthetic
clicks. This is the same position ADR-0007 shipped in and the same one Phase 4
carried out as its open item; it is worth being specific about what that hides.

- **Real music is not a click track.** Sustained instruments, vocals and reverb
  put energy *between* the beats, which depresses recall and with it the offline
  `confidence`, whether or not the grid is right. The confidence divisors are
  reasoned, not measured, and are the first numbers to retune once the scope can
  show a grid over a real track. Expect a well-produced electronic track to look
  much like the synthetic tests and a live recording to look far worse.
- **Syncopation is where the octave logic is weakest.** Recall-versus-evenness
  resolves half and double cleanly. It is much less certain against a strongly
  syncopated pattern where the loudest onsets are deliberately *off* the beat —
  reggae, some funk — and the honest expectation is that both trackers will
  sometimes land half a beat out on that material, with the causal one doing so
  more often. `confidence` should reflect it (the phase-lock term is exactly what
  catches it) but will not prevent it.
- **The offline grid does not follow tempo drift, at all.** It is one rigid
  period fitted to the whole file. A click-track-driven production is fine; a
  human drummer speeding up through a song, or any rubato, will drift out of the
  grid progressively toward the end. The fit will still find the *average*, which
  is the worst kind of wrong — plausible everywhere and right nowhere. If this
  turns out to matter, the fix is a windowed fit with per-beat snapping, which
  was deliberately not built here because it trades away the stability the phase's
  "done when" asks for.
- **A systematic lateness of ~3ms** shows in the offline beat positions, from
  attributing a flux frame to the centre of its analysis window. It is well under
  perceptual threshold and was left uncorrected rather than tuned against
  synthetic clicks that may not predict real onsets; a later task with a real
  track in the scope can calibrate it out if it proves visible.
- **The microphone path has a whole layer of problems none of this touches.**
  Room reverb smears transients, which blunts every onset the causal tracker
  feeds on; a phone mic's AGC compresses exactly the dynamics that make a beat a
  beat; and ADR-0001's `RAW_AUDIO_CONSTRAINTS` disable the browser DSP that would
  otherwise fight us but cannot undo the room. The causal tracker's inputs come
  from `onset.ts`, whose own adaptive threshold was tuned for claps in a quiet
  room, not for music across one. **If mic-side beat tracking disappoints, the
  first thing to examine is the onset detector's sensitivity on music, not this
  module's tempo logic.**
- **Neither tracker knows where the bar is.** `beatIndex` counts beats, not bars.
  Any game wanting a downbeat needs either downbeat detection (not built) or to
  let the player tap it.
- **Offline analysis is a ~780ms synchronous block** for a three-minute track,
  and it scales with track length. That is acceptable for a one-time pre-play
  pass and is the reason the offline path can afford this much work at all, but
  whoever wires it in should show something on screen while it runs rather than
  freezing the page.

Structurally, this lands as four new engine modules (`beat.ts`, `beat-offline.ts`,
`beat-causal.ts`, `fft.ts`) and **touches nothing that exists** — `analyser.ts`,
`onset.ts`, `pitch.ts`, `source.ts` and `Frame` are all unchanged, matching the
precedent from ADR-0005 through ADR-0007 of keeping a new concern in its own
module. Wiring a `BeatReading` onto `Frame` and drawing it in the scope is a
separate piece of work, and the roadmap's Phase 6 "done when" — a stable grid for
a track played across a room, an exact one for the same track as a file — cannot
be checked until it lands.
