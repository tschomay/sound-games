# Vanilla TypeScript, Vite and canvas — no game engine, no UI framework

Each game here is a render loop plus a Web Audio graph. A game engine (Phaser,
Pixi) or a UI framework (React) would add a scheduling and state layer between us
and `requestAnimationFrame`/`AudioContext`, which is precisely the layer we need
unobstructed access to — audio-reactive games live or die on frame timing and
analyser latency.

Vite gives us TypeScript and a dev server; everything else is the platform.
Revisit only if a game needs real scene management or heavy sprite batching.
