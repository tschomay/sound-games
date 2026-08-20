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
- **Section** — one stretch of a *file* between two detected changes of musical
  character: an intro, a verse, a chorus. Found offline over the whole track
  before playback (ADR-0013), never live, and unnamed — the detector can say
  *where* the music changed but not that two sections are the same chorus
  returning. Distinct from **round**, which is a stage of a game.
- **Drop** — the most intense section of a track, the loudest and bassiest one.
  May be absent: a track with no dynamic shape has no drop, and the detector
  says so rather than picking one.
- **Voiced** — the player is producing a sustained tone with a findable
  fundamental, as opposed to noise or silence.
- **Calibration profile** — a player's measured noise floor, loudness ceiling and
  (optionally) pitch range, persisted locally, against which all detector output
  is normalised (ADR-0003). Comes in two halves — see **room** and **pitch
  range** — because only the first is needed by every game (ADR-0004).
- **Room** — the half of a calibration profile every game needs: noise floor and
  comfortable loudness. Measured first and saved on its own.
- **Pitch range** — the half only voice-controlled games need: the top and bottom
  of the player's comfortable hum. May be absent from a profile.
- **Requirement** — what a game declares it needs calibrated (`room` or
  `pitchRange`) before it can be played.
- **Round** — one play session of a game, start to game-over. Its **phase** is
  `ready`, `playing` or `over`, and every game uses those three words.
- **Game** — the rules and picture of one game: `update(dt, frame)`, `render`,
  and its round phase. Knows nothing about microphones, canvases or routing.
- **Game definition** — the metadata around a game: id, title, what it requires
  calibrated, which audio sources it supports, and how to create one. The
  registry is the list of these, and both the menu and the router are built from
  it.
- **Shell** — `screens/play.ts`, which every game is played inside. Owns the
  microphone gate, canvas, frame loop, pausing, restarts, results and scores.
