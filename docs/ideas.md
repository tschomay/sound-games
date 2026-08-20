# Game ideas

The running backlog for this repo. Nothing here is committed to — it's the pool we
pick from. Each idea lists the **detectors** it needs from `src/engine`, so we can
see which ideas unlock once a given detector lands.

Status legend: `planned` · `building` · `built` · `parked`

## Detectors these depend on

| Detector | What it gives | Latency | Reliability |
| --- | --- | --- | --- |
| `level` | RMS envelope, normalised against the calibrated noise floor | ~0 | Excellent |
| `pitch` | Fundamental frequency (autocorrelation / NSDF) | ~30–45 ms | Excellent for hum (80–400 Hz) and whistle (800–2500 Hz) |
| `onset` | Broadband transient (spectral flux + adaptive threshold) | ~10–20 ms | Excellent for claps |
| `bands` | Bass / low-mid / mid / high energy | ~0 | Good |
| `timbre` | Spectral centroid + flatness (vowel shape, tone vs noise) | ~0 | Crude but "ee" vs "oo" separates cleanly |
| `beat` | Beat grid / BPM | see ADR-0001 | Good from file, noisy from live mic |

---

# Category A — you make the sound

The player is the controller. Voice input is laggy, continuous and imprecise
compared to a button, so every design here is chosen so that **imprecision is
charming rather than fatal**: sustained control, gestures, thresholds, rhythm —
never twitch precision.

## A1. Hum Flyer — `built`

Pitch maps to the avatar's vertical position; fly through gaps in scrolling
terrain. The canonical voice game, and the right one to build first because it
validates the whole pitch pipeline in a form you can feel within 30 seconds.

The twist that stops it being a clone: the gaps trace an actual melody, so
playing well means singing a real tune.

- **Detectors:** `pitch`, `level`
- **Platform:** mobile-first — one continuous vocal axis, no touch needed
- **Risk:** low. Settled on an exponential chase at 9/s — enough to swallow the
  few cents of frame-to-frame jitter without feeling like the flyer is on
  elastic.

## A2. Clap Runner — `planned`

Auto-runner. Clap = jump, sustained "aaah" = glide, shout = ground-pound.

The interesting problem is cleanly separating a *transient* from a *sustained
tone* (zero-crossing rate + spectral flatness), which buys two independent verbs
from one microphone.

- **Detectors:** `onset`, `level`, `timbre`
- **Platform:** mobile-first
- **Risk:** medium — the transient/sustain classifier needs real tuning, and game
  SFX through a phone speaker will re-trigger the onset detector.

## A3. Quiet Game — `built`

Inverted mechanic: stay **below** a volume threshold to sneak past guards, and
shout deliberately to shatter glass or throw a distraction.

Technically the cheapest thing on this list — just `level` — and mechanically the
funniest, because it makes the player self-conscious about the actual room
they're sitting in.

- **Detectors:** `level`
- **Platform:** mobile-first
- **Risk:** very low. Good candidate for the second build.

## A4. Sonar Maze — `planned`

Dark screen. You clap; a wavefront propagates outward and illuminates whatever
geometry it touches. Louder clap, bigger radius. You map the maze by making noise
— but noise attracts the thing hunting you.

That see-more ↔ get-eaten tension is a real game loop rather than a tech demo,
and it's the best-looking idea in the set.

- **Detectors:** `onset`, `level`
- **Platform:** mobile-first
- **Risk:** low-medium. Rendering the wavefront cheaply on a phone GPU needs care.

## A5. Vowel Steering — `planned`

Pitch is the vertical axis, vowel shape ("ee" → "oo") is the horizontal one. Two
analog axes from a single continuous voice.

The most original idea here and the one that would feel like magic if it lands.

- **Detectors:** `pitch`, `timbre`
- **Platform:** mobile-first
- **Risk:** high — formant tracking via spectral centroid is crude, and the
  centroid moves with pitch, so the two axes will bleed into each other. Needs a
  spike before it gets committed to.

## A6. Voice Line Rider — `planned`

Hum for a few seconds; your pitch contour is captured as a terrain line; a marble
rolls down what you sang. Puzzle framing: get the marble to the goal.

Nice because the input is *recorded then replayed*, so latency stops mattering
entirely.

- **Detectors:** `pitch`
- **Platform:** mobile-first
- **Risk:** low

---

# Category B — music drives the world

The player supplies music and the world reacts. See **ADR-0001** — we support
both a live microphone and a loaded audio file, and the two give genuinely
different capabilities, so some games will be mic-only, some file-only, and some
will support both with degraded features on mic.

## B1. Rhythm-Gated Combat — `planned`

You can only attack on the beat of whatever's playing; enemies also move on beat.

The strongest concept in this category, because the music changes **your verbs**
rather than just the visuals — most "reactive" games only recolour the
background.

- **Detectors:** `beat`, `bands`
- **Input:** both. Live mic works (beats are causal); file adds a look-ahead
  telegraph so you can see the beat coming.
- **Platform:** mobile-first — tap-on-beat is a natural touch verb
- **Risk:** medium — playability depends entirely on beat-tracking accuracy.

## B2. Reactive Runner / Tower Defense — `planned`

Wave structure derived from song structure; the drop is a boss wave.

- **Detectors:** `beat`, `bands`, song sections
- **Input:** **file only.** Knowing a boss arrives at the drop requires seeing the
  whole track in advance, which live mic fundamentally cannot do.
- **Platform:** desktop-friendly, mobile-playable
- **Risk:** medium — section detection is the hard part.

## B3. Ecosystem Garden — `planned`

Bass drives growth, mids spawn creatures, highs are weather. Loud passages spawn
predators. Playlist-length sessions while you tend the thing.

Closest to a screensaver of anything here, so it needs a genuine management loop
to stay a game.

- **Detectors:** `bands`, `level`
- **Input:** both — works fine with no beat tracking at all, which makes it the
  most robust live-mic game on the list.
- **Platform:** mobile-first
- **Risk:** low technically, medium as a *design* (may just not be fun).

---

# Known hazards

Recorded once here so no game has to rediscover them.

1. **Mic needs HTTPS and a user gesture.** `AudioContext` starts suspended and
   must be resumed from a real tap.
2. **Game SFX re-enter the microphone.** Anything the game plays through a phone
   speaker will be heard by its own onset/level detectors. Either duck game audio,
   gate detection while SFX play, or require headphones.
3. **Browser DSP fights us.** `echoCancellation`, `noiseSuppression` and
   `autoGainControl` must all be disabled in `getUserMedia`, or the browser will
   actively cancel the music we're trying to listen to and normalise away the
   dynamics we're trying to read.
4. **Device variance is the #1 killer.** Hence calibration before any game.
5. **iOS Safari** has its own `AudioContext` resume quirks and will not deliver
   mic audio while the page is backgrounded.
