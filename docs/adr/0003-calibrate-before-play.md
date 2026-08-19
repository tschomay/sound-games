# Every game reads a calibration profile rather than raw audio thresholds

Microphone sensitivity, room noise floor and vocal range vary enormously across
devices and players — a hum that reads as −25 dB on a laptop reads as −45 dB on a
phone held at arm's length, and a fixed threshold tuned on one is unplayable on
the other. Device variance, not DSP quality, is the main thing that kills
microphone games.

So the engine owns a `CalibrationProfile` (noise floor, comfortable loudness
ceiling, low/high pitch bounds), measured once in a dedicated flow and persisted
to `localStorage`. Games consume **normalised** values — `level` in 0..1 against
the player's own dynamic range, pitch as a 0..1 position within the player's own
range — and never raw decibels or hertz. A player with a two-octave range and a
player with a five-note range both get a playable game.
