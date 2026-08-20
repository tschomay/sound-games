/**
 * Rhythm-Gated Combat's rules, kept free of rendering and of the microphone so
 * the whole thing can be reasoned about (and tested) by feeding it numbers.
 *
 * The idea (`docs/ideas.md` B1): you can only attack on the beat of whatever's
 * playing, and enemies also move on beat. That is the whole game — the music
 * changes the player's *verb*, not just the visuals. Two independent inputs
 * drive it, same split as Sonar Maze (ADR-0006): `Frame.beat` gates *when* an
 * attack can land, and a tap — `attack()`, a plain method, not a Frame field —
 * is *what* lands it. `bands` plays a secondary role only: which enemy kind
 * spawns. The beat-gating is the point; bands is texture on top of it, never a
 * second gate.
 *
 * **Enemies move on the beat, not on `dt`.** Every `onBeat` edge — never a
 * per-frame tick — every live enemy takes exactly one step closer; one that
 * steps to zero lands a hit and is gone. This is deliberately *not* smoothed:
 * a discrete hop locked to `onBeat` is what "moves on beat" means here, and
 * smoothing it into continuous motion would be lying about what's actually
 * driving it. `attack()` kills the nearest enemy within `attackRange` steps —
 * so there are a couple of beats' warning before a given enemy is lethal —
 * but only if the tap lands inside the timing window around a beat instant.
 *
 * **The timing window is forgiving on purpose.** ADR-0010 is explicit that
 * real beat tracking — especially the causal mic tracker — is "mushy", not
 * exact, so `hitWindowFraction` is a real span of the beat period on both
 * sides of the beat instant, not a knife-edge single frame. It does not widen
 * or narrow by source or by `confidence`: the rules are identical on mic and
 * file, so a player's actual verbs don't change depending on what they're
 * playing into. What *does* differ by source is a rendering-only concern
 * (the file path's look-ahead telegraph) that lives in `index.ts`, not here —
 * see that file's doc comment.
 *
 * A round doesn't start until the beat is confidently locked — `bpm` known
 * and `confidence` past a floor, held for a beat — the same "wait for a
 * trustworthy signal" precedent every prior game's `ready` phase uses,
 * generalised to the one signal this game cares about most.
 */
import type { RoundPhase } from '../../engine/game';
import type { Bands } from '../../engine/types';

export type EnemyKind = 'brute' | 'grunt' | 'sprite';

export interface Enemy {
  id: number;
  kind: EnemyKind;
  /** Beats remaining until it reaches the player. Decreases by 1 on every `onBeat`. */
  steps: number;
  hitsRemaining: number;
  /** Game-`elapsed` timestamp of its last step, for a render pop that decays. */
  lastStepAt: number;
}

export interface EnemyStats {
  /** Steps away from the player it spawns at — beats of warning before it hits. */
  spawnSteps: number;
  hitsToKill: number;
  damage: number;
  killScore: number;
}

export interface Config {
  startHealth: number;
  /** `confidence` floor before a beat lock counts as trustworthy enough to start on. */
  minConfidenceToStart: number;
  /** Seconds the lock has to hold before `ready` becomes `playing`. */
  readyHoldSeconds: number;
  /** Fraction of the beat period, each side of the beat instant, that counts as "on beat". */
  hitWindowFraction: number;
  /** Max steps away an enemy can be and still be a legal attack target. */
  attackRange: number;
  maxEnemies: number;
  /** Beats between spawns at score 0. */
  spawnEveryBeats: number;
  /** Floor the spawn interval can't shrink past, how ever high the score gets. */
  minSpawnEveryBeats: number;
  /** Beats shaved off the spawn interval per point of score. */
  spawnIntervalPerScore: number;
  enemyStats: Record<EnemyKind, EnemyStats>;
}

export const DEFAULT_CONFIG: Config = {
  startHealth: 5,
  minConfidenceToStart: 0.3,
  readyHoldSeconds: 0.4,
  hitWindowFraction: 0.2,
  attackRange: 2,
  maxEnemies: 12,
  spawnEveryBeats: 4,
  minSpawnEveryBeats: 2,
  spawnIntervalPerScore: 0.05,
  enemyStats: {
    // Bass-heavy moments spawn a tank: slower to arrive, takes two hits, hurts
    // more if it lands.
    brute: { spawnSteps: 6, hitsToKill: 2, damage: 2, killScore: 30 },
    // The default/neutral kind — also what a frame with no strong band picks.
    grunt: { spawnSteps: 4, hitsToKill: 1, damage: 1, killScore: 10 },
    // High-heavy moments spawn something quick: less warning, but a single hit
    // clears it and it stings less.
    sprite: { spawnSteps: 3, hitsToKill: 1, damage: 1, killScore: 15 },
  },
};

/** What the game needs from a Frame — nothing more, so tests need no audio.
 *  Mirrors `BeatReading`'s own fields plus `bands`; the attack itself comes
 *  through `attack()`, not through this shape — see the class doc comment. */
export interface Input {
  bpm: number | null;
  beatPhase: number | null;
  onBeat: boolean;
  confidence: number;
  beatIndex: number | null;
  bands: Bands;
}

/** `grunt` is the neutral default: a frame with no standout band (including a
 *  silent one) spawns it, not an arbitrary tie-break winner. */
function dominantKind(bands: Bands): EnemyKind {
  const mid = (bands.mid + bands.lowMid) / 2;
  if (bands.bass > mid && bands.bass >= bands.high) return 'brute';
  if (bands.high > mid && bands.high > bands.bass) return 'sprite';
  return 'grunt';
}

export class RhythmGatedCombat {
  phase: RoundPhase = 'ready';
  score = 0;
  health = 0;
  enemies: Enemy[] = [];
  /** True once health hits zero, for the render/results flavour. */
  defeated = false;

  /** This frame's beat reading, stashed so `attack()` — called from a tap
   *  event, not from `update()` — can judge its own timing against the most
   *  recent one. */
  bpm: number | null = null;
  beatPhase: number | null = null;
  confidence = 0;
  beatIndex: number | null = null;
  /** True only on the frame `update()` saw an `onBeat` edge — for the render's flash. */
  onBeatFlag = false;

  /** Set on a killing blow, decays to zero — render hook for a hit flash. */
  attackFlash = 0;
  /** Set on a swing that connected but didn't kill (a brute took a hit), decays. */
  glanceFlash = 0;
  /** Set on a whiffed attack (off-beat, or on-beat with nothing in range), decays. */
  missFlash = 0;
  /** Set the beat an enemy lands a hit, decays — render hook for player damage. */
  hurtFlash = 0;

  /** Seconds of game time elapsed while playing — render-only, for animation. */
  elapsed = 0;

  private lockedFor = 0;
  private beatsSinceSpawn = 0;
  private nextEnemyId = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  reset(): void {
    this.phase = 'ready';
    this.score = 0;
    this.health = this.config.startHealth;
    this.enemies = [];
    this.defeated = false;
    this.bpm = null;
    this.beatPhase = null;
    this.confidence = 0;
    this.beatIndex = null;
    this.onBeatFlag = false;
    this.attackFlash = 0;
    this.glanceFlash = 0;
    this.missFlash = 0;
    this.hurtFlash = 0;
    this.elapsed = 0;
    this.lockedFor = 0;
    this.beatsSinceSpawn = 0;
    this.nextEnemyId = 0;
  }

  update(dt: number, input: Input): void {
    this.attackFlash = Math.max(0, this.attackFlash - dt * 3);
    this.glanceFlash = Math.max(0, this.glanceFlash - dt * 3);
    this.missFlash = Math.max(0, this.missFlash - dt * 3);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2);

    this.bpm = input.bpm;
    this.beatPhase = input.beatPhase;
    this.confidence = input.confidence;
    this.beatIndex = input.beatIndex;
    this.onBeatFlag = input.onBeat;

    if (this.phase === 'ready') {
      this.tryStart(dt, input);
      return;
    }
    if (this.phase !== 'playing') return;

    this.elapsed += dt;
    if (input.onBeat) this.onBeatTick(input.bands);
  }

  /** Attack now — a tap, not a Frame field, same split Sonar Maze uses (ADR-0006).
   *  Lands only inside the beat window, and only on the nearest enemy in range. */
  attack(): void {
    if (this.phase !== 'playing') return;
    if (!this.inHitWindow()) {
      this.missFlash = 1;
      return;
    }
    const target = this.nearestAttackable();
    if (!target) {
      this.missFlash = 1; // on beat, but nothing in range to hit
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

  private inHitWindow(): boolean {
    if (this.beatPhase === null) return false;
    const w = this.config.hitWindowFraction;
    return this.beatPhase <= w || this.beatPhase >= 1 - w;
  }

  private nearestAttackable(): Enemy | null {
    let best: Enemy | null = null;
    for (const enemy of this.enemies) {
      if (enemy.steps > this.config.attackRange) continue;
      if (!best || enemy.steps < best.steps) best = enemy;
    }
    return best;
  }

  private tryStart(dt: number, input: Input): void {
    const locked = input.bpm !== null && input.confidence >= this.config.minConfidenceToStart;
    if (locked) {
      this.lockedFor += dt;
      if (this.lockedFor >= this.config.readyHoldSeconds) this.phase = 'playing';
    } else {
      this.lockedFor = 0;
    }
  }

  private onBeatTick(bands: Bands): void {
    const arriving: Enemy[] = [];
    for (const enemy of this.enemies) {
      enemy.steps--;
      enemy.lastStepAt = this.elapsed;
      if (enemy.steps <= 0) arriving.push(enemy);
    }
    if (arriving.length > 0) {
      for (const enemy of arriving) {
        this.health = Math.max(0, this.health - this.config.enemyStats[enemy.kind].damage);
      }
      this.hurtFlash = 1;
      const arrivedIds = new Set(arriving.map((enemy) => enemy.id));
      this.enemies = this.enemies.filter((enemy) => !arrivedIds.has(enemy.id));
    }

    if (this.health <= 0) {
      this.phase = 'over';
      this.defeated = true;
      return;
    }

    this.beatsSinceSpawn++;
    if (this.beatsSinceSpawn >= this.spawnInterval()) {
      this.beatsSinceSpawn = 0;
      if (this.enemies.length < this.config.maxEnemies) this.spawnEnemy(bands);
    }
  }

  private spawnInterval(): number {
    const shrink = this.score * this.config.spawnIntervalPerScore;
    return Math.max(this.config.minSpawnEveryBeats, this.config.spawnEveryBeats - shrink);
  }

  private spawnEnemy(bands: Bands): void {
    const kind = dominantKind(bands);
    const stats = this.config.enemyStats[kind];
    this.enemies.push({
      id: this.nextEnemyId++,
      kind,
      steps: stats.spawnSteps,
      hitsRemaining: stats.hitsToKill,
      lastStepAt: this.elapsed,
    });
  }
}
