# Calibration is two halves, and the voice half is optional

Calibration originally ran as one four-step flow ending in a save, so everyone
had to hum their lowest and highest note before playing anything. But the pitch
range is only used by voice-controlled games (category A). A player who only
wants the music-driven games (category B) was being charged a hum test for
measurements nothing they played would ever read.

So a `CalibrationProfile` now carries the room measurements — noise floor and
comfortable loudness, which every game needs — plus a `pitchRange` that may be
`null`. The room half is **saved as soon as it is measured**, before the player
is asked about the voice half, so abandoning the flow at that point still leaves
the room calibrated rather than throwing the work away. Games declare what they
require (`room` or `pitchRange`) and the menu locks and labels them accordingly,
so a locked game can say *why* it is locked.

## Consequences

- Profiles are versioned and migrated: version 1 always had a range stored
  inline, and those are perfectly good measurements, so they are lifted into the
  new shape rather than forcing anyone to calibrate again.
- `normalisePitch` takes a `PitchRange` rather than a whole profile, since a
  profile may not have one.
- The analyser still reports `pitchNorm` for uncalibrated players, against a
  default range. Games that genuinely depend on pitch gate on the profile
  instead of trusting that value.
