# Support both live microphone and loaded file as music sources

Category B games ("music drives the world") need an audio stream to analyse. A
loaded file is technically far better — we can analyse the whole track *before
play starts* and author a level from its beat grid, sections and energy curve,
which live audio fundamentally cannot do because it can't see the future. But
almost nobody keeps audio files around any more, so a file-only project would
in practice be unplayable for most people.

We therefore support both behind one `AudioSource` interface, and accept that
this **splits the catalogue**: some games are mic-only, some file-only, and some
support both with reduced features on mic (no look-ahead telegraphing, noisier
beat tracking). Each game declares which sources it supports rather than every
game having to work with every source.

## Consequences

- Live mic capture for music **must** disable `echoCancellation`,
  `noiseSuppression` and `autoGainControl`, or the browser will cancel the music
  we're trying to hear and flatten the dynamics we're trying to read.
- Beat tracking needs two implementations — a causal realtime one and an offline
  whole-file one — that agree on the same output shape.
