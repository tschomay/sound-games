/**
 * Quiet Game's rules, kept free of rendering and of the microphone so the whole
 * thing can be reasoned about (and tested) by feeding it numbers.
 *
 * Inverted from Hum Flyer: instead of a continuous axis to steer, there is one
 * line to stay under. Sneak past guards by staying quiet; shout on purpose to
 * shatter a glass panel and throw the nearest guard's attention onto it instead
 * of you. Level only — no pitch, no onset, just how loud the room reads against
 * your own calibration.
 */
import type { RoundPhase } from '../../engine/game';

export type ObstacleKind = 'guard' | 'glass';

export interface Obstacle {
  kind: ObstacleKind;
  /** Distance along the course, in world units. */
  x: number;
  /** Half the world-distance the obstacle can hear (guard) or must be crossed
   *  loud (glass) across. */
  halfWidth: number;
  /** 0..1, rises while you're too loud inside a guard's zone. Guard only. */
  suspicion: number;
  /** Broken by a shout while inside its window. Glass only. */
  shattered: boolean;
  cleared: boolean;
  /** Set when a guard's suspicion maxed out on this obstacle, for the render. */
  caught: boolean;
}

export interface Config {
  /** World units between obstacles. */
  spacing: number;
  /** World units per second at the start of a round. */
  startSpeed: number;
  /** Extra speed per obstacle cleared. */
  speedPerGate: number;
  maxSpeed: number;
  /** Half-width of a guard's listening zone, in world units. */
  guardHalfWidth: number;
  /** Half-width of a glass panel's breakable window, in world units. */
  glassHalfWidth: number;
  /** Level below this is safe near a guard. */
  sneakThreshold: number;
  /** Level at/above this counts as a deliberate shout. */
  shoutThreshold: number;
  /** Suspicion gained per second while too loud in a guard's zone. */
  suspicionRate: number;
  /** Suspicion gets less forgiving as you clear more obstacles. */
  suspicionRatePerScore: number;
  /** Suspicion lost per second while quiet in a guard's zone. */
  suspicionDecay: number;
  /** How many seconds a shattered glass panel keeps guards looking elsewhere. */
  distractionDuration: number;
  /** Every Nth obstacle is a glass panel instead of a guard. */
  glassEvery: number;
  /** Seconds of held quiet before a "ready" round becomes "playing". */
  readyHoldTime: number;
}

export const DEFAULT_CONFIG: Config = {
  spacing: 2.2,
  startSpeed: 0.6,
  speedPerGate: 0.01,
  maxSpeed: 1.3,
  guardHalfWidth: 0.55,
  glassHalfWidth: 0.12,
  sneakThreshold: 0.32,
  shoutThreshold: 0.72,
  suspicionRate: 0.9,
  suspicionRatePerScore: 0.02,
  suspicionDecay: 0.6,
  distractionDuration: 2.5,
  glassEvery: 3,
  readyHoldTime: 0.4,
};

/** What the game needs from a Frame — nothing more, so tests need no audio. */
export interface Input {
  level: number;
}

export class QuietGame {
  phase: RoundPhase = 'ready';
  score = 0;
  /** How far the course has scrolled, in world units. */
  distance = 0;
  obstacles: Obstacle[] = [];
  /** Set on the frame an obstacle is cleared, for the hit effect. Decays to zero. */
  celebration = 0;

  /** Seconds of game time elapsed while playing, for timing the distraction. */
  private elapsed = 0;
  private distractionUntil = -Infinity;
  private quietFor = 0;
  private nextIndex = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  reset(): void {
    this.phase = 'ready';
    this.score = 0;
    this.distance = 0;
    this.elapsed = 0;
    this.distractionUntil = -Infinity;
    this.quietFor = 0;
    this.nextIndex = 0;
    this.celebration = 0;
    this.obstacles = [];
    // A little clear corridor before the first guard, so a round never opens
    // with a zone you had no chance to prepare for.
    for (let i = 0; i < 6; i++) {
      this.spawn((1.6 + i) * this.config.spacing);
    }
  }

  /** Whether a shattered glass panel is still holding a guard's attention. */
  get distracted(): boolean {
    return this.elapsed < this.distractionUntil;
  }

  private spawn(x: number): void {
    const index = this.nextIndex++;
    const kind: ObstacleKind = (index + 1) % this.config.glassEvery === 0 ? 'glass' : 'guard';
    this.obstacles.push({
      kind,
      x,
      halfWidth: kind === 'guard' ? this.config.guardHalfWidth : this.config.glassHalfWidth,
      suspicion: 0,
      shattered: false,
      cleared: false,
      caught: false,
    });
  }

  speed(): number {
    return Math.min(
      this.config.maxSpeed,
      this.config.startSpeed + this.score * this.config.speedPerGate,
    );
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
      // A round starts once you prove you can hold quiet — a beat of tension
      // before the sneaking even begins, and the whole joke is that it asks
      // something of the actual room you're sitting in.
      if (input.level < this.config.sneakThreshold) {
        this.quietFor += dt;
        if (this.quietFor >= this.config.readyHoldTime) this.phase = 'playing';
      } else {
        this.quietFor = 0;
      }
      return;
    }
    if (this.phase !== 'playing') return;

    this.elapsed += dt;
    this.distance += this.speed() * dt;
    this.checkObstacles(dt, input.level);
    this.spawnAhead();
    this.dropBehind();
  }

  private checkObstacles(dt: number, level: number): void {
    const shouting = level >= this.config.shoutThreshold;

    for (const obstacle of this.obstacles) {
      if (obstacle.cleared) continue;
      const relative = obstacle.x - this.distance;
      const inside = Math.abs(relative) <= obstacle.halfWidth;
      const exited = relative < -obstacle.halfWidth;

      if (obstacle.kind === 'glass') {
        if (inside && shouting && !obstacle.shattered) {
          obstacle.shattered = true;
          this.distractionUntil = this.elapsed + this.config.distractionDuration;
        }
        if (exited) {
          if (!obstacle.shattered) {
            this.phase = 'over';
            return;
          }
          obstacle.cleared = true;
          this.score++;
          this.celebration = 1;
        }
        continue;
      }

      // guard
      if (inside) {
        if (level >= this.config.sneakThreshold && !this.distracted) {
          const rate = this.config.suspicionRate + this.score * this.config.suspicionRatePerScore;
          obstacle.suspicion = Math.min(1, obstacle.suspicion + rate * dt);
          if (obstacle.suspicion >= 1) {
            obstacle.caught = true;
            this.phase = 'over';
            return;
          }
        } else {
          obstacle.suspicion = Math.max(0, obstacle.suspicion - this.config.suspicionDecay * dt);
        }
      }
      if (exited) {
        obstacle.cleared = true;
        this.score++;
        this.celebration = 1;
      }
    }
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
