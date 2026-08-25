/**
 * Trackgen's rules, kept free of rendering and of the microphone so the whole
 * thing can be reasoned about (and tested) by feeding it numbers.
 *
 * The idea (`docs/ideas.md` B5): drop in a track, get a level generated from
 * it. `analyseSongStructure` (`engine/sections.ts`, ADR-0013) becomes the
 * level's chapters — one biome per section — and this game's own offline pass
 * (`sectionBrightness.ts`) colours each one by its own mean spectral
 * brightness; onset peaks picked from the whole-track onset envelope
 * (`computeOnsetEnvelope`, `engine/beat-offline.ts`) become placed
 * collectibles. All of that happens once, offline, before the round starts —
 * this class only ever receives the *result* of that analysis
 * (`configureTrack`), the same split Drop Siege uses for `SongStructure`
 * itself. See `index.ts` for where the analysis actually runs.
 *
 * **The non-negotiable constraint**: world position is always
 * `positionSeconds * config.worldUnitsPerSecond`, read straight from
 * `FileSource.position()` every `update()`, never a `dt`-accumulated
 * distance. A collectible authored at second 47 of the track sits at world x
 * `47 * worldUnitsPerSecond` forever, so it can only ever arrive under the
 * fixed-position player at the moment second 47 of the actual audio plays —
 * exactly Drop Siege's timeline principle, extended from wave timing to the
 * whole world.
 *
 * **v1 scope, deliberately smaller than the full pitch** (spelled out in the
 * ideas.md entry): no hazards, no fail state. The round runs the whole track;
 * reaching the end ends it, win or lose is not a concept here. Score is
 * collectibles grabbed out of however many the analysis placed — different
 * every time someone brings a different track, which is the point.
 *
 * **The one verb starts the round, same as it drives it** — `jump()` is a
 * tap, not a Frame field (ADR-0006), and the very first tap both starts the
 * round (once a level exists — `configureTrack` must have run) and performs
 * that first jump, the same "no separate button to learn" precedent Sonar
 * Maze's first clap sets.
 *
 * **Biome colour is per-section brightness, blended smoothly across a
 * boundary** rather than cut hard at it — `brightnessAt` crossfades over the
 * last `biomeCrossfadeSeconds` of a section into the next one's brightness,
 * because a hard-cut colour swap the instant the analysis says "new section"
 * would read as a glitch, not a scene change. The *drop* section (whichever
 * one `SongStructure.dropIndex` names, when there is one) is flagged
 * (`Biome.isDrop`) for the renderer to read as the climax — a boost to
 * saturation/brightness lives in `index.ts`'s render, not baked into
 * `brightness01` itself, so `brightness01` always means what it says: this
 * section's own measured brightness, nothing else layered in. Density at the
 * climax is instead handled by `index.ts`'s peak-picker packing collectibles
 * tighter inside the drop's own time range — again render/generation
 * concerns, not something this pure-rules class needs to know about beyond
 * the `isDrop` flag it stores.
 */
import type { RoundPhase } from '../../engine/game';
import type { SongStructure } from '../../engine/sections';

export interface Config {
  /** World units per second of track position — the single scale factor that
   *  turns `positionSeconds` (and any `atSeconds`) into a world x. */
  worldUnitsPerSecond: number;
  /** Seconds a jump arc lasts, start to landing — same shape as Overtone's
   *  `jump()`/`jumpHeight()`. */
  jumpDuration: number;
  /** Peak height of the jump arc, in the same 0..1-scaled units `pickupHeight`
   *  is measured in. */
  jumpPeakHeight: number;
  /** Minimum `jumpHeight()` a collectible requires to be grabbed — collectibles
   *  sit above the baseline on purpose, so a grab takes real timing, not just
   *  drifting past on the ground. */
  pickupHeight: number;
  /** How close (in seconds of track position) the player has to be to a
   *  collectible's `atSeconds`, while airborne past `pickupHeight`, to grab
   *  it. Sized, together with `jumpDuration`/`jumpPeakHeight`/`pickupHeight`,
   *  so a well-timed tap can actually connect — see the regression test
   *  mirroring Overtone's own clearance-window arithmetic. */
  pickupWindowSeconds: number;
  /** Hz floor of the brightness range mapped log-scale to biome brightness 0.
   *  Same reasoning and same default as Overtone's `centroidLowHz` — this is
   *  also a whole-mix brightness measure, not a single voice's. */
  centroidLowHz: number;
  /** Hz ceiling mapped to biome brightness 1. */
  centroidHighHz: number;
  /** Seconds before a section boundary over which its biome colour blends
   *  into the next section's, rather than cutting instantly. */
  biomeCrossfadeSeconds: number;
}

export const DEFAULT_CONFIG: Config = {
  worldUnitsPerSecond: 4,

  jumpDuration: 0.6,
  jumpPeakHeight: 0.5,
  // k = 1 - pickupHeight/jumpPeakHeight = 0.6; sqrt(k) * jumpDuration ≈ 0.465s
  // is how long the arc spends at/above pickupHeight — comfortably more than
  // twice pickupWindowSeconds, so a tap timed to land the arc's peak within
  // ~150ms of a collectible's instant still grabs it. See the regression test.
  pickupHeight: 0.2,
  pickupWindowSeconds: 0.15,

  centroidLowHz: 150,
  centroidHighHz: 6000,

  biomeCrossfadeSeconds: 3,
};

/**
 * Hz to 0..1 across `config`'s brightness range, log-scaled the same way
 * `overtone/game.ts`'s `normaliseBrightness` and `vowel-steering-spike`'s
 * `normaliseCentroid` both already do — a proportional change in brightness
 * should feel the same size regardless of where in the range it happens. A
 * local copy, not a shared import, matching this codebase's convention of
 * small self-contained game modules.
 */
export function normaliseBrightness(
  hz: number,
  config: Pick<Config, 'centroidLowHz' | 'centroidHighHz'> = DEFAULT_CONFIG,
): number {
  if (!(hz > 0)) return 0;
  const span = Math.log2(config.centroidHighHz / config.centroidLowHz);
  if (!Number.isFinite(span) || span <= 0) return 0.5;
  return clamp01(Math.log2(hz / config.centroidLowHz) / span);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** One chapter of the generated level — directly one `Section` of the track's
 *  structure, coloured by its own measured brightness. */
export interface Biome {
  index: number;
  startSeconds: number;
  endSeconds: number;
  /** 0..1 log-scale mapped mean spectral brightness — dark/warm at 0,
   *  bright/cutting at 1. Never adjusted for `isDrop`; see the file doc. */
  brightness01: number;
  /** True for the section `SongStructure.dropIndex` named, or none. */
  isDrop: boolean;
}

/** A placed collectible, and this round's own runtime state for it. */
export interface RuntimeCollectible {
  /** Track position it was placed at — fixed for the whole round, and the
   *  only thing that ever decided where it sits in the world. */
  atSeconds: number;
  grabbed: boolean;
}

/** What the game needs from a Frame, plus playback position — nothing more,
 *  so tests need no audio and no real file. */
export interface Input {
  /** Seconds into the file — `FileSource.position()`. The single source of
   *  truth for world position; see the file doc. */
  positionSeconds: number;
}

/** How close to the end of the track counts as "the track is over" — a hair
 *  of slack for float drift in `positionSeconds`, same convention and same
 *  value as Drop Siege's `TRACK_END_EPSILON`. */
const TRACK_END_EPSILON = 0.1;

export class Trackgen {
  phase: RoundPhase = 'ready';
  positionSeconds = 0;

  jumping = false;
  /** Seconds into the current jump arc. Meaningless while `jumping` is false. */
  jumpElapsed = 0;

  /** The whole track's biomes, set once by `configureTrack` and preserved
   *  across `reset()` — a fresh round replays the same generated level, not a
   *  freshly analysed one. Empty until a level has been generated. */
  biomes: Biome[] = [];
  /** Track duration from the structure `configureTrack` was given — 0 until
   *  a level exists, and how `hasLevel`/round-end both know one does. */
  duration = 0;

  /** This round's collectibles — persists the *positions* across `reset()`
   *  (regenerating the whole placement on every retry would replay a
   *  different, arbitrarily different-feeling level each time), resetting
   *  only which ones are grabbed. */
  collectibles: RuntimeCollectible[] = [];
  private grabbedCount = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  /**
   * Score is collectibles grabbed, out of the total the analysis placed — the
   * exact "14/22 notes" framing `docs/ideas.md` B5 asks for. `GameDefinition`
   * only ever carries a bare `score: number` through to `formatScore`, so
   * both numbers are packed into one float: the integer part is collectibles
   * grabbed, and the total rides along scaled into the fractional part (a
   * track producing 10,000 or more collectibles is not a real case). This
   * still compares sensibly as a bare number for the "best score" persistence
   * (`engine/scores.ts`) — more collectibles grabbed always reads as a bigger
   * number — while `index.ts`'s `formatScore` decodes both halves back out
   * for display. See `Trackgen`'s tests for the round-trip.
   */
  get score(): number {
    return this.grabbedCount + this.collectibles.length / 10_000;
  }

  get readyHint(): string {
    return this.hasLevel() ? 'Tap to jump in — grab the notes as they scroll by' : 'Analysing the track';
  }

  private hasLevel(): boolean {
    return this.duration > 0;
  }

  /**
   * Hand the game the whole generated level, once, before play starts.
   * `sectionCentroidHz[i]` is the raw mean centroid (Hz) for `structure
   * .sections[i]`, from `sectionBrightness.ts` — normalised into `brightness01`
   * here, the same split Overtone uses for its own live `centroid` input.
   * `collectibleSeconds` is the whole-track list of onset-peak timestamps
   * `index.ts`'s peak-picker already placed; sorted here so `collectibles`
   * is always in track order regardless of what order onsets were picked in.
   *
   * Safe to call again — a fresh `create()` per round means it normally
   * isn't, but nothing here assumes it is only ever called once.
   */
  configureTrack(
    structure: SongStructure,
    sectionCentroidHz: readonly number[],
    collectibleSeconds: readonly number[],
  ): void {
    this.biomes = structure.sections.map((section, i) => ({
      index: section.index,
      startSeconds: section.startSeconds,
      endSeconds: section.endSeconds,
      brightness01: normaliseBrightness(sectionCentroidHz[i] ?? 0, this.config),
      isDrop: structure.dropIndex === section.index,
    }));
    this.duration = structure.duration;
    this.collectibles = collectibleSeconds
      .slice()
      .sort((a, b) => a - b)
      .map((atSeconds) => ({ atSeconds, grabbed: false }));
    this.grabbedCount = 0;
  }

  reset(): void {
    this.phase = 'ready';
    this.positionSeconds = 0;
    this.jumping = false;
    this.jumpElapsed = 0;
    // biomes/duration deliberately survive a reset — see the field doc.
    // Collectible *positions* also survive; only "grabbed" resets, so a retry
    // replays the same level rather than a freshly (and differently) placed one.
    this.collectibles = this.collectibles.map((c) => ({ atSeconds: c.atSeconds, grabbed: false }));
    this.grabbedCount = 0;
  }

  /** Current jump arc height above the baseline: a parabola, 0 at takeoff and
   *  landing, peaking at the middle. 0 whenever you're not jumping. Same shape
   *  as Overtone's `jumpHeight()`. */
  jumpHeight(): number {
    if (!this.jumping) return 0;
    const p = this.jumpElapsed / this.config.jumpDuration;
    return this.config.jumpPeakHeight * (1 - (2 * p - 1) ** 2);
  }

  /** World x for a track position, in world units — the one scale factor
   *  everything (the player, every collectible, every biome boundary) is
   *  positioned through. */
  worldX(seconds: number): number {
    return seconds * this.config.worldUnitsPerSecond;
  }

  /** The player's (and camera's) current world x — always derived from
   *  `positionSeconds`, never accumulated. */
  playerWorldX(): number {
    return this.worldX(this.positionSeconds);
  }

  /**
   * Starts (or restarts) a fixed-duration jump arc — a plain method, not a
   * Frame field, wired from a `pointerdown` on the canvas (ADR-0006). While
   * still `'ready'`, the first tap also starts the round — the same "the one
   * verb both starts and drives the game" precedent Sonar Maze's first clap
   * sets — but only once a level has actually been generated; a tap before
   * that (which the shell shouldn't be able to produce, since the ready hint
   * still says "Analysing", but nothing here assumes the shell got that
   * right) does nothing.
   */
  jump(): void {
    if (this.phase === 'ready') {
      if (!this.hasLevel()) return;
      this.phase = 'playing';
    }
    if (this.phase !== 'playing') return;
    this.jumping = true;
    this.jumpElapsed = 0;
  }

  update(dt: number, input: Input): void {
    // Tracked unconditionally, even in 'ready' — a paused file source reports
    // a steady position, so this is harmless before the round starts and lets
    // a renderer show the (motionless) world under the "tap to begin" prompt.
    this.positionSeconds = input.positionSeconds;

    if (this.phase !== 'playing') return;

    this.updateJump(dt);
    this.checkCollectibles();
    this.checkRoundEnd();
  }

  private updateJump(dt: number): void {
    if (!this.jumping) return;
    this.jumpElapsed += dt;
    if (this.jumpElapsed >= this.config.jumpDuration) this.jumping = false;
  }

  /** Grab every ungrabbed collectible within `pickupWindowSeconds` of the
   *  current position, while airborne past `pickupHeight`. Cheap to bail
   *  early on the common case (not airborne enough to grab anything at all)
   *  before scanning the list. */
  private checkCollectibles(): void {
    if (this.jumpHeight() < this.config.pickupHeight) return;
    for (const collectible of this.collectibles) {
      if (collectible.grabbed) continue;
      if (Math.abs(this.positionSeconds - collectible.atSeconds) > this.config.pickupWindowSeconds) continue;
      collectible.grabbed = true;
      this.grabbedCount++;
    }
  }

  /** The round ends when the track does, not on any fail condition — v1's
   *  deliberately narrower scope (no hazards, no fail state) means reaching
   *  the end is the only way a round finishes. */
  private checkRoundEnd(): void {
    if (!this.hasLevel()) return;
    if (this.positionSeconds >= this.duration - TRACK_END_EPSILON) this.phase = 'over';
  }

  /** Which biome index covers this track position. Clamps to the last biome
   *  past the end of the track, same convention as Drop Siege's
   *  `sectionIndexAt`, so a position landing exactly on the final sample still
   *  resolves to something. */
  biomeIndexAt(seconds: number): number | null {
    if (this.biomes.length === 0) return null;
    for (const biome of this.biomes) {
      if (seconds < biome.endSeconds) return biome.index;
    }
    return this.biomes[this.biomes.length - 1].index;
  }

  /**
   * Biome brightness at a track position, crossfaded smoothly across a
   * section boundary rather than cut hard at it: over the last
   * `biomeCrossfadeSeconds` of a section, the answer blends linearly from this
   * section's own brightness toward the next section's, so the parallax
   * background eases into a new colour instead of jumping the instant the
   * analysis says "new section". 0.5 (neutral) with no biomes generated yet.
   */
  brightnessAt(seconds: number): number {
    const index = this.biomeIndexAt(seconds);
    if (index === null) return 0.5;
    const current = this.biomes[index];
    const next = this.biomes[index + 1];
    if (!next) return current.brightness01;

    const remaining = current.endSeconds - seconds;
    const span = this.config.biomeCrossfadeSeconds;
    if (remaining >= span || span <= 0) return current.brightness01;
    const t = clamp01(1 - Math.max(0, remaining) / span);
    return current.brightness01 + (next.brightness01 - current.brightness01) * t;
  }
}
