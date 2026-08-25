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

## A2. Clap Runner — `built`

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

## A4. Sonar Maze — `built`

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

  The spike is built and live: `games/vowel-steering-spike/` (see ADR-0008 and
  the roadmap's Phase 5 entry). Status stays `planned` here on purpose — the
  spike answers "does this work" only with a human actually humming into a
  real microphone on a real device, which is a call this codebase can't make
  on its own. Once that playtest happens, this entry moves to `built`
  (scheduled as a real game) or `parked` (the bleed is too strong) — not
  before.

## A6. Voice Line Rider — `built`

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

## B1. Rhythm-Gated Combat — `built`

You can only attack on the beat of whatever's playing; enemies also move on beat.

The strongest concept in this category, because the music changes **your verbs**
rather than just the visuals — most "reactive" games only recolour the
background.

- **Detectors:** `beat`, `bands`
- **Input:** both. Live mic works (beats are causal); file adds a look-ahead
  telegraph so you can see the beat coming.
- **Platform:** mobile-first — tap-on-beat is a natural touch verb
- **Risk:** medium — playability depends entirely on beat-tracking accuracy.

## B2. Reactive Runner / Tower Defense — `built`

Wave structure derived from song structure; the drop is a boss wave.

- **Detectors:** `beat`, `bands`, song sections
- **Input:** **file only.** Knowing a boss arrives at the drop requires seeing the
  whole track in advance, which live mic fundamentally cannot do.
- **Platform:** desktop-friendly, mobile-playable
- **Risk:** medium — section detection is the hard part.

## B3. Ecosystem Garden — `built`

Bass drives growth, mids spawn creatures, highs are weather. Loud passages spawn
predators. Playlist-length sessions while you tend the thing.

Closest to a screensaver of anything here, so it needs a genuine management loop
to stay a game.

- **Detectors:** `bands`, `level`
- **Input:** both — works fine with no beat tracking at all, which makes it the
  most robust live-mic game on the list.
- **Platform:** mobile-first
- **Risk:** low technically, medium as a *design* (may just not be fun).

## B4. Overtone — `built`

An endless-runner where the terrain itself is drawn by the song's brightness
(`centroid`): bright, cutting sound raises the ground into jagged peaks, dark,
warm sound flattens it into valleys. Bass hits launch rock obstacles onto the
terrain ahead; the only verb is a tap to jump them, no sound required from the
player at all. It's the instrumental mirror of Hum Flyer (A1) — there your
pitch draws where you fly, here the song's brightness draws the ground you
ride. Not a duplicate of Ecosystem Garden despite both reading `bands`: this
is the only Category B game to use `centroid` at all, reads it every frame to
reshape *geometry* rather than to drive a slow multi-minute management meter,
and turns `bands.bass` into a fast, hard-fail spawn trigger instead of a
growth accumulator.

- **Detectors:** `centroid`, `bands.bass`, `level` — the only Category B game
  not built on `beat`.
- **Input:** both, plus a tap to jump. Nothing here needs a file's whole-track
  look-ahead the way Drop Siege does.
- **Platform:** mobile-first — one tap is the entire touch surface.
- **Risk:** low-medium — there's no calibration step for a full mix's
  brightness range (same open question A5/vowel-steering-spike already
  carries for a single voice), so the default Hz range is a reasoned guess,
  not a measurement.

## B5. Trackgen — `built`

Drop in a track, get a level generated from it: song structure
(`analyseSongStructure`, ADR-0013) becomes the level's chapters, one biome per
section, coloured by that chapter's own mean spectral brightness; onset peaks
picked from the whole-track onset envelope (`computeOnsetEnvelope`) become
placed collectibles; the drop (`SongStructure.dropIndex`) gets the densest,
brightest chapter. This is the "big" idea in name only, technically — the
self-similarity work it needs already exists and already backs Drop Siege, so
nothing here is new DSP, just a new *consumer* of it, plus one small offline
pass (a per-section mean spectral centroid, built from the same `Fft`/
`hannWindow` helpers `sections.ts` already uses, kept local to this game
rather than added to the engine).

The level is generated once, entirely offline, before the round starts, and
then played back in lock-step with the file's own position — same principle
as Drop Siege's timeline, extended from "wave timing" to "the whole world".
**v1 scope is deliberately narrower than the full pitch:** no separate hazard
system and no fail state — the "energy → speed" element is a cosmetic
parallax/pacing multiplier layered on top of a world position that is always
literally `source.position()`, not an independently accumulated distance,
so a collectible authored at a given second of the track can never drift out
of sync with the sound that placed it there. The game is entirely about
timing jumps to grab collectibles as your own chapter of the song scrolls by;
a round ends, win or lose, when the track ends. Score is collectibles grabbed
out of the total the song produced — literally different every time someone
brings a different song, which is the whole point.

- **Detectors:** none live — everything is the offline `sections`/onset-
  envelope analysis, read once before playback.
- **Input:** **file only.** The whole point requires seeing the whole track
  before playback starts, same reasoning as Drop Siege.
- **Platform:** mobile-first — a tap is the only input, timed against
  collectibles scrolling by in sync with playback.
- **Risk:** medium — not the DSP (already built), but whether procedurally
  placed collectibles reliably read as fair and fun across wildly different
  songs, which is a design risk no amount of unit testing settles on its own.

## B6. Rhythm Siege — `built`

Lane-based tower defense, purely reactive to whatever's live: a bass-heavy
onset spawns a slow, tough Heavy in a lane; a high-band onset spawns a fast,
fragile Swarm; the live causal beat tracker's tempo (`Frame.beat.bpm`) sets
how fast everything already spawned marches toward you. Tap a lane to strike
whatever's nearest in it. No look-ahead, no whole-track analysis — put a
different track on mid-round and the enemy mix and march speed both change on
the spot, live.

Not a duplicate of either existing beat-driven game despite the family
resemblance: Rhythm-Gated Combat gates *when* your one verb lands (only on
the beat); Drop Siege paces *wave structure* from a whole track's authored
shape, file-only. Rhythm Siege gates neither — the tap always lands — and
instead lets a live per-hit drum classification decide *what* spawns, and a
live (possibly unlocked, possibly zero-confidence) tempo estimate decide how
fast it all closes in, degrading to a fixed default march speed rather than
stalling when no tempo can be found, the same "an unlocked signal still
produces a playable game" posture Ecosystem Garden already takes toward
`bands` with no beat tracking at all.

- **Detectors:** `onset`, `bands` (to classify a spawn as bass- or
  high-dominant), `beat` (tempo only — `bpm`, not phase or `onBeat`).
- **Input:** both, and genuinely no worse on mic — this is the live-mic
  showcase of the beat-driven half of the category, the counterpart to Drop
  Siege being the file-only one.
- **Platform:** mobile-first — tap a lane.
- **Risk:** medium — live drum classification off `bands` at the onset
  instant is cruder than a real kick/snare classifier; expect some
  misclassified spawns on busy, cymbal-heavy mixes.

## B7. Conductor Boss — `built`

A single boss arena where the boss's attacks *are* the song, live: a bass hit
telegraphs and then executes a ground slam (dodge by switching lane), a
higher-band onset telegraphs and executes a projectile aimed at your current
lane (dodge by switching *away* from it). The telegraph window is short — long
enough to be a real reaction window, short enough that the telegraph and the
sound stay tied together — because the pitch's whole premise is that hearing
the music *is* the tell, not a UI countdown. A successful dodge counters for
boss damage; a failed one costs player health. Round ends in victory (boss
health empties) or defeat (yours does).

- **Detectors:** `onset`, `bands` (bass vs. higher-band classifies which
  attack fires) — the same classification shape as Rhythm Siege, aimed at one
  scripted opponent instead of a wave of independent enemies.
- **Input:** either — mic or file, degrading no differently either way, since
  every attack is decided live off whatever's actually sounding right now.
- **Platform:** mobile-first — a lane-switch tap is the entire verb.
- **Risk:** medium — the telegraph window has to be tuned tight enough to
  feel like *the music* is attacking you and not a delayed UI cue, which is a
  feel judgement no test suite settles.

## B8. Quiet Passage — `built`

Puzzle-platformer: the player's vertical position is not jumped, it is *set*
by the track's own loudness at the current instant — loud pins you down
against a floor of hazards, quiet lifts you toward gaps in a hazard ceiling
above. Those gaps are placed, during the same offline pass, only where the
track is actually quiet for long enough to survive one — so the level is
never unfair, but it is only ever crossable by ear. A second, smaller
constraint ties the theme all the way through the mechanic rather than just
the vertical axis: lateral lane-switching (needed because a given gap isn't
always in the lane you're already in) only responds while the track is quiet
enough to hear yourself think — so lining up for a gap has to happen *during*
the quiet passage that reveals it, not before.

- **Detectors:** none live for gravity or gap placement — both come from one
  offline loudness-over-time pass (a plain windowed RMS envelope, not a full
  spectral analysis — much cheaper than Trackgen's or Drop Siege's passes).
  `level`/`bands` play no role; this is the one Category B game built on
  loudness alone, offline.
- **Input:** **file only.** Fairness requires the whole loudness curve before
  the round starts, same reasoning as Drop Siege and Trackgen.
- **Platform:** mobile-first — lane-switch taps, gated by quietness.
- **Risk:** medium — an entirely passive vertical axis is a real design bet;
  if lane-switching alone doesn't carry enough agency to feel like a puzzle
  rather than a slideshow, that's a fun risk no amount of correct RMS math
  fixes.

## Bridge idea — karaoke-battler (stretch, documented only)

Offline melody extraction from a loaded track (the track's own sung/played
melody line, pulled out the way `sections.ts` pulls out structure) paired
with live pitch scoring against it while the player sings along — the one
idea on this list that needs *both* halves of the engine at once, category A's
live pitch pipeline and category B's whole-file offline analysis, in the same
round. Genuinely interesting because it's where the two families the menu now
splits games into actually meet, rather than a game that happens to use two
detectors.

Deliberately **not** on the build list yet. Extracting a clean, singable
melody line from a full mix (as opposed to the coarse octave-band structure
`sections.ts` needs, or the drum-band onsets B5–B7 need) is a much harder,
much less forgiving DSP problem than anything else in this backlog — getting
it wrong doesn't just make a chapter boundary land a beat late, it makes the
whole game unplayable, since the player is being scored against a target line
that has to actually be the tune. Recorded here so the idea isn't lost, not
because it's next.

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
