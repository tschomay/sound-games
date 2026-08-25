/**
 * Conductor Boss's rules, kept free of rendering and of the microphone so the
 * whole thing can be reasoned about (and tested) by feeding it numbers.
 *
 * The idea (`docs/ideas.md` B7): a single boss arena where the boss's attacks
 * *are* the song, live — not scripted, not gated on a beat grid the way
 * Rhythm-Gated Combat's or Drop Siege's enemies are. A rising edge on
 * `bands.bass` telegraphs then executes a **ground slam**; a broadband
 * `onset` whose spectrum is *not* bass-dominant at the instant it fires
 * telegraphs then executes a **projectile**. Both detection shapes are
 * deliberately borrowed, not invented: the bass-hit rising-edge-with-cooldown
 * is the same shape `overtone/game.ts`'s `checkBassHit` uses, and "which band
 * actually dominates" is the same classification `drop-siege/game.ts`'s
 * `laneAndKind` and `rhythm-gated-combat/game.ts`'s `dominantKind` already use
 * for spawning — `isHigherBandDominant` below is this game's own small,
 * boolean-only version of that idea, per this brief's "reuse the same
 * classification approach... or write your own simple version".
 *
 * **Three lanes, not a ground/air split.** The brief allows either. Three
 * lanes wins here because it gives both attack types a comparably real read
 * instead of one of them degenerating into a coin flip: a ground slam clears
 * every lane but one designated *safe* lane (blind odds of guessing right:
 * 1 in 3), a projectile targets the player's *current* lane and is lethal
 * only there (blind odds of guessing safe: 2 in 3) — two differently-shaped
 * decisions that still share one input surface and one on-screen geometry,
 * copied wholesale from Drop Siege's `laneFromFraction`/`laneCenterY` tap
 * mapping (see `index.ts`). A 2-state ground/air split would collapse the
 * slam into a plain coin flip and give the projectile nothing comparable to
 * dodge sideways into, so the extra lane earns its complexity here.
 *
 * **One boss attack in flight at a time.** A telegraphed attack occupies
 * `this.attack` until it resolves; a fresh trigger detected while one is
 * already telegraphing or executing is simply not started (see
 * `tryTriggerAttack`). This keeps the telegraph→execute state machine (and
 * its tests) unambiguous — "what is the player dodging right now" always has
 * exactly one answer — and it still reads as "the music is attacking you"
 * rather than "the engine is attacking you", since a real track rarely stacks
 * a bass hit and a higher-band onset closely enough for the cap to matter
 * often.
 *
 * **The telegraph window is forgiving on purpose** — the same principle
 * `rhythm-gated-combat/game.ts`'s doc comment states for its own beat window
 * (ADR-0010): real, live audio detection is "mushy", not a scripted cue with
 * a knife-edge instant, so `windupSeconds` (see `Config`) is sized as a real
 * human reaction window, not a UI countdown grace period stapled on after the
 * fact. See that field's own comment for the concrete number and why.
 *
 * **Scoring counts successful counters, not boss health remaining.** Boss
 * health remaining is 0 for every win regardless of how close it was or how
 * many attacks were actually read correctly, and it's a meaningless 0 for
 * every loss too — neither number distinguishes a narrow win from a
 * dominant one, or a loss on the first attack from a loss on the tenth.
 * Counting successful counters instead gives a number that keeps meaning
 * whichever way the round ends, and it rewards the actual skill (correct
 * reads) rather than only the outcome.
 */
import type { RoundPhase } from '../../engine/game';
import type { Bands } from '../../engine/types';

/** Fixed at 3 — see the class doc comment for why not a 2-state ground/air split. */
export const LANE_COUNT = 3;
/** 0 is the bass/bottom lane, 1 the centre lane, 2 the high/top lane — same
 *  top-to-bottom-is-high-to-bass convention Drop Siege uses, so a player's
 *  ear and eye agree on where a threat sits. */
export type Lane = 0 | 1 | 2;

export type AttackKind = 'slam' | 'projectile';
export type AttackStage = 'telegraph' | 'executing';

export interface BossAttack {
  kind: AttackKind;
  stage: AttackStage;
  /** Seconds remaining in the current stage — counts down to 0, then the
   *  attack advances to its next stage (or clears, from 'executing'). */
  remaining: number;
  /** For 'slam': the one lane that stays safe when it lands. For
   *  'projectile': the lane it's targeting, captured the instant the
   *  telegraph started. */
  lane: Lane;
}

export interface Config {
  startHealth: number;
  bossStartHealth: number;

  /** `level` at/above this counts as "there is real sound to react to". */
  presenceThreshold: number;
  /** Seconds of sustained presence before 'ready' becomes 'playing'. */
  readyHoldSeconds: number;

  /** `bands.bass` at/above this counts toward a rising-edge bass hit. */
  bassThreshold: number;
  /** Minimum seconds between bass-triggered attacks — same cooldown shape as
   *  Overtone's `spawnCooldown` and Ecosystem Garden's predator pressure, so
   *  one sustained bass note can't spam slams. */
  bassCooldownSeconds: number;
  /** Minimum seconds between onset-triggered attacks, same reasoning. */
  onsetCooldownSeconds: number;

  /**
   * Seconds from telegraph to execution, for both attack types. Reasoned the
   * same way `clap-runner/game.ts`'s `jumpDuration` reasons about its own
   * timing: picked as a real number, not a round one. 220ms sits inside a
   * healthy simple-reaction-time budget for a sudden cue (untrained human
   * simple auditory reaction time is commonly cited around 150-200ms; 220ms
   * leaves a little real margin on top of that instead of demanding the
   * theoretical minimum) while still staying inside the roughly 100-300ms
   * window audio and a visual cue triggered by it still read as perceptually
   * tied together. Much longer and the wind-up would feel like a delayed UI
   * cue reacting to the music a beat late, not the music itself attacking —
   * which is the whole premise of this pitch (`docs/ideas.md` B7).
   */
  windupSeconds: number;
  /** Seconds the 'executing' visual stage holds after resolution before the
   *  attack clears — render-only pacing, not a fairness window (the hit or
   *  dodge was already decided the instant the telegraph ended, in
   *  `resolveAttack`). Long enough that a slam or projectile's impact
   *  actually reads on screen, short enough that it doesn't linger and mask
   *  the next telegraph. */
  executeFlashSeconds: number;

  /** Ground slam is the higher-stakes read: blind odds of already standing in
   *  the one safe lane are 1 in 3, worse than the projectile's 2-in-3 blind
   *  odds of *not* standing in its one lethal lane — so it both deals and is
   *  worth more. */
  slamPlayerDamage: number;
  slamBossCounterDamage: number;
  projectilePlayerDamage: number;
  projectileBossCounterDamage: number;
}

export const DEFAULT_CONFIG: Config = {
  startHealth: 5,
  bossStartHealth: 10,

  presenceThreshold: 0.06,
  readyHoldSeconds: 0.4,

  bassThreshold: 0.55,
  bassCooldownSeconds: 0.4,
  onsetCooldownSeconds: 0.4,

  windupSeconds: 0.22,
  executeFlashSeconds: 0.25,

  slamPlayerDamage: 2,
  slamBossCounterDamage: 2,
  projectilePlayerDamage: 1,
  projectileBossCounterDamage: 1,
};

/** What the game needs from a Frame — nothing more, so tests need no audio.
 *  Lane switching comes through `setLane()`, not this shape — see the class
 *  doc comment and ADR-0006. */
export interface Input {
  bands: Bands;
  onset: boolean;
  level: number;
}

/** Same "which band actually dominates" shape Drop Siege's `laneAndKind` and
 *  Rhythm-Gated Combat's `dominantKind` use for spawning, reduced to the one
 *  boolean this game needs: is the spectrum *not* bass-dominant right now?
 *  A frame with no standout band (including a silent one) is not classed as
 *  bass-dominant either, so it still counts as a legal projectile trigger —
 *  the neutral-default direction those games' `grunt`/mid-lane case leans,
 *  just expressed here as "not bass" rather than picking a third bucket. */
function isHigherBandDominant(bands: Bands): boolean {
  const mid = (bands.mid + bands.lowMid) / 2;
  const bassDominant = bands.bass > mid && bands.bass >= bands.high;
  return !bassDominant;
}

export class ConductorBoss {
  phase: RoundPhase = 'ready';
  score = 0;
  health = 0;
  bossHealth = 0;
  playerLane: Lane = 1;
  attack: BossAttack | null = null;

  /** True once player health hits zero — render/results flavour. */
  defeated = false;
  /** True once boss health hits zero. */
  victory = false;

  /** Set the frame the player takes a hit, decays — render hook. */
  hurtFlash = 0;
  /** Set the frame a dodge counters the boss, decays — render hook. */
  counterFlash = 0;

  /** Seconds of game time elapsed while playing — render-only, for animation. */
  elapsed = 0;

  private presenceFor = 0;
  private previousBass = 0;
  private lastBassTriggerAt = -Infinity;
  private lastOnsetTriggerAt = -Infinity;
  private nextSlamSeq = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  reset(): void {
    this.phase = 'ready';
    this.score = 0;
    this.health = this.config.startHealth;
    this.bossHealth = this.config.bossStartHealth;
    this.playerLane = 1;
    this.attack = null;
    this.defeated = false;
    this.victory = false;
    this.hurtFlash = 0;
    this.counterFlash = 0;
    this.elapsed = 0;
    this.presenceFor = 0;
    this.previousBass = 0;
    this.lastBassTriggerAt = -Infinity;
    this.lastOnsetTriggerAt = -Infinity;
    this.nextSlamSeq = 0;
  }

  /** Move to an absolute lane — a tap, not a Frame field, same split every
   *  other lane-driven game in this project uses (ADR-0006). Works in any
   *  phase, same as Sonar Maze's `steer()`: positioning before the first
   *  attack telegraphs is free. */
  setLane(lane: Lane): void {
    this.playerLane = lane;
  }

  update(dt: number, input: Input): void {
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2);
    this.counterFlash = Math.max(0, this.counterFlash - dt * 3);

    // Tracked every frame, ready or playing, so the very first frame of
    // 'playing' compares against the actual previous frame's bass level
    // rather than a stale 0 left over from construction — the same reason
    // this isn't computed only inside the 'playing' branch below.
    const bassCrossed =
      this.previousBass < this.config.bassThreshold && input.bands.bass >= this.config.bassThreshold;
    this.previousBass = input.bands.bass;

    if (this.phase === 'ready') {
      this.tryStart(dt, input);
      return;
    }
    if (this.phase !== 'playing') return;

    this.elapsed += dt;
    if (!this.attack) this.tryTriggerAttack(input, bassCrossed);
    this.advanceAttack(dt);
  }

  private tryStart(dt: number, input: Input): void {
    // The boss wakes up once there's actually sound to listen to — music
    // starting, or a room that isn't silent — same "start on your first
    // sustained sound" precedent every prior game's ready phase uses.
    if (input.level >= this.config.presenceThreshold) {
      this.presenceFor += dt;
      if (this.presenceFor >= this.config.readyHoldSeconds) this.phase = 'playing';
    } else {
      this.presenceFor = 0;
    }
  }

  /** Bass takes priority on a frame where both could fire — rare in practice
   *  (a full-mix onset landing on the exact same frame as a bass rising
   *  edge), and harmless either way since only one attack can be in flight
   *  at once (see the class doc comment). */
  private tryTriggerAttack(input: Input, bassCrossed: boolean): void {
    if (bassCrossed && this.elapsed - this.lastBassTriggerAt >= this.config.bassCooldownSeconds) {
      this.lastBassTriggerAt = this.elapsed;
      this.startSlam();
      return;
    }
    if (
      input.onset &&
      isHigherBandDominant(input.bands) &&
      this.elapsed - this.lastOnsetTriggerAt >= this.config.onsetCooldownSeconds
    ) {
      this.lastOnsetTriggerAt = this.elapsed;
      this.startProjectile();
    }
  }

  private startSlam(): void {
    // A rotating, not random, safe lane — same "deterministic, reproducible"
    // precedent as Sonar Maze's fork pattern and Ecosystem Garden's spawn
    // placement — independent of where the player currently stands, so
    // reading the telegraph is what keeps you safe, not memorising a fixed
    // pattern or exploiting your own starting position.
    const lane = (this.nextSlamSeq++ % LANE_COUNT) as Lane;
    this.attack = { kind: 'slam', stage: 'telegraph', remaining: this.config.windupSeconds, lane };
  }

  private startProjectile(): void {
    // Targets wherever the player is *right now* — the whole point is that
    // standing still is what makes it lethal.
    this.attack = {
      kind: 'projectile',
      stage: 'telegraph',
      remaining: this.config.windupSeconds,
      lane: this.playerLane,
    };
  }

  private advanceAttack(dt: number): void {
    if (!this.attack) return;
    this.attack.remaining -= dt;
    if (this.attack.remaining > 0) return;

    if (this.attack.stage === 'telegraph') {
      // The instant the wind-up runs out is exactly when the hit/dodge is
      // decided — see `resolveAttack`. The 'executing' stage that follows is
      // a render-only flash; it never re-checks the player's lane.
      this.resolveAttack(this.attack);
      this.attack.stage = 'executing';
      this.attack.remaining = this.config.executeFlashSeconds;
      return;
    }

    this.attack = null;
  }

  /** Did the player dodge it? Slam is lethal everywhere except its one safe
   *  lane; projectile is lethal only in its one targeted lane — see the
   *  class doc comment for why those are opposite-shaped reads. */
  private resolveAttack(attack: BossAttack): void {
    const hit = attack.kind === 'slam' ? this.playerLane !== attack.lane : this.playerLane === attack.lane;

    if (hit) {
      const damage = attack.kind === 'slam' ? this.config.slamPlayerDamage : this.config.projectilePlayerDamage;
      this.health = Math.max(0, this.health - damage);
      this.hurtFlash = 1;
      if (this.health <= 0) {
        this.phase = 'over';
        this.defeated = true;
      }
    } else {
      const damage =
        attack.kind === 'slam' ? this.config.slamBossCounterDamage : this.config.projectileBossCounterDamage;
      this.bossHealth = Math.max(0, this.bossHealth - damage);
      this.score += 1;
      this.counterFlash = 1;
      if (this.bossHealth <= 0) {
        this.phase = 'over';
        this.victory = true;
      }
    }
  }
}
