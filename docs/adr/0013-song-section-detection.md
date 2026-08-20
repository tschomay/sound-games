# Song section detection: beat-synchronous bands, a Foote novelty curve, and a veto

Phase 8 ships two games, and the roadmap is explicit about which half is hard:
*"B2 also needs song **section** detection on top of the beat grid, which is why
it comes last"*, and, in `docs/ideas.md`, *"Risk: medium — section detection is
the hard part."* B2's own one-line brief is what the detector has to serve:
**"Wave structure derived from song structure; the drop is a boss wave."**

This ADR records the detector that was built (`engine/sections.ts`), the several
things that were tried and thrown away on the way to it, and — following
ADR-0010's precedent — an honest account of the real music it is expected to be
wrong about. **No part of this has met a real song.**

The game is not built. This is a standalone engine capability, wired to nothing.

## Decision: `analyseSongStructure(audio, options?) → SongStructure`

One entry point, whole decoded file in, structure out. It is offline and
non-causal by nature — knowing the middle of a track was quiet requires having
heard the end of it — which is the same reason ADR-0001's file/mic split makes B2
file-only.

```ts
interface SongStructure {
  sections: Section[];        // contiguous, in order, tiling [0, duration]
  dropIndex: number | null;   // the climax, or null when nothing stands out
  duration: number;
  beatSynchronous: boolean;   // sampled per beat, or on a fixed time grid
  grid: BeatGrid | null;      // the grid used, so nobody analyses twice
  confidence: number;         // 0..1
  novelty: NoveltyCurve;      // the curve boundaries were picked from
}

interface Section {
  index: number;
  startSeconds: number; endSeconds: number; durationSeconds: number;
  intensity: number;          // 0..1 within this track: 1 is the drop, 0 the quietest
  loudnessDb: number;         // the absolute bass-weighted loudness behind it
  boundaryStrength: number;   // 0..1, how emphatic the change that opened it was
  isDrop: boolean;
  startBeat: number | null;   // index into BeatGrid.beats
  beatCount: number | null;
}
```

Four things about that shape are decisions rather than convenience.

**It never returns `null` and never throws.** A track with no findable structure
comes back as *one* section spanning the whole file, not as nothing. `BeatGrid`
can return `null` because a game can meaningfully do without a beat; a game
building waves out of sections cannot meaningfully do without sections, and
"the whole song is one section" is both true and usable. Only a zero-length
buffer produces an empty list.

**`dropIndex` can be `null`, and that is not the same as "section 0".** A track
whose loudest section leads its own median section by less than 2 dB has no
drop — a lo-fi loop, an ambient piece, a mastered-flat wall of sound. Inventing
one would be exactly the dishonesty `BeatGrid.confidence` exists to prevent on
the tempo side. A game that needs a boss wave regardless should choose its own
fallback deliberately (the last section, or the loudest whatever the margin)
rather than have the choice hidden in here.

**`intensity` is relative to the track, not absolute.** 1 is that track's most
intense section and 0 its least. Absolute loudness does not survive mastering —
one record's verse is louder than another's chorus — and "how big is this bit
compared to the rest of this song" is the question a difficulty curve is asking.
`loudnessDb` carries the absolute number for anyone who wants it.

**`grid` is returned, not just consumed.** B2 needs both the beat grid and the
sections; handing back the grid the sampling used means the file is analysed
once. A grid can also be passed *in*, so a caller that already has one pays for
neither.

## Decision: beat-synchronous features, with a fixed-grid fallback

The feature is **eight octave-spaced band energies in dB** — 30, 60, 120, 240,
480, 960, 1920, 3840, 7680 Hz — averaged over each beat of the track's
`BeatGrid`, which is roughly one vector per half-second rather than the onset
envelope's one per 10ms. This is the standard approach and it is standard for
good reasons: structure changes happen on musical boundaries rather than at
arbitrary time offsets, so sampling on the beat both aligns the analysis with
what is being looked for and makes the self-similarity matrix a hundred times
smaller. A useful side effect falls straight out of it: **every detected boundary
lands exactly on a beat instant**, which is what a game wanting to spawn a wave
on a downbeat actually needs.

Eight bands rather than `Analyser.bands()`'s four (`engine/analyser.ts`, which
this deliberately does not call — it is built around a live `AnalyserNode` and a
streaming spectrum, not a whole-buffer pass) because this feature has to
*discriminate*, not describe: a verse and a chorus can share a level and differ
entirely in where their energy sits. Octave spacing because that is how the
spectrum's information is actually distributed. The STFT window is 2048 points at
the 22.05 kHz analysis rate — four times `beat-offline.ts`'s, for the opposite
reason: nothing here needs to place an event in time (the sampling grid does
that), while the 30 Hz bottom band needs frequency resolution the beat tracker's
23ms window cannot give.

**The beat grid is used whenever there is one, regardless of its confidence.**
That is deliberate and worth stating, because it looks careless. Structural
analysis is far less sensitive to the tempo being exactly right than a rhythm
game is: a grid locked at half or double the true tempo still slices the track on
musical time, which is all this needs. A somewhat-wrong musical clock is a better
sampling grid than an arbitrary one.

**When `analyseBeatGrid` returns `null` — ambient, spoken word, drone — features
are sampled on a fixed half-second grid instead.** Requiring a beat grid was the
alternative and would have been defensible (B2 needs one anyway), but it would
have made "this track has no beat" and "this track has no structure" the same
answer, and they are not. The fallback costs about fifteen lines. Its boundaries
are correspondingly less useful — they land on a half-second ruler, not on beats,
and `startBeat`/`beatCount` are `null` — and `beatSynchronous` says which mode
produced the result so a caller can tell.

## Decision: a self-similarity matrix and a Foote novelty curve

The core is Foote (2000), *Automatic Audio Segmentation Using a Measure of Audio
Novelty*, and the idea is simple enough to implement from the description. Build
a similarity matrix over the feature frames; slide a **checkerboard kernel** along
its diagonal. The kernel's two on-diagonal quadrants are positive (each side of a
boundary should look like itself) and its two off-diagonal quadrants negative (the
two sides should not look like each other). It sums to zero, so a homogeneous
stretch — where every similarity in reach is much the same — returns *exactly*
nothing, which is why no detrending step is needed anywhere. Straddling a real
boundary it returns a large positive number.

Three implementation choices inside that:

- **The kernel is sized in seconds, not beats** — 6 seconds either side, so it
  compares the preceding six with the following six. Sizing it in beats would
  silently double the timescale between a 60 BPM track and a 120 BPM one. Six
  seconds is long enough to average over a bar or two and short enough to place a
  boundary within a beat or so.
- **A Gaussian taper** (σ = L/2) weights the frames nearest the split most, which
  sharpens the peak instead of leaving a plateau L frames wide.
- **Only the diagonal band of the matrix is computed.** The full N×N picture is
  the textbook one and is genuinely useful for *repetition* detection — spotting
  that bar 65 sounds like bar 1, and therefore that both are choruses — but
  novelty never reads more than 2L off the diagonal, and a ten-minute track's full
  matrix is millions of cells filled so that thousandths can be read. **Repetition
  detection is not built here**, so sections carry no labels: this module can say
  *where* the music changed but never that two sections are the same section
  returning. See the limitations.

### The similarity measure took three attempts, and this is the interesting part

The literature-standard measure is cosine similarity between standardised feature
vectors. It was implemented first, and it **fails backwards on the most important
edge case**: standardising puts the frames of a homogeneous stretch near the
origin, and normalising those to unit length turns the tiny numerical differences
between them into unit vectors pointing in arbitrary directions. A track with
nothing happening in it comes back looking maximally eventful — precisely the
input the detector most needs to be quiet about.

Euclidean distance between standardised vectors fixes that (two unremarkable
frames are correctly *very* similar) but inherits a worse problem from the
standardisation itself. **A track containing one enormous drop has its per-band
scale set almost entirely by that drop**, which shrinks every other change in the
track to a rounding error. Measured, on the synthetic four-part build-and-drop
track: a real boundary scoring **0.045** while the drop scored **1.0**. Switching
the standardisation to median-and-MAD to make it robust fixed *that* case and
introduced a new pathology — on a track that is mostly uniform the MAD is
near-zero, so novelty values ran to five figures and every threshold expressed as
a fraction stopped meaning anything.

The measure that shipped **abandons per-track normalisation entirely**:

```
similarity(a, b) = max(-1, 1 − meanOverBands((dBₐ − dB_b)²) / REFERENCE_CHANGE_DB²)
```

with `REFERENCE_CHANGE_DB = 9`. Decibels are already a perceptually sensible
common scale, across bands and across tracks, so nothing needs normalising and
none of the above arises. Two frames differing by 9 dB in every band score zero;
identical frames score 1. **The clamp at -1 is load-bearing**: without it the drop
dominates the peak-picking statistics and the confidence for no gain, since a 40
dB change is not twice as much a section boundary as a 20 dB one. Saturating it
is what leaves room for the quieter boundaries in the same track to be seen.

Two supporting details: band powers are *summed* over their bins rather than
averaged (a per-bin mean would make a tone read quieter for landing in a wide
band, and would put octave-spaced bands on eight different scales), and every band
is floored at 60 dB below the track's loudest band reading, so a track with
nothing above 4 kHz does not have its structure decided by the dither in its top
two bands.

## Decision: peak-picking, then a veto

Peaks are picked with a **robust** significance test — five median-absolute-
deviations above the curve's own median, not five standard deviations above its
mean, because the peaks being looked for are themselves large enough to inflate a
standard deviation and so raise the bar meant to catch them. A track with four
clean boundaries would otherwise be *harder* to find boundaries in than a track
with one. An absolute floor (0.05, a twentieth of a perfect boundary's response)
guards the opposite case, where a very flat curve has a tiny MAD and a meaningless
excursion clears five of them. Selection is greedy, largest-first, with a minimum
spacing of 8 seconds, which enforces the minimum section length and resolves
close pairs in favour of the stronger — the weaker of two adjacent peaks is
usually the stronger one's own shoulder.

**Then every surviving peak has to justify itself, and this is the piece not in
Foote.** Novelty is a *local* measure: it peaks wherever the next few seconds are
unlike the last few, which a single loud drum fill, a one-bar breakdown or a
dropout satisfies perfectly well without any section having begun. This was not
hypothetical — a **one-second** loud fill dropped into the middle of an otherwise
unchanging synthetic track produced a confident boundary, and the novelty it
scored (0.113) was *higher* than a genuine but modest section change elsewhere
(0.08). No threshold on the novelty curve alone can separate those.

So each candidate is checked over the timescale a section is claimed to last: the
**median** spectrum over the 8 seconds before the boundary must differ from the
median spectrum over the 8 seconds after it by at least **2.5 dB RMS** across the
eight bands. A median rather than a mean because the entire point is to be
unmoved by a brief extreme event — a one-second fill is two frames out of sixteen,
which cannot shift a median but can pull a mean several dB on its own. Measured on
the synthetic cases: a one-second fill leaves **1.3 dB** behind it, and the least
emphatic genuine boundary among them changes the spectrum by **3.2 dB**.

It is deliberately a **veto and not a score** — it can only remove boundaries the
novelty curve proposed, never add one — so the algorithm remains "Foote, plus a
sanity check", not a bespoke scheme.

## Decision: the drop is the loudest, bassiest section

Per feature frame, intensity is `0.6 × broadband dB + 0.4 × (30–240 Hz) dB`: a
drop is characterised as much by what arrives underneath as by how loud it is,
but loudness is still the larger half. A section's loudness is the mean of its
frames' dB values rather than the dB of their mean power — the two differ on
material with wide internal dynamics, and the per-frame mean is the one that
matches what the section sounds like, since averaging power first lets four bars
of loud stabs decide the loudness of a section that is otherwise near silence.

The loudest section is the drop, provided it leads the track's median section by
at least 2 dB. That is a low bar on purpose: it exists to catch tracks with no
dynamic shape at all, not to adjudicate between two big choruses.

## What the synthetic tests establish — and what they cannot

`engine/__tests__/synthetic-audio.ts` gains `structuredTrack`, which concatenates
segments of known length, each internally stationary (fixed tones, bass and hiss)
and clearly unlike its neighbours, optionally with a click track laid over the
whole thing so a beat grid exists. Boundaries are known exactly. Everything is
seeded, following the same rule the beat tests set: a flaky DSP test is worse than
none.

Measured, on 17 tests:

- **Boundaries land within a second of the truth** on four- and five-part tracks,
  across 70/92/120/174 BPM, three seeds, and 22.05/44.1/48 kHz — worst observed
  error 0.71s, and the same three boundaries found in every one of those runs. The
  1-second tolerance is about two feature frames: a boundary is snapped to a frame
  (one beat, up to a second at the bottom of the tempo range) and the frames are
  smoothed over their neighbours before the kernel sees them.
- **Boundaries land bit-for-bit on beat instants** when a grid was used, and
  `startBeat`/`beatCount` agree with them.
- **The drop is identified correctly**, including the classic shape — thirty
  seconds of quiet build, twenty of loud bass-heavy climax, a short outro — where
  all three boundaries and the climax are found.
- **Material with no structure yields one section**: uniform noise, an unchanging
  tone, and silence all come back as a single section with `confidence: 0` and
  `dropIndex: null`.
- **A one- or two-second loud fill inside unchanging music yields no boundary.**
- **`dropIndex` is `null`** for three sections that differ in timbre but not in
  intensity.
- **Degenerate input degrades rather than throws**: 8s, 1s, 0.05s and zero-length
  buffers all return something sane.
- Analysis is **~700ms for a four-minute track** when handed an existing beat
  grid, ~1.7s including the beat analysis itself.

**What none of that establishes is accuracy on real music, and the gap is wider
here than it was for beat tracking.** A `structuredTrack` segment is stationary
from its first sample to its last and its joins are instantaneous. Real sections
breathe; real boundaries are crossfaded, or anticipated by a fill, or arrive a bar
early in one instrument and a bar late in another; and a real verse and chorus
differ by far less than any two segments in these tests. A click track is at least
a caricature of a real drum pattern. These segments are a caricature of nothing —
they are a test that the *algorithm* does what it says, not that the thing it says
is the right thing to look for.

## Consequences and honest limitations

Ordered roughly by how likely each is to be the first thing that goes wrong.

- **Ambient, drone and beatless material will produce boundaries that mean
  nothing, or none at all.** These tracks have no clock to sample on (so the
  fallback grid is used) and often no abrupt change anywhere; the novelty curve is
  flat and either nothing clears the threshold — one section for a twelve-minute
  piece — or the strongest wobble does and gets called structure. The absolute
  floor and the veto are what prevent the second case, and both are set by
  reasoning, not measurement.
- **Gradual transitions are invisible.** A four-bar filter sweep into a chorus
  spreads the change over the kernel's own width, and a checkerboard kernel is
  precisely a detector for *abrupt* change. Expect well-produced electronic music
  with hard cuts to work far better than anything with a build, and expect the
  boundary that is found to sit at the *end* of a build rather than at its start.
- **Continuous variation defeats it in the other direction.** A live recording, a
  jam, anything with no two bars alike raises the novelty curve's noise floor
  everywhere; the robust threshold scales with that, so the likely failure is
  silence — few or no boundaries — rather than noise. That is the better failure,
  but it is still a failure.
- **The veto will reject real boundaries between similar-sounding sections.**
  2.5 dB RMS over eight bands is a small change, but a chorus that differs from
  its verse only in the vocal line, or a second verse that adds one instrument,
  can fall under it. This is the explicit trade made to kill drum-fill false
  positives, and it is the first number to retune against real music.
- **No labels, no repetition.** Sections are numbered, not named. Nothing here
  knows that section 1 and section 3 are the same chorus, because the off-diagonal
  matrix that would show it is never computed. Any game wanting "the second
  chorus" cannot have it, and any game wanting "the same wave whenever the chorus
  returns" would need repetition detection built on top — the banded similarity
  would have to become the full matrix first.
- **Nothing knows where the bar is.** Inherited straight from ADR-0010: boundaries
  land on *beats*, and a beat is not a downbeat. A boundary can therefore be
  anywhere within a bar of where a musician would put it, and a game placing a
  boss wave at `startBeat` may place it three beats into a bar.
- **The intensity measure is loudness, not energy in the musical sense.** A
  double-time drum-and-bass section that is no louder than the verse before it
  will not read as more intense, and a section that is intense because it is
  *fast* is invisible to a measure built from band energies. `bands`-style
  loudness was chosen because it is what the roadmap's "the drop is a boss wave"
  actually means for the tracks B2 is aimed at; it is not a general theory of
  musical intensity.
- **Heavily limited masters compress the very dynamics this reads.** Modern
  mastering can leave a chorus 1 dB louder than a verse in broadband terms, which
  is why the intensity measure is bass-weighted at all and why `dropIndex` is
  allowed to be `null`. On some records there genuinely is no measurable drop.
- **`confidence` is reasoned, not measured.** Its divisor (novelty 0.4 = fully
  believed) was chosen by looking at synthetic numbers, and real music will sit
  well below a synthetic segment boundary. Like ADR-0010's confidence divisors, it
  is a first-guess calibration awaiting a real track.
- **Analysis is another ~700ms synchronous block on top of beat tracking's.** For
  a four-minute file that is ~1.7s of frozen page if both are run cold. Acceptable
  for a one-time pre-play pass — and B2 is file-only, so there is a natural loading
  moment — but whoever wires it in must show something on screen, and should pass
  the grid in rather than let it be computed twice.
- **The whole module is untested above four minutes.** Longer files eventually
  trip the feature-frame cap and start grouping beats, which coarsens boundary
  placement; nothing has been run through it at DJ-set length.

Structurally this adds one engine module (`engine/sections.ts`) and touches
exactly one existing line elsewhere: `downmixAndDecimate` in `beat-offline.ts`
becomes exported, since both modules need the same mono decimation and a second
copy would be worse. No game code exists for it yet, and `Frame` is unchanged —
this is a pre-play analysis result, not a per-frame detector, so it has no
business on `Frame`. Wiring it into B2 is a separate piece of work, and the
roadmap's Phase 8 "done when" cannot be checked until that lands.
