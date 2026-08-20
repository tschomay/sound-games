/**
 * Ecosystem Garden's rules, kept free of rendering and of the microphone so the
 * whole thing can be reasoned about (and tested) by feeding it numbers.
 *
 * The idea (`docs/ideas.md` B3) is a screensaver that has to earn being a game:
 * bass drives growth, mids spawn creatures, highs are weather, and loud passages
 * spawn predators that actively threaten the garden. This is the whole
 * management loop, and the only tool the player has to fight back is loudness
 * itself — a deliberate loud burst (a shout, a clap) scares every predator off,
 * the same threshold-crossing-on-`level` action `QuietGame` already uses for
 * its shout, just aimed at a different consequence. Only `bands` and `level`
 * are read here; no onset/pitch/timbre detector, by design (see the roadmap's
 * Phase 7 section) — a scare is detected as a rising edge on `level` crossing
 * `scareThreshold`, not `Frame.onset`.
 *
 * Plants are *not* a stored array: `growth` is one scalar 0..1, and how many of
 * `config.plantSlots` are in bloom (and how tall) is a pure function of that
 * scalar, recomputed by the render every frame. Only creatures and predators
 * need persistent per-individual state (they move), so those are the only two
 * arrays here, and both are capped — nothing in a multi-minute session grows
 * without bound.
 */
import type { RoundPhase } from '../../engine/game';
import type { Bands } from '../../engine/types';

export type Weather = 'sun' | 'wind' | 'rain';

export interface Creature {
  id: number;
  /** 0..1 garden-relative position, fixed at spawn; motion is animated in the render from these plus `id`/age. */
  x: number;
  y: number;
  spawnedAt: number;
}

export interface Predator {
  id: number;
  x: number;
  y: number;
  spawnedAt: number;
  /** Rises the longer it goes unmanaged — an unattended predator gets scarier
   *  and more dangerous, not just persistently annoying. */
  aggression: number;
  /** Set the instant a scare burst reaches it; counts down to despawn. */
  fleeing: boolean;
  fleeRemaining: number;
}

export interface Config {
  maxHealth: number;
  maxCreatures: number;
  maxPredators: number;
  /** How many fixed slots the render has to draw plants into. */
  plantSlots: number;

  /** Any level above this counts as "there is sound" at all. */
  presenceThreshold: number;
  /** Seconds of sustained presence before 'ready' becomes 'playing'. */
  readyHoldTime: number;

  /** Growth gained per second at bands.bass === 1, before creature/weather bonuses. */
  growthRate: number;
  /** Extra fractional growth rate per living creature — they pollinate. */
  creaturePollinateBonus: number;

  /** Spawn pressure gained per second at bands.mid === 1. */
  creatureSpawnRate: number;
  /** Pressure needed to spawn one creature. */
  creatureSpawnCost: number;

  /** Blend rate (per second) of the smoothed high band toward its raw value. */
  weatherSmoothing: number;
  windThreshold: number;
  rainThreshold: number;
  /** Rain multiplies the growth rate — the one place weather feeds back into growth. */
  rainGrowthMultiplier: number;
  /** Sun multiplies creature spawn pressure. */
  sunSpawnMultiplier: number;

  /** Level above this, sustained, is "a loud passage" that builds toward a predator. */
  predatorThreshold: number;
  /** Pressure gained per second at level === 1 above threshold. */
  predatorPressureRate: number;
  /** Pressure lost per second while under threshold. */
  predatorPressureDecay: number;
  /** Pressure needed to spawn one predator. */
  predatorSpawnCost: number;

  /** Health drained per second by one unmanaged predator, before aggression. */
  predatorBaseThreat: number;
  /** Extra threat/sec gained per second a predator goes unmanaged. */
  predatorAggressionGrowth: number;
  /** Seconds a scared predator spends fleeing before it's gone for good. */
  predatorFleeDuration: number;

  /** A level rising edge across this scares off every predator at once. */
  scareThreshold: number;
  /** Score bonus per predator successfully scared off. */
  scareScoreBonus: number;

  /** Health regained per second while no predator is actively threatening. */
  healthRegenRate: number;
  /** Score gained per second survived at full health; scales down with health,
   *  so a neglected, half-dead garden earns less than a thriving one. */
  scorePerSecondAtFullHealth: number;
}

export const DEFAULT_CONFIG: Config = {
  maxHealth: 100,
  maxCreatures: 24,
  maxPredators: 6,
  plantSlots: 28,

  presenceThreshold: 0.06,
  readyHoldTime: 0.5,

  growthRate: 0.02,
  creaturePollinateBonus: 0.03,

  creatureSpawnRate: 0.5,
  creatureSpawnCost: 1,

  weatherSmoothing: 0.6,
  windThreshold: 0.35,
  rainThreshold: 0.65,
  rainGrowthMultiplier: 1.6,
  sunSpawnMultiplier: 1.3,

  predatorThreshold: 0.55,
  predatorPressureRate: 0.6,
  predatorPressureDecay: 0.5,
  predatorSpawnCost: 1,

  predatorBaseThreat: 1.6,
  predatorAggressionGrowth: 0.35,
  predatorFleeDuration: 1.2,

  scareThreshold: 0.82,
  scareScoreBonus: 15,

  healthRegenRate: 1.2,
  scorePerSecondAtFullHealth: 4,
};

/** What the game needs from a Frame — nothing more, so tests need no audio. */
export interface Input {
  level: number;
  bands: Bands;
}

export class EcosystemGarden {
  phase: RoundPhase = 'ready';
  score = 0;
  health = 0;
  growth = 0;
  weather: Weather = 'sun';
  creatures: Creature[] = [];
  predators: Predator[] = [];
  /** True the round a predator finishes fleeing, for a one-frame render pulse. Decays to zero. */
  scareFlash = 0;
  /** True once health hits zero, for the render/results flavour. */
  destroyed = false;

  /** Seconds of game time elapsed while playing. */
  elapsed = 0;
  private presenceFor = 0;
  private creaturePressure = 0;
  private predatorPressure = 0;
  private smoothedHigh = 0;
  private previousLevel = 0;
  private nextCreatureId = 0;
  private nextPredatorId = 0;
  /** A fixed sequence, not real randomness, so a round is reproducible — same
   *  precedent as Sonar Maze's hunter wander and lane pattern. */
  private spawnSeq = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  reset(): void {
    this.phase = 'ready';
    this.score = 0;
    this.health = this.config.maxHealth;
    this.growth = 0;
    this.weather = 'sun';
    this.creatures = [];
    this.predators = [];
    this.scareFlash = 0;
    this.destroyed = false;
    this.elapsed = 0;
    this.presenceFor = 0;
    this.creaturePressure = 0;
    this.predatorPressure = 0;
    this.smoothedHigh = 0;
    this.previousLevel = 0;
    this.nextCreatureId = 0;
    this.nextPredatorId = 0;
    this.spawnSeq = 0;
  }

  update(dt: number, input: Input): void {
    this.scareFlash = Math.max(0, this.scareFlash - dt * 2);

    if (this.phase === 'ready') {
      // The garden wakes up once there's actually sound to listen to — music
      // starting, or a room that isn't silent — mirroring the "start on your
      // first sound" precedent every prior game uses, generalised to `level`
      // since that's all this game is allowed to read.
      if (input.level >= this.config.presenceThreshold) {
        this.presenceFor += dt;
        if (this.presenceFor >= this.config.readyHoldTime) this.phase = 'playing';
      } else {
        this.presenceFor = 0;
      }
      this.previousLevel = input.level;
      return;
    }
    if (this.phase !== 'playing') return;

    this.elapsed += dt;
    this.updateWeather(dt, input.bands.high);
    this.updateGrowth(dt, input.bands.bass);
    this.updateCreatures(dt, input.bands.mid);
    this.updatePredators(dt, input.level);
    this.checkScare(input.level);
    this.updateScore(dt);
    this.previousLevel = input.level;
  }

  private updateWeather(dt: number, high: number): void {
    const blend = 1 - Math.exp(-this.config.weatherSmoothing * dt);
    this.smoothedHigh += (high - this.smoothedHigh) * blend;
    this.weather =
      this.smoothedHigh >= this.config.rainThreshold
        ? 'rain'
        : this.smoothedHigh >= this.config.windThreshold
          ? 'wind'
          : 'sun';
  }

  private updateGrowth(dt: number, bass: number): void {
    const pollinate = 1 + this.creatures.length * this.config.creaturePollinateBonus;
    const weatherBonus = this.weather === 'rain' ? this.config.rainGrowthMultiplier : 1;
    this.growth = Math.min(1, this.growth + bass * this.config.growthRate * pollinate * weatherBonus * dt);
  }

  private updateCreatures(dt: number, mid: number): void {
    const weatherBonus = this.weather === 'sun' ? this.config.sunSpawnMultiplier : 1;
    this.creaturePressure += mid * this.config.creatureSpawnRate * weatherBonus * dt;
    // A carrying capacity, not a queue: pressure that arrives while the garden
    // is already full just dissipates instead of banking up. That's what keeps
    // the array bounded no matter how long or how loud the session runs.
    if (this.creaturePressure >= this.config.creatureSpawnCost) {
      if (this.creatures.length < this.config.maxCreatures) {
        this.spawnCreature();
      }
      this.creaturePressure = 0;
    }
  }

  private spawnCreature(): void {
    const seq = this.spawnSeq++;
    // Golden-ratio placement — same "deterministic, well-spread, no RNG"
    // precedent as Sonar Maze's fork pattern — so creatures don't clump.
    const x = (seq * 0.61803399) % 1;
    const y = 0.15 + ((seq * 0.37812) % 1) * 0.6;
    this.creatures.push({ id: this.nextCreatureId++, x, y, spawnedAt: this.elapsed });
  }

  private updatePredators(dt: number, level: number): void {
    if (level >= this.config.predatorThreshold) {
      this.predatorPressure += (level - this.config.predatorThreshold) * this.config.predatorPressureRate * dt;
    } else {
      this.predatorPressure = Math.max(0, this.predatorPressure - this.config.predatorPressureDecay * dt);
    }
    if (this.predatorPressure >= this.config.predatorSpawnCost) {
      if (this.predators.length < this.config.maxPredators) {
        this.spawnPredator();
      }
      this.predatorPressure = 0;
    }

    let anyThreatening = false;
    for (const predator of this.predators) {
      if (predator.fleeing) {
        predator.fleeRemaining -= dt;
        continue;
      }
      anyThreatening = true;
      predator.aggression += this.config.predatorAggressionGrowth * dt;
      const threat = this.config.predatorBaseThreat + predator.aggression;
      this.health = Math.max(0, this.health - threat * dt);
    }
    if (!anyThreatening) {
      this.health = Math.min(this.config.maxHealth, this.health + this.config.healthRegenRate * dt);
    }

    // Drop predators that finished fleeing, and cap the array either way —
    // this is what keeps a long, hostile session from growing the list forever.
    const before = this.predators.length;
    this.predators = this.predators.filter((p) => !p.fleeing || p.fleeRemaining > 0);
    const repelled = before - this.predators.length;
    if (repelled > 0) {
      this.score += repelled * this.config.scareScoreBonus;
      this.scareFlash = 1;
    }

    if (this.health <= 0) {
      this.phase = 'over';
      this.destroyed = true;
    }
  }

  private spawnPredator(): void {
    const seq = this.spawnSeq++;
    const fromLeft = seq % 2 === 0;
    this.predators.push({
      id: this.nextPredatorId++,
      x: fromLeft ? 0.05 : 0.95,
      y: 0.1 + ((seq * 0.54321) % 1) * 0.5,
      spawnedAt: this.elapsed,
      aggression: 0,
      fleeing: false,
      fleeRemaining: 0,
    });
  }

  private checkScare(level: number): void {
    const crossed = this.previousLevel < this.config.scareThreshold && level >= this.config.scareThreshold;
    if (!crossed) return;
    for (const predator of this.predators) {
      if (predator.fleeing) continue;
      predator.fleeing = true;
      predator.fleeRemaining = this.config.predatorFleeDuration;
    }
  }

  private updateScore(dt: number): void {
    const healthFraction = this.health / this.config.maxHealth;
    this.score += this.config.scorePerSecondAtFullHealth * healthFraction * dt;
  }
}
