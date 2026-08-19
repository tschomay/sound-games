# Context

Browser games that react to input audio, in two families: **you make the sound**
(voice as controller) and **music drives the world**. See `docs/ideas.md` for the
backlog and `docs/adr/` for decisions.

## Glossary

- **Audio source** — where samples come from: the live **mic**, or a loaded
  **file**. One interface, two implementations (ADR-0001). Games declare which
  sources they support.
- **Detector** — one analysis unit turning samples into a game-usable signal:
  `level`, `pitch`, `onset`, `bands`, `timbre`, `beat`.
- **Frame** — the full set of detector outputs for a single moment, produced once
  per animation frame and passed to the game. The unit of communication between
  the engine and a game.
- **Level** — *loudness*, normalised 0..1 against the player's calibration
  profile. Never means "a stage of a game" in this codebase; a stage is a
  **round**.
- **Onset** — a detected broadband transient (a clap, a hit). Distinct from
  **beat**, which is a *predicted* position in an ongoing rhythmic grid.
- **Voiced** — the player is producing a sustained tone with a findable
  fundamental, as opposed to noise or silence.
- **Calibration profile** — a player's measured noise floor, loudness ceiling and
  pitch range, persisted locally, against which all detector output is normalised
  (ADR-0003).
- **Round** — one play session of a game, start to game-over.
