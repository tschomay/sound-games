# Sound Games

Browser games you play with your voice, and games your music plays with you.

Everything runs on the device — the microphone signal is analysed in the page and
never leaves it.

## Running it

```sh
npm install
npm run dev        # then open the printed URL on your phone, on the same network
npm test           # detector and game-logic tests
npm run typecheck
npm run build
```

The microphone needs a secure context, so on a phone use `localhost` or serve the
dev server over HTTPS — plain `http://<lan-ip>` will not get a microphone.

## What's here

| | |
| --- | --- |
| **Calibrate** | Measures your room's noise floor and your hum range. Everything else reads the profile it writes, so run it first. |
| **Hum Flyer** | Hum to fly — higher note, higher flight. The gaps trace a melody, so flying it well means singing the tune. |
| **Signal scope** | Live waveform, spectrum and every detector reading. For tuning, and for working out why a game is misreading you. |

`docs/ideas.md` has the full backlog of game concepts and which detectors each one
needs. `docs/adr/` records the decisions that would otherwise look arbitrary.

## Layout

```
src/
├── engine/           mic + file sources, detectors, calibration, canvas helpers
│   ├── pitch.ts      fundamental frequency (NSDF autocorrelation)
│   ├── onset.ts      transient detection (spectral flux)
│   ├── analyser.ts   assembles one Frame per animation frame
│   └── calibration.ts
├── screens/          calibrate, signal scope, menu
└── games/
    └── hum-flyer/    game.ts is pure rules; screen.ts draws and wires audio
```

Game rules live in plain modules that take numbers in and have no idea a
microphone exists, which is why they can be tested without one.

## Design notes

Voice input is laggy, continuous and imprecise next to a button — roughly 30–45 ms
to a confident pitch and 10–20 ms to a detected clap. So these games are built so
that imprecision is charming rather than fatal: sustained control, gestures,
thresholds and rhythm, never twitch precision.

The other thing that decides whether a microphone game works is device variance,
not signal processing. A hum reading −25 dB on a laptop reads −45 dB on a phone at
arm's length, so games never see raw decibels or hertz — only values normalised
against the player's own calibration profile.
