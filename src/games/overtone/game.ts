/**
 * Overtone's rules, kept free of rendering and of the microphone so the whole
 * thing can be reasoned about (and tested) by feeding it numbers.
 *
 * The idea (`docs/ideas.md` B4) is the instrumental mirror of Hum Flyer (A1):
 * there, *your* pitch draws where you fly; here, the *song's* brightness
 * draws the ground you ride. `centroid` (spectral brightness in Hz) is
 * normalised log-scale into 0..1 the same way `vowel-steering-spike/game.ts`'s
 * `normaliseCentroid` maps Hz for a single voice — this is a deliberately
 * separate local copy, not an import, matching this codebase's convention of
 * small self-contained game modules (see `ecosystem-garden`, `clap-runner`).
 *
 * Two things make this a genuinely different bands-driven design from
 * Ecosystem Garden despite both reading `bands`: this game reads `centroid`
 * (a whole-spectrum brightness average), which no other Category B game uses
 * at all, to reshape *geometry* every frame rather than to drive a slow
 * management meter over minutes; and `bands.bass` is a fast, hard-fail spawn
 * trigger here, not a growth accumulator.
 *
 * The terrain is a ring of samples, not a continuously-reshaped ground under
 * the player: new samples are pushed in at the leading (off-screen) edge as
 * the course scrolls, each one a snapshot of the *smoothed* current
 * brightness — the smoothing itself runs every frame via an exponential
 * chase (same technique Hum Flyer's `follow()` uses for pitch), so a single
 * jittery frame never bakes a permanent spike into the terrain; only the
 * chased value gets sampled in. The player sits at a fixed world x, exactly
 * like Clap Runner — the course scrolls under a stationary camera-relative
 * player — and terrain height under any world x is linearly interpolated
 * between the two nearest samples, the same technique Voice Line Rider uses
 * for its captured pitch contour.
 *
 * Jump collision reuses Clap Runner's low-obstacle shape almost exactly:
 * `jumpHeight()` is already a height *above the local ground*, not an
 * absolute world height, so "clear the obstacle" only ever needs to compare
 * the jump arc against a fixed clearance — the fact that the ground itself is
 * moving up and down under that arc doesn't change the check at all.
 */
import type { RoundPhase } from '../../engine/game';

export interface TerrainSample {
  /** Distance along the course, in world units. */
  x: number;
  /** Normalised brightness, 0 (dark/warm) .. 1 (bright/cutting). */
  height: number;
}

export interface Obstacle {
  /** Distance along the course, in world units — the terrain sample slot it
   *  was pushed in on. */
  x: number;
  /** Half the world-distance width of the obstacle's danger zone. */
  halfWidth: number;
  /** Terrain height the rock sits on, captured at spawn — terrain samples
   *  never change after they're pushed, so this is equivalent to reading
   *  `heightAt(x)` live, just without depending on that sample still being in
   *  the (bounded) ring when collision is checked. */
  groundHeight: number;
  cleared: boolean;
}

export interface Config {
  /** World units between terrain samples pushed in at the leading edge. */
  terrainSpacing: number;
  /** World units ahead of the player that terrain stays generated to — has to
   *  clear the widest thing the render ever needs on screen at once. */
  spawnAhead: number;
  /** How fast the terrain's height chases the current frame's normalised
   *  brightness. Same exponential-chase shape as Hum Flyer's pitch follow,
   *  tuned a little gentler (Hum Flyer uses 9) because a wobbling *flyer* reads
   *  as imprecision, but a wobbling *terrain sample* would look like the
   *  ground itself is jittering — worth a touch more inertia. */
  brightnessResponsiveness: number;
  /** Hz floor of the brightness range mapped log-scale to terrain height 0. A
   *  bass- or pad-heavy full mix centres well above true sub-bass, so this
   *  starts in the low-mid hundreds rather than at DC. */
  centroidLowHz: number;
  /** Hz ceiling mapped to terrain height 1. Cymbals and bright synths in a
   *  full mix push centroid into the low kilohertz; this gives headroom
   *  above that without compressing ordinary mix variation into a sliver of
   *  the range, the same reasoning `vowel-steering-spike` used to pick its
   *  own (much narrower, single-voice) range. */
  centroidHighHz: number;

  /** World units per second at the start of a round. */
  startSpeed: number;
  /** Extra speed per world unit of distance travelled — distance is also the
   *  score, so this is directly "how much harder per point". */
  speedPerDistance: number;
  maxSpeed: number;

  /** `bassLevel` at/above this counts toward a rising-edge hit. */
  bassThreshold: number;
  /** Minimum seconds between bass-triggered spawns, so one sustained bass
   *  note (or a hi-hat riding right at the threshold) can't spawn a wall of
   *  rocks — same cooldown shape as Ecosystem Garden's predator pressure and
   *  Quiet Game's shout detection. */
  spawnCooldown: number;
  /** Half the world-distance width of an obstacle's danger zone. */
  obstacleHalfWidth: number;

  /** Seconds a jump arc lasts, start to landing. */
  jumpDuration: number;
  /** Peak height of the jump arc, in the same 0..1-scaled units as terrain
   *  height — half the terrain's own full-scale amplitude, so a jump clears a
   *  rock without visually floating clear off the top of the tallest peak. */
  jumpPeakHeight: number;
  /** Height above the local ground the jump arc must be at, while inside an
   *  obstacle's zone, to survive it. */
  clearance: number;

  /** `level` at/above this counts as "there is real sound to react to". */
  presenceThreshold: number;
  /** Seconds of sustained presence before 'ready' becomes 'playing'. */
  readyHoldTime: number;
}

export const DEFAULT_CONFIG: Config = {
  // Fine enough that the silhouette reads as a continuous ridge rather than a
  // staircase at the zoom level the render uses (see index.ts's VISIBLE_WORLD).
  terrainSpacing: 0.4,
  spawnAhead: 6,
  brightnessResponsiveness: 6,
  centroidLowHz: 150,
  centroidHighHz: 6000,

  startSpeed: 0.6,
  // A full run that survives to ~200 world units is already near max speed —
  // slow enough to feel like it's building, not a wall at the halfway mark.
  speedPerDistance: 0.004,
  maxSpeed: 1.4,

  bassThreshold: 0.55,
  spawnCooldown: 0.35,
  // Chosen, along with jumpDuration/jumpPeakHeight/clearance below, so the
  // clearance window comfortably outlasts the crossing time at the slowest
  // (start) speed — see the regression test mirroring Clap Runner's for the
  // exact arithmetic. Speed only rises from here, which only shortens the
  // crossing further, so start speed is the hardest case.
  obstacleHalfWidth: 0.09,

  jumpDuration: 0.6,
  jumpPeakHeight: 0.5,
  // Same 0.4 clearance/peak ratio Clap Runner uses for its low obstacle — the
  // arc is above clearance for ~0.46s of its 0.6s, and crossing an obstacle's
  // zone at startSpeed takes ~0.3s, leaving ~165ms of slack — comparable to
  // Clap Runner's own ~150ms margin.
  clearance: 0.2,

  presenceThreshold: 0.06,
  readyHoldTime: 0.4,
};

/**
 * Hz to 0..1 across `config`'s brightness range, log-scaled the same way
 * `vowel-steering-spike`'s `normaliseCentroid` scales Hz for a single voice —
 * a proportional change in brightness should feel the same size regardless of
 * where in the range it happens. A local copy, not a shared import: the two
 * games' ranges (a full mix vs. one voice's formants) are different enough
 * that sharing the function would just be sharing a name, not real logic.
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

/** What the game needs from a Frame — nothing more, so tests need no audio. */
export interface Input {
  centroid: number;
  bassLevel: number;
  level: number;
}

export class Overtone {
  phase: RoundPhase = 'ready';
  /** How far the course has scrolled, in world units — also the player's own
   *  fixed world x, since the player never moves relative to the course. */
  distance = 0;
  terrain: TerrainSample[] = [];
  obstacles: Obstacle[] = [];

  jumping = false;
  /** Seconds into the current jump arc. Meaningless while `jumping` is false. */
  jumpElapsed = 0;

  private smoothedBrightness = 0.5;
  private presenceFor = 0;
  /** Seconds of game time elapsed while playing, for timing the spawn cooldown. */
  private elapsed = 0;
  private previousBass = 0;
  private lastSpawnAt = -Infinity;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  /** Score is distance travelled, not obstacles cleared — the point is
   *  surviving the terrain the song draws, not clearing a fixed set of gates. */
  get score(): number {
    return this.distance;
  }

  get readyHint(): string {
    return 'Waiting for music to settle in';
  }

  reset(): void {
    this.phase = 'ready';
    this.distance = 0;
    this.jumping = false;
    this.jumpElapsed = 0;
    this.smoothedBrightness = 0.5;
    this.presenceFor = 0;
    this.elapsed = 0;
    this.previousBass = 0;
    this.lastSpawnAt = -Infinity;
    this.obstacles = [];

    // A flat opening stretch: nothing has been heard yet, so there is nothing
    // truthful to draw but a neutral mid-height ridge. One sample behind the
    // start keeps `heightAt` able to interpolate right from distance 0.
    this.terrain = [];
    for (
      let x = -this.config.terrainSpacing;
      x <= this.config.spawnAhead + this.config.terrainSpacing;
      x += this.config.terrainSpacing
    ) {
      this.terrain.push({ x, height: 0.5 });
    }
  }

  speed(): number {
    return Math.min(
      this.config.maxSpeed,
      this.config.startSpeed + this.distance * this.config.speedPerDistance,
    );
  }

  /** Current jump arc height above the local ground: a parabola, 0 at takeoff
   *  and landing, peaking at the middle. 0 whenever you're not jumping. */
  jumpHeight(): number {
    if (!this.jumping) return 0;
    const p = this.jumpElapsed / this.config.jumpDuration;
    return this.config.jumpPeakHeight * (1 - (2 * p - 1) ** 2);
  }

  /** Terrain height at world x, linearly interpolated between the two
   *  nearest samples — mirrors Voice Line Rider's `heightAt` for its captured
   *  pitch contour, generalised from a sample index to a world-x lookup since
   *  terrain samples here aren't visited by index elsewhere. */
  heightAt(x: number): number {
    if (this.terrain.length === 0) return 0.5;
    if (x <= this.terrain[0].x) return this.terrain[0].height;
    const last = this.terrain[this.terrain.length - 1];
    if (x >= last.x) return last.height;

    let i = 0;
    while (i < this.terrain.length - 2 && this.terrain[i + 1].x <= x) i++;
    const a = this.terrain[i];
    const b = this.terrain[i + 1];
    const span = b.x - a.x;
    const frac = span > 0 ? (x - a.x) / span : 0;
    return a.height + (b.height - a.height) * frac;
  }

  /** Starts (or restarts) a fixed-duration jump arc. A plain method, not a
   *  Frame field — wired from a `pointerdown` on the canvas, same as Sonar
   *  Maze's `steer()` and Rhythm-Gated Combat's `attack()` (ADR-0006). Always
   *  resets the arc rather than refusing mid-air: with exactly one verb
   *  covering the whole game, a forgiving re-tap costs nothing and matches
   *  Clap Runner's own "a fresh clap restarts the arc" precedent. */
  jump(): void {
    this.jumping = true;
    this.jumpElapsed = 0;
  }

  update(dt: number, input: Input): void {
    // Chase brightness even before the round starts, same reasoning as Hum
    // Flyer calling `follow()` during 'ready' — so the terrain doesn't open
    // by visibly sliding in from a flat 0.5 the instant play begins.
    this.chaseBrightness(dt, input);

    if (this.phase === 'ready') {
      if (input.level >= this.config.presenceThreshold) {
        this.presenceFor += dt;
        if (this.presenceFor >= this.config.readyHoldTime) this.phase = 'playing';
      } else {
        this.presenceFor = 0;
      }
      return;
    }
    if (this.phase !== 'playing') return;

    this.elapsed += dt;
    this.distance += this.speed() * dt;
    this.updateJump(dt);
    this.spawnTerrainAhead();
    this.checkBassHit(input.bassLevel);
    this.checkObstacles();
    this.dropBehind();
  }

  private chaseBrightness(dt: number, input: Input): void {
    const target = normaliseBrightness(input.centroid, this.config);
    const blend = 1 - Math.exp(-this.config.brightnessResponsiveness * dt);
    this.smoothedBrightness += (target - this.smoothedBrightness) * blend;
  }

  private updateJump(dt: number): void {
    if (!this.jumping) return;
    this.jumpElapsed += dt;
    if (this.jumpElapsed >= this.config.jumpDuration) this.jumping = false;
  }

  private spawnTerrainAhead(): void {
    const last = this.terrain[this.terrain.length - 1];
    if (last.x - this.distance < this.config.spawnAhead) {
      this.terrain.push({
        x: last.x + this.config.terrainSpacing,
        height: this.smoothedBrightness,
      });
    }
  }

  /** A rising edge on `bassLevel` crossing `bassThreshold`, with a cooldown —
   *  same detection shape as Ecosystem Garden's predator spawn and Quiet
   *  Game's shout detection. Places a rock at the terrain sample slot that
   *  was just pushed in — the leading edge of the ring — sitting on top of
   *  the terrain height there. */
  private checkBassHit(bassLevel: number): void {
    const crossed = this.previousBass < this.config.bassThreshold && bassLevel >= this.config.bassThreshold;
    this.previousBass = bassLevel;
    if (!crossed) return;
    if (this.elapsed - this.lastSpawnAt < this.config.spawnCooldown) return;

    this.lastSpawnAt = this.elapsed;
    const leading = this.terrain[this.terrain.length - 1];
    this.obstacles.push({
      x: leading.x,
      halfWidth: this.config.obstacleHalfWidth,
      groundHeight: leading.height,
      cleared: false,
    });
  }

  /** Same shape as Clap Runner's low-obstacle check: while inside a danger
   *  zone, the jump arc's height above the local ground must be at/above
   *  clearance, or the round ends immediately — a hard fail, not a forgiving
   *  meter, matching every other hard-collision runner in this codebase. */
  private checkObstacles(): void {
    const height = this.jumpHeight();
    for (const obstacle of this.obstacles) {
      if (obstacle.cleared) continue;
      const relative = obstacle.x - this.distance;
      const inside = Math.abs(relative) <= obstacle.halfWidth;
      const exited = relative < -obstacle.halfWidth;

      if (inside && height < this.config.clearance) {
        this.phase = 'over';
        return;
      }
      if (exited) obstacle.cleared = true;
    }
  }

  private dropBehind(): void {
    // Drop terrain and obstacles well behind the player so neither array can
    // grow without bound over a long run — same margin shape Clap Runner and
    // Quiet Game use, widened slightly for terrain so `heightAt` always keeps
    // at least one sample behind the player to interpolate from.
    while (this.terrain.length > 2 && this.terrain[1].x < this.distance - 1) {
      this.terrain.shift();
    }
    while (this.obstacles.length > 0 && this.obstacles[0].x - this.distance < -2) {
      this.obstacles.shift();
    }
  }
}
