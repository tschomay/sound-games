/**
 * Drop Siege's rules, kept free of rendering and of the microphone so the whole
 * thing can be reasoned about (and tested) by feeding it numbers.
 *
 * The idea (`docs/ideas.md` B2): "wave structure derived from song structure;
 * the drop is a boss wave." That is the whole game. A `SongStructure`
 * (`engine/sections.ts`) is handed in once, before play starts — `configureTrack`
 * — because knowing the whole track in advance is exactly what file-only buys
 * this game over every mic-capable one (ADR-0013). Each `Section` becomes one
 * wave: its `intensity` (0..1, relative to the track) sets how many enemies
 * arrive and how fast they queue up, quieter sections trickling a couple in and
 * intense ones swarming. Whichever section the structure calls the drop becomes
 * the boss wave — a single tough enemy, distinct from the regular spawns.
 *
 * **`dropIndex: null` does not mean no boss.** ADR-0013 is explicit that a
 * track can honestly have no section that stands out by its own cautious
 * margin (a lo-fi loop, a flat master) and says a game wanting a boss wave
 * regardless should make its own, less cautious call rather than have the
 * engine invent one. `resolveBossSection` does exactly that: fall back to
 * whichever section is loudest, however slim the lead. Every track — even the
 * single-section "no structure found" case — gets exactly one boss wave.
 *
 * **Beat still gates the one player verb.** Same split as Rhythm-Gated
 * Combat and Sonar Maze (ADR-0006): `strike(lane)` is a tap, not a Frame
 * field, and it only lands inside the beat window — `Frame.beat`/`bands` gate
 * and flavour it, never carry it. Enemies also still move on the beat, not on
 * `dt`, for the same reason RGC's do: a discrete beat-locked hop is what
 * "moves on the beat" is supposed to mean, and smoothing it into continuous
 * motion would be lying about what drives it.
 *
 * **Lanes are the new part.** Enemies spawn into one of three lanes chosen by
 * which band dominates at spawn — the same texture role `bands` plays in RGC,
 * now also a position, not just a kind. `strike(lane)` only hits an enemy in
 * the tapped lane, so the player has to read *where* a threat is as well as
 * *when* to hit it — the "positioning" flavour this game's brief allows for,
 * layered on top of (not instead of) the beat gate. The boss ignores lane
 * approach rules — it spawns in the centre lane and is a legal target for its
 * whole approach, not just the last couple of steps, so a fixed number of
 * beats is genuinely enough to kill it before it arrives; see
 * `Config.bossAttackRange`.
 *
 * **The round ends when the track does, not only on defeat.** Every other
 * game in this project runs until the player loses; this one is scored
 * against one finite, authored track, so reaching the end of it with any
 * health left is a win (`defeated` stays false), not just a stopping point.
 */
import type { RoundPhase } from '../../engine/game';
import type { SongStructure } from '../../engine/sections';
import type { Bands } from '../../engine/types';

export type EnemyKind = 'brute' | 'grunt' | 'sprite' | 'boss';
/** 0 is the bass lane, 1 the centre/mid lane (also where the boss always
 *  spawns), 2 the high lane — top-to-bottom on screen is high-to-bass, so a
 *  player's ear and eye agree on where a threat should be. */
export type Lane = 0 | 1 | 2;

export interface Enemy {
  id: number;
  kind: EnemyKind;
  lane: Lane;
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
  /** Max steps away a regular enemy can be and still be a legal attack target. */
  attackRange: number;
  /** Same, for the boss — deliberately as large as its own `spawnSteps`, so it
   *  is a legal target for its entire approach rather than only its last few
   *  steps, which is what makes a fixed `hitsToKill` actually killable in the
   *  beats available. */
  bossAttackRange: number;
  maxEnemies: number;

  /** Regular-wave enemy count at a section's `intensity` 0 and 1. */
  minWaveSize: number;
  maxWaveSize: number;
  /** Beats between spawns within one wave, at intensity 0 and 1 — more intense
   *  sections queue enemies faster, not just more of them. */
  maxSpawnEveryBeats: number;
  minSpawnEveryBeats: number;
  /** Regular enemies that arrive alongside the boss itself, sized the same way
   *  a wave is but fixed rather than scaled — the boss section is already the
   *  track's most intense by construction. */
  bossEscortSize: number;

  enemyStats: Record<EnemyKind, EnemyStats>;
}

export const DEFAULT_CONFIG: Config = {
  startHealth: 5,
  minConfidenceToStart: 0.3,
  readyHoldSeconds: 0.4,
  hitWindowFraction: 0.2,
  attackRange: 2,
  bossAttackRange: 10,
  maxEnemies: 18,

  minWaveSize: 2,
  maxWaveSize: 8,
  maxSpawnEveryBeats: 4,
  minSpawnEveryBeats: 1,
  bossEscortSize: 6,

  enemyStats: {
    // Bass-heavy moments spawn a tank in the bass lane: slower to arrive,
    // takes two hits, hurts more if it lands. Same kind taxonomy as RGC.
    brute: { spawnSteps: 6, hitsToKill: 2, damage: 2, killScore: 30 },
    // The neutral default, in the centre lane — also what a frame with no
    // standout band picks.
    grunt: { spawnSteps: 4, hitsToKill: 1, damage: 1, killScore: 10 },
    // High-heavy moments spawn something quick in the high lane: less
    // warning, but a single hit clears it.
    sprite: { spawnSteps: 3, hitsToKill: 1, damage: 1, killScore: 15 },
    // Ten beats of warning and always a legal target (see `bossAttackRange`)
    // is what makes six hits actually gettable before it arrives.
    boss: { spawnSteps: 10, hitsToKill: 6, damage: 3, killScore: 200 },
  },
};

/** What the game needs from a Frame, plus playback position — nothing more,
 *  so tests need no audio and no real file. Mirrors `BeatReading`'s fields
 *  plus `bands`, same as RGC's `Input`; `strike()` carries the tap itself, not
 *  this shape. */
export interface Input {
  bpm: number | null;
  beatPhase: number | null;
  onBeat: boolean;
  confidence: number;
  beatIndex: number | null;
  bands: Bands;
  /** Seconds into the file — `FileSource.position()` — for locating which
   *  section is playing right now. */
  positionSeconds: number;
}

/** How close to the end of the track counts as "the track is over" — a hair
 *  of slack for float drift in `positionSeconds`, not a real gameplay window. */
const TRACK_END_EPSILON = 0.1;

/** `grunt` is the neutral default and lands in the centre lane; a frame with
 *  no standout band (including a silent one) spawns it, not an arbitrary
 *  tie-break winner. */
function laneAndKind(bands: Bands): { lane: Lane; kind: EnemyKind } {
  const mid = (bands.mid + bands.lowMid) / 2;
  if (bands.bass > mid && bands.bass >= bands.high) return { lane: 0, kind: 'brute' };
  if (bands.high > mid && bands.high > bands.bass) return { lane: 2, kind: 'sprite' };
  return { lane: 1, kind: 'grunt' };
}

/** Enemy count for a regular wave at this section's intensity. */
function waveSize(config: Config, intensity: number): number {
  return Math.round(config.minWaveSize + intensity * (config.maxWaveSize - config.minWaveSize));
}

/** Beats between spawns within a wave at this section's intensity — more
 *  intense sections queue faster, down to the floor. */
function spawnInterval(config: Config, intensity: number): number {
  const beats = config.maxSpawnEveryBeats - intensity * (config.maxSpawnEveryBeats - config.minSpawnEveryBeats);
  return Math.max(config.minSpawnEveryBeats, Math.round(beats));
}

/**
 * Which section is the boss wave. `structure.dropIndex` when the engine found
 * one; otherwise the loudest section regardless of margin — B2's own,
 * deliberately less cautious call, per ADR-0013's own suggestion. `null` only
 * for a structure with no sections at all (a zero-length buffer).
 */
function resolveBossSection(structure: SongStructure): number | null {
  if (structure.sections.length === 0) return null;
  if (structure.dropIndex !== null) return structure.dropIndex;
  let best = 0;
  for (let i = 1; i < structure.sections.length; i++) {
    if (structure.sections[i].loudnessDb > structure.sections[best].loudnessDb) best = i;
  }
  return best;
}

/** Which section `seconds` falls in. Clamps to the last section past the end
 *  of the track rather than returning `null`, so a frame landing exactly on
 *  the final sample still resolves to something. */
function sectionIndexAt(structure: SongStructure, seconds: number): number | null {
  const sections = structure.sections;
  if (sections.length === 0) return null;
  for (const section of sections) {
    if (seconds < section.endSeconds) return section.index;
  }
  return sections[sections.length - 1].index;
}

export class DropSiege {
  phase: RoundPhase = 'ready';
  score = 0;
  health = 0;
  enemies: Enemy[] = [];
  /** True only when health hit zero — a track finishing with health left is
   *  `phase === 'over'` with this still false, the win case. */
  defeated = false;
  /** True the beat the boss is killed — render/results flavour. */
  bossDefeated = false;

  /** The whole track's structure, set once by `configureTrack` and preserved
   *  across `reset()` — replaying the same track should not re-run the
   *  analysis or lose the boss's location. */
  structure: SongStructure | null = null;
  bossSectionIndex: number | null = null;
  currentSectionIndex: number | null = null;

  /** This frame's beat reading, stashed so `strike()` — called from a tap
   *  event, not from `update()` — can judge its own timing against the most
   *  recent one. */
  bpm: number | null = null;
  beatPhase: number | null = null;
  confidence = 0;
  beatIndex: number | null = null;
  onBeatFlag = false;
  positionSeconds = 0;

  /** Set on a killing blow, decays to zero — render hook for a hit flash. */
  attackFlash = 0;
  /** Set on a swing that connected but didn't kill, decays. */
  glanceFlash = 0;
  /** Set on a whiffed strike (off-beat, or on-beat with nothing in that lane), decays. */
  missFlash = 0;
  /** Set the beat an enemy lands a hit, decays — render hook for player damage. */
  hurtFlash = 0;
  /** Set the frame the current section changes — render hook for a "new wave" pulse. */
  waveStartFlash = 0;

  /** Seconds of game time elapsed while playing — render-only, for animation. */
  elapsed = 0;

  private lockedFor = 0;
  private beatsSinceSpawn = 0;
  private enemiesSpawnedInSection = 0;
  private bossSpawnedForSection = false;
  private nextEnemyId = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  /** Hand the game the whole track's structure, once, before play starts.
   *  Safe to call again (a fresh `create()` per round means it normally
   *  isn't), which is why it resets the section-tracking fields itself rather
   *  than relying on `reset()` to have done it. */
  configureTrack(structure: SongStructure): void {
    this.structure = structure;
    this.bossSectionIndex = resolveBossSection(structure);
    this.currentSectionIndex = null;
    this.enemiesSpawnedInSection = 0;
    this.beatsSinceSpawn = 0;
    this.bossSpawnedForSection = false;
  }

  reset(): void {
    this.phase = 'ready';
    this.score = 0;
    this.health = this.config.startHealth;
    this.enemies = [];
    this.defeated = false;
    this.bossDefeated = false;
    // structure/bossSectionIndex deliberately survive a reset — see the field doc.
    this.currentSectionIndex = null;
    this.bpm = null;
    this.beatPhase = null;
    this.confidence = 0;
    this.beatIndex = null;
    this.onBeatFlag = false;
    this.positionSeconds = 0;
    this.attackFlash = 0;
    this.glanceFlash = 0;
    this.missFlash = 0;
    this.hurtFlash = 0;
    this.waveStartFlash = 0;
    this.elapsed = 0;
    this.lockedFor = 0;
    this.beatsSinceSpawn = 0;
    this.enemiesSpawnedInSection = 0;
    this.bossSpawnedForSection = false;
    this.nextEnemyId = 0;
  }

  update(dt: number, input: Input): void {
    this.attackFlash = Math.max(0, this.attackFlash - dt * 3);
    this.glanceFlash = Math.max(0, this.glanceFlash - dt * 3);
    this.missFlash = Math.max(0, this.missFlash - dt * 3);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2);
    this.waveStartFlash = Math.max(0, this.waveStartFlash - dt * 1.5);

    this.bpm = input.bpm;
    this.beatPhase = input.beatPhase;
    this.confidence = input.confidence;
    this.beatIndex = input.beatIndex;
    this.onBeatFlag = input.onBeat;
    this.positionSeconds = input.positionSeconds;

    if (this.phase === 'ready') {
      this.tryStart(dt, input);
      return;
    }
    if (this.phase !== 'playing') return;

    this.elapsed += dt;
    this.updateCurrentSection(input.positionSeconds);

    if (this.structure && input.positionSeconds >= this.structure.duration - TRACK_END_EPSILON) {
      // The track ran out, not the player's health — a win, not a loss.
      this.phase = 'over';
      return;
    }

    if (input.onBeat) this.onBeatTick(input.bands);
  }

  /** Strike the tapped lane now — a tap, not a Frame field, same split RGC
   *  and Sonar Maze use. Lands only inside the beat window, and only on the
   *  nearest attackable enemy in that lane. */
  strike(lane: Lane): void {
    if (this.phase !== 'playing') return;
    if (!this.inHitWindow()) {
      this.missFlash = 1;
      return;
    }
    const target = this.nearestAttackable(lane);
    if (!target) {
      this.missFlash = 1; // on beat, but nothing legal in that lane
      return;
    }
    target.hitsRemaining--;
    if (target.hitsRemaining <= 0) {
      this.enemies = this.enemies.filter((enemy) => enemy !== target);
      this.score += this.config.enemyStats[target.kind].killScore;
      this.attackFlash = 1;
      if (target.kind === 'boss') this.bossDefeated = true;
    } else {
      this.glanceFlash = 1;
    }
  }

  private inHitWindow(): boolean {
    if (this.beatPhase === null) return false;
    const w = this.config.hitWindowFraction;
    return this.beatPhase <= w || this.beatPhase >= 1 - w;
  }

  private nearestAttackable(lane: Lane): Enemy | null {
    let best: Enemy | null = null;
    for (const enemy of this.enemies) {
      if (enemy.lane !== lane) continue;
      const range = enemy.kind === 'boss' ? this.config.bossAttackRange : this.config.attackRange;
      if (enemy.steps > range) continue;
      if (!best || enemy.steps < best.steps) best = enemy;
    }
    return best;
  }

  private tryStart(dt: number, input: Input): void {
    const locked =
      this.structure !== null &&
      input.bpm !== null &&
      input.confidence >= this.config.minConfidenceToStart;
    if (locked) {
      this.lockedFor += dt;
      if (this.lockedFor >= this.config.readyHoldSeconds) {
        this.phase = 'playing';
        // Establish the starting wave immediately, so a track that opens
        // straight into its boss section (the degenerate single-section
        // case) still spawns something on the very first beat rather than
        // waiting for a section change that will never come.
        this.updateCurrentSection(input.positionSeconds);
      }
    } else {
      this.lockedFor = 0;
    }
  }

  private updateCurrentSection(positionSeconds: number): void {
    if (!this.structure) return;
    const index = sectionIndexAt(this.structure, positionSeconds);
    if (index === this.currentSectionIndex) return;
    this.currentSectionIndex = index;
    this.enemiesSpawnedInSection = 0;
    this.beatsSinceSpawn = 0;
    this.bossSpawnedForSection = false;
    this.waveStartFlash = 1;
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

    this.trySpawnForSection(bands);
  }

  private trySpawnForSection(bands: Bands): void {
    if (this.currentSectionIndex === null || !this.structure) return;
    const section = this.structure.sections[this.currentSectionIndex];
    if (!section) return;
    const isBoss = this.currentSectionIndex === this.bossSectionIndex;

    if (isBoss && !this.bossSpawnedForSection) {
      this.bossSpawnedForSection = true;
      this.spawnBoss();
      return; // the boss itself arrives on the wave's first beat; escorts follow like a regular wave
    }

    const target = isBoss ? this.config.bossEscortSize : waveSize(this.config, section.intensity);
    if (this.enemiesSpawnedInSection >= target) return;

    this.beatsSinceSpawn++;
    if (this.beatsSinceSpawn < spawnInterval(this.config, section.intensity)) return;
    this.beatsSinceSpawn = 0;
    if (this.enemies.length >= this.config.maxEnemies) return;
    this.spawnEnemy(bands);
    this.enemiesSpawnedInSection++;
  }

  private spawnEnemy(bands: Bands): void {
    const { lane, kind } = laneAndKind(bands);
    const stats = this.config.enemyStats[kind];
    this.enemies.push({
      id: this.nextEnemyId++,
      kind,
      lane,
      steps: stats.spawnSteps,
      hitsRemaining: stats.hitsToKill,
      lastStepAt: this.elapsed,
    });
  }

  private spawnBoss(): void {
    const stats = this.config.enemyStats.boss;
    this.enemies.push({
      id: this.nextEnemyId++,
      kind: 'boss',
      lane: 1,
      steps: stats.spawnSteps,
      hitsRemaining: stats.hitsToKill,
      lastStepAt: this.elapsed,
    });
  }
}
