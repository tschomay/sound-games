/**
 * Sonar Maze's rules, kept free of rendering and of the microphone so the whole
 * thing can be reasoned about (and tested) by feeding it numbers.
 *
 * The screen is dark. You advance forward automatically through a corridor of
 * `lanes` parallel tracks; every `spacing` units a fork blocks two of the three
 * lanes, and you have to already be in the one open lane when you reach it.
 * Which lane that is stays hidden until a clap's wavefront reaches the fork —
 * `onset` triggers the clap, `level` sets how far it reaches — so reading the
 * maze costs noise, and noise is exactly what the hunter homes in on. Lane
 * changes themselves are a steer() call rather than a Frame field: that verb is
 * meant to be driven by a tap (see index.ts), deliberately not the voice input,
 * so it doesn't compete with the clap for the same channel. See ADR-0006.
 */
import type { RoundPhase } from '../../engine/game';

export interface Fork {
  /** Distance along the course, in world units. */
  x: number;
  /** The one lane, of `config.lanes`, that isn't walled off here. */
  openLane: number;
  /** Set once a wavefront has reached it — stays revealed for the rest of the round. */
  revealed: boolean;
  passed: boolean;
}

export interface Config {
  lanes: number;
  /** World units between forks. */
  spacing: number;
  /** World units per second at the start of a round. */
  startSpeed: number;
  /** Extra speed per fork cleared. */
  speedPerScore: number;
  maxSpeed: number;
  /** Reveal radius, in world units, from the softest clap that still triggers. */
  wavefrontBaseRadius: number;
  /** Extra radius at `level` 1. */
  wavefrontBonus: number;
  /** Hunter's world-distance gap behind the player at round start. */
  hunterStartGap: number;
  /** Hunter's forward crawl speed with zero alertness — kept below `startSpeed`
   *  so an unclapped round lets it fall behind on its own. */
  hunterBaseSpeed: number;
  /** Extra forward speed at alertness 1 — kept above `maxSpeed` so a hunter
   *  that's been fed enough noise can close the gap even at your top speed. */
  hunterAlertSpeedBonus: number;
  /** Alertness gained from a `level` 1 clap. */
  hunterAlertGain: number;
  /** Alertness lost per second. */
  hunterAlertDecay: number;
  /** How fast the hunter's lane tracking locks on at alertness 0. */
  hunterChaseBase: number;
  /** Extra lane tracking rate at alertness 1. */
  hunterChaseBonus: number;
  /** How far off your lane the hunter's target wanders at alertness 0, in lane
   *  units — a deterministic wobble rather than real randomness, so a round is
   *  reproducible; see the class doc comment. */
  hunterWander: number;
  /** World-distance gap that counts as caught. */
  catchDistance: number;
  /** Lane-distance gap that counts as caught. */
  catchLaneTolerance: number;
}

export const DEFAULT_CONFIG: Config = {
  lanes: 3,
  spacing: 3.4,
  startSpeed: 0.55,
  speedPerScore: 0.012,
  maxSpeed: 1.1,
  wavefrontBaseRadius: 1.6,
  wavefrontBonus: 2.4,
  hunterStartGap: 5,
  hunterBaseSpeed: 0.4,
  hunterAlertSpeedBonus: 0.9,
  hunterAlertGain: 0.5,
  hunterAlertDecay: 0.18,
  hunterChaseBase: 0.8,
  hunterChaseBonus: 3.0,
  hunterWander: 0.9,
  catchDistance: 0.35,
  catchLaneTolerance: 0.6,
};

/** What the game needs from a Frame — nothing more, so tests need no audio.
 *  Lane changes come through `steer()` instead; see the class doc comment. */
export interface Input {
  onset: boolean;
  level: number;
}

export class SonarMaze {
  phase: RoundPhase = 'ready';
  score = 0;
  /** How far the course has scrolled, in world units. */
  distance = 0;
  /** Current lane, 0..lanes-1. */
  lane = 0;
  forks: Fork[] = [];
  /** Set on the frame a fork is cleared, for the hit effect. Decays to zero. */
  celebration = 0;

  /** 0..1, how locked-on the hunter is. Rises on a clap, decays otherwise. */
  alertness = 0;
  hunterDistance = 0;
  /** Continuous, not integer — it eases toward your lane rather than snapping. */
  hunterLane = 0;
  /** True when the round ended by hitting a wall, for the render/results flavour. */
  crashed = false;
  /** True when the round ended because the hunter caught you. */
  caught = false;

  /** Radius of the most recent clap's wavefront, for the render to animate. */
  lastClapRadius = 0;
  /** Distance the most recent clap originated at. */
  lastClapDistance = 0;
  /** Bumped on every clap so the render can notice a new one even mid-frame. */
  clapSeq = 0;

  private elapsed = 0;
  private nextIndex = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  reset(): void {
    this.phase = 'ready';
    this.score = 0;
    this.distance = 0;
    this.lane = Math.floor(this.config.lanes / 2);
    this.elapsed = 0;
    this.alertness = 0;
    this.hunterDistance = -this.config.hunterStartGap;
    this.hunterLane = this.lane;
    this.nextIndex = 0;
    this.celebration = 0;
    this.crashed = false;
    this.caught = false;
    this.lastClapRadius = 0;
    this.lastClapDistance = 0;
    this.clapSeq = 0;
    this.forks = [];
    // A little clear corridor before the first fork, so a round never opens
    // with a choice you had no chance to clap for.
    for (let i = 0; i < 6; i++) {
      this.spawn((2 + i) * this.config.spacing);
    }
  }

  /** Move one lane, clamped to the corridor. Called from a tap, not a Frame —
   *  works in any phase, since positioning before the first clap is free. */
  steer(direction: -1 | 1): void {
    this.lane = Math.min(this.config.lanes - 1, Math.max(0, this.lane + direction));
  }

  speed(): number {
    return Math.min(
      this.config.maxSpeed,
      this.config.startSpeed + this.score * this.config.speedPerScore,
    );
  }

  /** The fork you're heading for, or null past the end of the spawned run. */
  nextFork(): Fork | null {
    for (const fork of this.forks) {
      if (!fork.passed) return fork;
    }
    return null;
  }

  update(dt: number, input: Input): void {
    this.celebration = Math.max(0, this.celebration - dt * 3);

    if (this.phase === 'ready') {
      // A round starts on your first clap — the same verb that drives the
      // whole game, so there's nothing new to learn to begin.
      if (input.onset) {
        this.phase = 'playing';
        this.clap(input.level);
      }
      return;
    }
    if (this.phase !== 'playing') return;

    this.elapsed += dt;
    this.distance += this.speed() * dt;

    if (input.onset) this.clap(input.level);
    this.alertness = Math.max(0, this.alertness - this.config.hunterAlertDecay * dt);
    this.updateHunter(dt);

    this.checkForks();
    if (this.phase === 'playing') this.checkCaught();
    this.spawnAhead();
    this.dropBehind();
  }

  private clap(level: number): void {
    const radius = this.config.wavefrontBaseRadius + this.config.wavefrontBonus * level;
    this.lastClapRadius = radius;
    this.lastClapDistance = this.distance;
    this.clapSeq++;
    this.alertness = Math.min(1, this.alertness + this.config.hunterAlertGain * level);

    for (const fork of this.forks) {
      if (fork.revealed || fork.passed) continue;
      const ahead = fork.x - this.distance;
      if (ahead >= 0 && ahead <= radius) fork.revealed = true;
    }
  }

  private updateHunter(dt: number): void {
    const speed = this.config.hunterBaseSpeed + this.alertness * this.config.hunterAlertSpeedBonus;
    this.hunterDistance += speed * dt;

    // A deterministic wobble, not real randomness, so a round replays the same
    // way from the same inputs — see the class doc comment. It collapses to
    // zero as alertness rises, so a locked-on hunter beelines instead of
    // wandering.
    const wander = (1 - this.alertness) * this.config.hunterWander * Math.sin(this.elapsed * 1.3);
    const targetLane = this.lane + wander;
    const chaseRate = this.config.hunterChaseBase + this.alertness * this.config.hunterChaseBonus;
    const blend = 1 - Math.exp(-chaseRate * dt);
    this.hunterLane += (targetLane - this.hunterLane) * blend;
  }

  private checkForks(): void {
    for (const fork of this.forks) {
      if (fork.passed) continue;
      if (fork.x - this.distance > 0) continue;
      fork.passed = true;
      if (fork.openLane !== this.lane) {
        this.phase = 'over';
        this.crashed = true;
        return;
      }
      this.score++;
      this.celebration = 1;
    }
  }

  private checkCaught(): void {
    const gap = Math.abs(this.distance - this.hunterDistance);
    const laneGap = Math.abs(this.lane - this.hunterLane);
    if (gap <= this.config.catchDistance && laneGap <= this.config.catchLaneTolerance) {
      this.phase = 'over';
      this.caught = true;
    }
  }

  private spawn(x: number): void {
    const index = this.nextIndex++;
    this.forks.push({
      x,
      // A rotating, not random, pattern — see the class doc comment — that
      // still avoids the same lane twice in a row for lanes >= 2.
      openLane: (index * 2 + 1) % this.config.lanes,
      revealed: false,
      passed: false,
    });
  }

  private spawnAhead(): void {
    const last = this.forks[this.forks.length - 1];
    if (last && last.x - this.distance < 6 * this.config.spacing) {
      this.spawn(last.x + this.config.spacing);
    }
  }

  private dropBehind(): void {
    // Drop forks well behind the player so the array can't grow without bound.
    while (this.forks.length > 0 && this.forks[0].x - this.distance < -2) {
      this.forks.shift();
    }
  }
}
