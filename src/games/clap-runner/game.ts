/**
 * Clap Runner's rules, kept free of rendering and of the microphone so the
 * whole thing can be reasoned about (and tested) by feeding it numbers.
 *
 * An auto-runner: you advance automatically through a corridor of obstacles,
 * and three independent verbs come from one microphone by way of the
 * transient/sustain classifier (`engine/timbre-class.ts`, see ADR-0007):
 *
 * - **Clap** (`onset`) starts a fixed-duration jump arc — clear a low
 *   obstacle by having it fall inside the arc's window of sufficient height.
 * - **Held "aaah"** (`timbreClass === 'tonal'`, sustained) glides you across a
 *   gap for as long as you hold it.
 * - **Shout** (`timbreClass === 'noisy'` and loud) ground-pounds through a
 *   breakable obstacle.
 *
 * Unlike Quiet Game's guard (a forgiving suspicion meter), every obstacle
 * here fails hard the instant you're inside its zone in the wrong state —
 * closer to Sonar Maze's wall, and the more natural fit for a runner where
 * touching the wrong thing is supposed to just be over.
 */
import type { RoundPhase } from '../../engine/game';
import type { Timbre } from '../../engine/types';

export type ObstacleKind = 'low' | 'gap' | 'breakable';

export interface Obstacle {
  kind: ObstacleKind;
  /** Distance along the course, in world units. */
  x: number;
  /** Half the world-distance width of the obstacle's danger zone. */
  halfWidth: number;
  /** Ground-pounded open while inside its zone. Breakable only. */
  broken: boolean;
  cleared: boolean;
}

export interface Config {
  /** World units between obstacles. */
  spacing: number;
  /** World units per second at the start of a round. */
  startSpeed: number;
  /** Extra speed per obstacle cleared. */
  speedPerScore: number;
  maxSpeed: number;

  /** Seconds a jump arc lasts, start to landing. */
  jumpDuration: number;
  /** Peak height of the jump arc, world units. */
  jumpPeakHeight: number;
  /** Height the jump arc must be at to clear a low obstacle. */
  lowClearance: number;
  lowHalfWidth: number;

  gapHalfWidth: number;

  breakableHalfWidth: number;
  /** `level` at/above this, while `timbreClass` is 'noisy', counts as a
   *  ground-pounding shout rather than just any harsh sound. */
  poundLevel: number;
}

export const DEFAULT_CONFIG: Config = {
  spacing: 2.6,
  startSpeed: 0.6,
  speedPerScore: 0.01,
  maxSpeed: 1.3,

  // The clearance window (how long the jump arc stays above lowClearance)
  // has to be comfortably wider than the time spent crossing a low
  // obstacle's zone at the *slowest* speed the round ever runs at (the start
  // — obstacles only get faster to cross from here, never slower), or no
  // clap timing can ever clear it. At these numbers the arc is above
  // clearance for ~0.46s and crossing the zone at startSpeed takes ~0.3s —
  // about 150ms of slack, which is also enough margin to test without frame
  // timing being knife-edge.
  jumpDuration: 0.6,
  jumpPeakHeight: 1,
  lowClearance: 0.4,
  lowHalfWidth: 0.09,

  gapHalfWidth: 0.35,

  breakableHalfWidth: 0.18,
  poundLevel: 0.55,
};

/** What the game needs from a Frame — nothing more, so tests need no audio. */
export interface Input {
  onset: boolean;
  level: number;
  timbreClass: Timbre;
}

export class ClapRunner {
  phase: RoundPhase = 'ready';
  score = 0;
  /** How far the course has scrolled, in world units. */
  distance = 0;
  obstacles: Obstacle[] = [];
  /** Set on the frame an obstacle is cleared, for the hit effect. Decays to zero. */
  celebration = 0;

  jumping = false;
  /** Seconds into the current jump arc. Meaningless while `jumping` is false. */
  jumpElapsed = 0;
  /** True this frame while gliding — derived straight from the classifier,
   *  no state of its own, so it can never desync from what the mic reports. */
  gliding = false;
  pounding = false;

  private nextIndex = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  reset(): void {
    this.phase = 'ready';
    this.score = 0;
    this.distance = 0;
    this.celebration = 0;
    this.jumping = false;
    this.jumpElapsed = 0;
    this.gliding = false;
    this.pounding = false;
    this.nextIndex = 0;
    this.obstacles = [];
    // A little clear corridor before the first obstacle, so a round never
    // opens with a hazard you had no chance to prepare for.
    for (let i = 0; i < 6; i++) {
      this.spawn((2 + i) * this.config.spacing);
    }
  }

  speed(): number {
    return Math.min(
      this.config.maxSpeed,
      this.config.startSpeed + this.score * this.config.speedPerScore,
    );
  }

  /** Current jump arc height: a parabola, 0 at takeoff and landing, peaking
   *  at the middle. 0 whenever you're not jumping. */
  jumpHeight(): number {
    if (!this.jumping) return 0;
    const p = this.jumpElapsed / this.config.jumpDuration;
    return this.config.jumpPeakHeight * (1 - (2 * p - 1) ** 2);
  }

  /** The obstacle you're heading for, or null past the end of the spawned run. */
  nextObstacle(): Obstacle | null {
    for (const obstacle of this.obstacles) {
      if (!obstacle.cleared) return obstacle;
    }
    return null;
  }

  update(dt: number, input: Input): void {
    this.celebration = Math.max(0, this.celebration - dt * 3);

    if (this.phase === 'ready') {
      // A round starts on your first clap — the same verb Sonar Maze opens
      // on, and the one every player reaches for first.
      if (input.onset) {
        this.phase = 'playing';
        this.startJump();
      }
      return;
    }
    if (this.phase !== 'playing') return;

    this.distance += this.speed() * dt;
    this.updateJump(dt, input);
    this.gliding = input.timbreClass === 'tonal';
    this.pounding = input.timbreClass === 'noisy' && input.level >= this.config.poundLevel;

    this.checkObstacles();
    this.spawnAhead();
    this.dropBehind();
  }

  private startJump(): void {
    this.jumping = true;
    this.jumpElapsed = 0;
  }

  private updateJump(dt: number, input: Input): void {
    if (input.onset) this.startJump(); // a fresh clap restarts the arc
    if (!this.jumping) return;
    this.jumpElapsed += dt;
    if (this.jumpElapsed >= this.config.jumpDuration) this.jumping = false;
  }

  private checkObstacles(): void {
    const height = this.jumpHeight();

    for (const obstacle of this.obstacles) {
      if (obstacle.cleared) continue;
      const relative = obstacle.x - this.distance;
      const inside = Math.abs(relative) <= obstacle.halfWidth;
      const exited = relative < -obstacle.halfWidth;

      if (inside) {
        if (obstacle.kind === 'low' && height < this.config.lowClearance) {
          this.phase = 'over';
          return;
        }
        if (obstacle.kind === 'gap' && !this.gliding) {
          this.phase = 'over';
          return;
        }
        if (obstacle.kind === 'breakable' && this.pounding) {
          obstacle.broken = true;
        }
      }

      if (exited) {
        if (obstacle.kind === 'breakable' && !obstacle.broken) {
          this.phase = 'over';
          return;
        }
        obstacle.cleared = true;
        this.score++;
        this.celebration = 1;
      }
    }
  }

  private spawn(x: number): void {
    const index = this.nextIndex++;
    // A rotating, not random, pattern — same reasoning as Sonar Maze and
    // Quiet Game's spawn patterns — so a round replays the same way from the
    // same inputs and tests stay reproducible.
    const kind: ObstacleKind = (['low', 'gap', 'breakable'] as const)[index % 3];
    const halfWidth =
      kind === 'low'
        ? this.config.lowHalfWidth
        : kind === 'gap'
          ? this.config.gapHalfWidth
          : this.config.breakableHalfWidth;
    this.obstacles.push({ kind, x, halfWidth, broken: false, cleared: false });
  }

  private spawnAhead(): void {
    const last = this.obstacles[this.obstacles.length - 1];
    if (last && last.x - this.distance < 6 * this.config.spacing) {
      this.spawn(last.x + this.config.spacing);
    }
  }

  private dropBehind(): void {
    // Drop obstacles well behind the player so the array can't grow without bound.
    while (this.obstacles.length > 0 && this.obstacles[0].x - this.distance < -2) {
      this.obstacles.shift();
    }
  }
}
