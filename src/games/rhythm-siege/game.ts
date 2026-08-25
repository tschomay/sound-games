/**
 * Rhythm Siege's rules, kept free of rendering and of the microphone so the
 * whole thing can be reasoned about (and tested) by feeding it numbers.
 *
 * The idea (`docs/ideas.md` B6): a 3-lane tower defense that is purely
 * reactive to whatever's live, no look-ahead and no whole-track analysis —
 * `onset` events are classified on the spot by which `bands` value dominates
 * at that instant, and `Frame.beat.bpm` (tempo only, never phase) sets how
 * fast everything already spawned marches in. Put a different track on
 * mid-round and both the enemy mix and the march speed change on the spot.
 *
 * **Not a duplicate of either sibling beat-driven game.** Rhythm-Gated Combat
 * gates *when* its one verb lands — only inside a beat window — and steps
 * enemies in discrete beat-locked hops. Drop Siege paces *wave structure*
 * from a whole track's authored shape, read once before the round starts,
 * file-only. Rhythm Siege gates neither: `strike(lane)` always lands, no
 * beat window, no `Frame.beat.beatPhase`/`onBeat` read at all — and enemies
 * move continuously over `dt`, a real march rather than a hop, because
 * nothing here is meant to read as "stepping on the beat." Instead, a live
 * per-onset drum classification decides *what* spawns, and a live (possibly
 * unlocked, possibly zero-confidence) tempo estimate decides *how fast*
 * everything closes in — degrading to a fixed default march speed rather
 * than stalling when no tempo can be found, the same "an unlocked signal
 * still produces a playable game" posture Ecosystem Garden already takes
 * toward `bands` with no beat tracking available at all.
 *
 * **Classification is a real dominance test, not a tie-break.** A bass-heavy
 * onset (`bands.bass` clearly ahead of the high signal) spawns a slow, tough
 * Heavy; a high-heavy onset (`bands.high`, or `bands.mid`+`bands.high`
 * together, clearly ahead of bass) spawns a fast, fragile Swarm — several of
 * them, since Swarm spawns arrive in a small cluster. "Clearly ahead" means a
 * real margin (`Config.dominanceMargin`) the leading signal has to clear over
 * the other, not just being the frame's raw maximum by a hair, and both
 * signals additionally have to clear `Config.minSignal` at all — otherwise a
 * quiet, ambiguous, or genuinely 50/50 onset spawns nothing rather than
 * noise. `classifyOnset` is exported so the test suite can drive it directly
 * with `bands` fixtures.
 *
 * **Spawn cooldowns, one per classification.** `onset` already only fires on
 * a rising edge (the transient detector's own edge, not this game's), but a
 * busy, cymbal-heavy passage can still throw a lot of qualifying onsets in a
 * short span. Each classification gets its own cooldown timer that decays
 * every frame — the same rising-edge-with-cooldown shape Ecosystem Garden's
 * scare detector and Quiet Game's distraction window both use — so one loud
 * passage spawns a wave, not an unplayable wall.
 *
 * **The player verb never reads `bands`, `bpm`, or `onset` at all.**
 * `strike(lane)` is a tap, not a Frame field — same split as every other
 * tap-driven game in this project (ADR-0006) — and it always lands: no
 * timing window, no phase check. It hits whichever living enemy is nearest
 * the player's line in the tapped lane, if any.
 *
 * **Score is enemies defeated, not survival time.** Survival time would be a
 * function of whatever track happens to be playing (a fast, busy track
 * empties a player's health bar quicker than a sparse one, independent of
 * how well they're playing) rather than of how well the player is landing
 * hits. Weighting by kind (a Heavy is worth more than a Swarm) rewards taking
 * down the tougher threat, same reasoning Rhythm-Gated Combat and Drop Siege
 * already apply to their own `killScore`.
 */
import type { RoundPhase } from '../../engine/game';
import type { Bands } from '../../engine/types';

export type EnemyKind = 'heavy' | 'swarm';

/** 0 is the top lane, 1 the middle, 2 the bottom — purely positional, unlike
 *  Drop Siege's lanes, which also carry a band-to-lane mapping; here `bands`
 *  only decides *what* spawns, never *where*. */
export type Lane = 0 | 1 | 2;

export interface Enemy {
  id: number;
  kind: EnemyKind;
  lane: Lane;
  /** 0 at spawn, 1 at the player's line. Advances by `marchSpeed * dt` every
   *  frame while playing — real motion over `dt`, not a beat-stepped hop. */
  progress: number;
  hitsRemaining: number;
  /** Game-`elapsed` timestamp of its spawn, for a render pop-in. */
  spawnedAt: number;
}

export interface EnemyStats {
  hitsToKill: number;
  /** Health lost if it reaches the player's line. */
  damage: number;
  killScore: number;
  /** Multiplier on the shared march speed — Heavy is slower, Swarm is faster. */
  speedMultiplier: number;
}

export interface Config {
  maxHealth: number;

  /** Any level above this counts as "there is sound" at all, the trigger to
   *  leave `ready` — the same presence gate Ecosystem Garden and Overtone
   *  use, generalised here since this game has no beat lock to wait for. */
  presenceThreshold: number;
  /** Seconds of sustained presence before 'ready' becomes 'playing'. */
  readyHoldTime: number;

  /** How far the leading signal has to clear the other before an onset counts
   *  as dominant enough to classify — not a bare epsilon over the frame max. */
  dominanceMargin: number;
  /** Floor either signal has to clear before it's a real candidate at all —
   *  keeps a near-silent onset from spawning anything. */
  minSignal: number;

  /** Seconds between Heavy spawns, however many bass-dominant onsets arrive. */
  heavySpawnCooldown: number;
  /** Seconds between Swarm spawns (each one a whole cluster). */
  swarmSpawnCooldown: number;
  /** Enemies spawned per Swarm-classified onset. */
  swarmClusterSize: number;
  maxEnemies: number;

  /** March speed (progress/second) used whenever `bpm` is null or below
   *  `minConfidenceForBpm` — the graceful-degradation floor that keeps the
   *  round moving with no beat lock at all. */
  fallbackMarchSpeed: number;
  /** March speed per BPM once `bpm` is known and trusted. Chosen so that at
   *  the project's tempo-prior centre (120 BPM, see `engine/beat.ts`) it
   *  matches `fallbackMarchSpeed` exactly — the fallback isn't a slower
   *  "safe" speed, it's a stand-in for an unremarkable tempo. */
  marchSpeedPerBpm: number;
  /** `confidence` floor before `bpm` is trusted for march speed at all. */
  minConfidenceForBpm: number;

  enemyStats: Record<EnemyKind, EnemyStats>;
}

export const DEFAULT_CONFIG: Config = {
  maxHealth: 10,

  presenceThreshold: 0.06,
  readyHoldTime: 0.5,

  dominanceMargin: 0.15,
  minSignal: 0.08,

  heavySpawnCooldown: 0.7,
  swarmSpawnCooldown: 0.7,
  swarmClusterSize: 3,
  maxEnemies: 40,

  fallbackMarchSpeed: 0.12,
  marchSpeedPerBpm: 0.001, // 0.12 at 120 BPM — see the field doc for why that's deliberate
  minConfidenceForBpm: 0.35,

  enemyStats: {
    // Bass-dominant onsets: slow, tanky, hurts more if it reaches the line.
    heavy: { hitsToKill: 3, damage: 3, killScore: 30, speedMultiplier: 0.65 },
    // High-dominant onsets: quick, one hit each, stings less individually —
    // but arrives in a cluster (`swarmClusterSize`), so there are more of them.
    swarm: { hitsToKill: 1, damage: 1, killScore: 10, speedMultiplier: 1.5 },
  },
};

/** What the game needs from a Frame — nothing more, so tests need no audio.
 *  Only `bpm` comes through from `Frame.beat`, deliberately: this game reads
 *  tempo, never phase or the beat edge (`docs/ideas.md` B6's own detector
 *  list) — the tap is ungated, so there is nothing for a phase to gate. */
export interface Input {
  onset: boolean;
  bands: Bands;
  level: number;
  bpm: number | null;
  confidence: number;
}

/** `bands.high` alone, or `mid`+`high` averaged together, whichever reads
 *  louder — either is a legitimate "high end is dominant" signal per the
 *  design brief, so the classifier takes the stronger of the two. */
function highSignal(bands: Bands): number {
  return Math.max(bands.high, (bands.mid + bands.high) / 2);
}

/**
 * Classifies one onset instant, or returns `null` for "spawn nothing." A real
 * margin test, not a tie-break off the frame's raw maximum: the leading
 * signal has to clear both `minSignal` (so a near-silent onset can't qualify
 * at all) and clear the other signal by `dominanceMargin` (so a genuinely
 * ambiguous, roughly-50/50 onset spawns nothing rather than an arbitrary
 * pick). Exported so the test suite can drive it directly with `Bands`
 * fixtures, independent of the cooldown/spawn machinery around it.
 */
export function classifyOnset(bands: Bands, config: Config): EnemyKind | null {
  const bass = bands.bass;
  const high = highSignal(bands);
  if (bass < config.minSignal && high < config.minSignal) return null;
  if (bass - high >= config.dominanceMargin) return 'heavy';
  if (high - bass >= config.dominanceMargin) return 'swarm';
  return null;
}

/** March speed (progress/second) for this frame's tempo reading — the
 *  graceful-degradation function itself. Known, confident `bpm` scales the
 *  speed; anything else (`bpm === null`, or `confidence` below the floor)
 *  falls back to a fixed default rather than freezing the game. */
export function marchSpeed(bpm: number | null, confidence: number, config: Config): number {
  if (bpm !== null && confidence >= config.minConfidenceForBpm) {
    return bpm * config.marchSpeedPerBpm;
  }
  return config.fallbackMarchSpeed;
}

export class RhythmSiege {
  phase: RoundPhase = 'ready';
  score = 0;
  health = 0;
  enemies: Enemy[] = [];
  /** True once health hits zero, for the render/results flavour. */
  defeated = false;

  /** This frame's beat/tempo reading, stashed for the render's HUD. */
  bpm: number | null = null;
  confidence = 0;

  /** Set on a killing blow, decays to zero — render hook for a hit flash. */
  attackFlash = 0;
  /** Set on a strike that connected but didn't kill (a Heavy took a hit), decays. */
  glanceFlash = 0;
  /** Set on a whiffed tap (nothing alive in that lane), decays. */
  missFlash = 0;
  /** Set the frame an enemy reaches the player's line, decays. */
  hurtFlash = 0;

  /** Seconds of game time elapsed while playing — render-only, for animation. */
  elapsed = 0;

  private presenceFor = 0;
  private heavyCooldownRemaining = 0;
  private swarmCooldownRemaining = 0;
  private nextEnemyId = 0;
  /** A fixed round-robin, not real randomness, so a round is reproducible —
   *  same "deterministic, no RNG" precedent Ecosystem Garden's placement and
   *  Sonar Maze's fork pattern already use. */
  private nextLaneSeq = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  reset(): void {
    this.phase = 'ready';
    this.score = 0;
    this.health = this.config.maxHealth;
    this.enemies = [];
    this.defeated = false;
    this.bpm = null;
    this.confidence = 0;
    this.attackFlash = 0;
    this.glanceFlash = 0;
    this.missFlash = 0;
    this.hurtFlash = 0;
    this.elapsed = 0;
    this.presenceFor = 0;
    this.heavyCooldownRemaining = 0;
    this.swarmCooldownRemaining = 0;
    this.nextEnemyId = 0;
    this.nextLaneSeq = 0;
  }

  update(dt: number, input: Input): void {
    this.attackFlash = Math.max(0, this.attackFlash - dt * 3);
    this.glanceFlash = Math.max(0, this.glanceFlash - dt * 3);
    this.missFlash = Math.max(0, this.missFlash - dt * 3);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2);

    this.bpm = input.bpm;
    this.confidence = input.confidence;
    this.heavyCooldownRemaining = Math.max(0, this.heavyCooldownRemaining - dt);
    this.swarmCooldownRemaining = Math.max(0, this.swarmCooldownRemaining - dt);

    if (this.phase === 'ready') {
      this.tryStart(dt, input);
      return;
    }
    if (this.phase !== 'playing') return;

    this.elapsed += dt;
    this.advanceEnemies(dt, input);
    if (input.onset) this.trySpawn(input.bands);
  }

  /** Strike the tapped lane now — a tap, not a Frame field. Always lands (no
   *  timing gate); hits the nearest living enemy in that lane, if any. */
  strike(lane: Lane): void {
    if (this.phase !== 'playing') return;
    const target = this.nearestInLane(lane);
    if (!target) {
      this.missFlash = 1; // nothing alive in that lane
      return;
    }
    target.hitsRemaining--;
    if (target.hitsRemaining <= 0) {
      this.enemies = this.enemies.filter((enemy) => enemy !== target);
      this.score += this.config.enemyStats[target.kind].killScore;
      this.attackFlash = 1;
    } else {
      this.glanceFlash = 1;
    }
  }

  private nearestInLane(lane: Lane): Enemy | null {
    let best: Enemy | null = null;
    for (const enemy of this.enemies) {
      if (enemy.lane !== lane) continue;
      if (!best || enemy.progress > best.progress) best = enemy;
    }
    return best;
  }

  private tryStart(dt: number, input: Input): void {
    // Starts on presence alone, not a beat lock — this game never needs one:
    // see `marchSpeed`'s fallback for what an absent/unconfident `bpm` does
    // once playing.
    if (input.level >= this.config.presenceThreshold) {
      this.presenceFor += dt;
      if (this.presenceFor >= this.config.readyHoldTime) this.phase = 'playing';
    } else {
      this.presenceFor = 0;
    }
  }

  private advanceEnemies(dt: number, input: Input): void {
    const base = marchSpeed(input.bpm, input.confidence, this.config);
    const arriving: Enemy[] = [];
    for (const enemy of this.enemies) {
      const speed = base * this.config.enemyStats[enemy.kind].speedMultiplier;
      enemy.progress = Math.min(1, enemy.progress + speed * dt);
      if (enemy.progress >= 1) arriving.push(enemy);
    }
    if (arriving.length === 0) return;

    for (const enemy of arriving) {
      this.health = Math.max(0, this.health - this.config.enemyStats[enemy.kind].damage);
    }
    this.hurtFlash = 1;
    const arrivedIds = new Set(arriving.map((enemy) => enemy.id));
    this.enemies = this.enemies.filter((enemy) => !arrivedIds.has(enemy.id));

    if (this.health <= 0) {
      this.phase = 'over';
      this.defeated = true;
    }
  }

  private trySpawn(bands: Bands): void {
    const kind = classifyOnset(bands, this.config);
    if (kind === null) return;
    if (this.enemies.length >= this.config.maxEnemies) return;

    if (kind === 'heavy') {
      if (this.heavyCooldownRemaining > 0) return;
      this.heavyCooldownRemaining = this.config.heavySpawnCooldown;
      this.spawnEnemy('heavy');
      return;
    }

    if (this.swarmCooldownRemaining > 0) return;
    this.swarmCooldownRemaining = this.config.swarmSpawnCooldown;
    for (let i = 0; i < this.config.swarmClusterSize; i++) {
      if (this.enemies.length >= this.config.maxEnemies) break;
      this.spawnEnemy('swarm');
    }
  }

  private spawnEnemy(kind: EnemyKind): void {
    const stats = this.config.enemyStats[kind];
    const lane = (this.nextLaneSeq++ % 3) as Lane;
    this.enemies.push({
      id: this.nextEnemyId++,
      kind,
      lane,
      progress: 0,
      hitsRemaining: stats.hitsToKill,
      spawnedAt: this.elapsed,
    });
  }
}
