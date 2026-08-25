/**
 * Quiet Passage's rules, kept free of rendering and of the microphone so the
 * whole thing can be reasoned about (and tested) by feeding it numbers.
 *
 * The idea (`docs/ideas.md` B8): a puzzle-platformer with no jump verb at all.
 * The player's vertical position is never an input — it is *set*, every
 * frame, directly by how loud the track currently is (`chaseHeight`, using
 * the same exponential-chase technique `overtone/game.ts`'s `chaseBrightness`
 * uses for its own live-signal-to-position smoothing, so one jittery frame
 * doesn't snap the player around). Loud pins you down near the floor
 * (`height` near 0); quiet lifts you toward the hazard ceiling above
 * (`height` near 1), where the only way through is a gap `loudness.ts`
 * already placed for you, in the right lane, before the round started.
 * Unlike Overtone's own chase, this one only runs once `phase === 'playing'`
 * — see `update`'s own comment for why a 'ready'-phase reading here is a
 * paused source's silence, not real signal.
 *
 * **Live and offline read the same signal, on purpose.** `chaseHeight` reads
 * `Frame.level` every frame; `loudness.ts`'s offline pass computed
 * `quietLevelThreshold` from windowed RMS run through the *same*
 * `normaliseLevel` calibration. For a file source these are the same audio,
 * so the two should agree closely — a live dip below `quietLevelThreshold`
 * is (almost always) exactly the kind of dip the offline pass would also
 * have called quiet. `isHazardHit`'s own doc comment says where that
 * agreement is inexact and why that's an accepted risk, not a bug.
 *
 * **Lane-switching is the one real verb, and it is gated by the same
 * threshold.** `switchLane` only takes effect while `Frame.level` is at or
 * below `quietLevelThreshold` — loud passages lock whatever lane you're
 * already in. That is the whole puzzle: a gap's lane is only ever revealed
 * (and only ever changeable into) during the quiet stretch that opens it, so
 * lining up has to happen *during* the quiet passage, not before it and not
 * by reflex once the ceiling is already bearing down. Same tap-not-Frame-field
 * split every other game's verb uses (ADR-0006).
 *
 * **The round ends when the track does, not only on a hit** — same shape as
 * Drop Siege: reaching the end of the file with no hit taken is a win
 * (`defeated` stays false), a hit at any point is an immediate hard fail
 * (same posture as Overtone/Clap Runner — one hit, not a meter), whichever
 * comes first.
 */
import type { RoundPhase } from '../../engine/game';
import type { QuietPassageLevel } from './loudness';

/** 0-based lane index, `< level.laneCount` once a level is configured. */
export type Lane = number;

export interface Config {
  /** How fast `height` chases the loudness-derived target — same exponential
   *  chase shape as Overtone's `brightnessResponsiveness`, tuned so a
   *  genuinely quiet stretch (long enough that `loudness.ts` would place a
   *  gap for it, `minQuietSeconds` plus its own lead-in) has time to actually
   *  carry `height` up into the hazard zone, while a too-brief dip mostly
   *  doesn't. That coupling is a tuning bet, not a proof — see
   *  `isHazardHit`'s own comment. */
  heightResponsiveness: number;
  /** Seconds the level has to be ready before 'ready' becomes 'playing' — a
   *  short, fixed hold (there is no live signal to lock onto here, unlike
   *  Drop Siege's beat confidence) just so the round doesn't start on the
   *  exact frame the offline pass finishes. */
  readyHoldSeconds: number;
  /** Lane the player starts (and re-centres after a reset) in, and the
   *  fallback lane count before any level has been configured. Matches
   *  `loudness.ts`'s `DEFAULT_LEVEL_CONFIG.laneCount`. */
  laneCount: number;
}

export const DEFAULT_CONFIG: Config = {
  heightResponsiveness: 3.2,
  readyHoldSeconds: 0.5,
  laneCount: 3,
};

/** What the game needs from a Frame, plus playback position — nothing more,
 *  so tests need no audio and no real file. Mirrors Drop Siege's own `Input`
 *  shape: live detector output plus `FileSource.position()`. */
export interface Input {
  /** `Frame.level` — already calibration-normalised, the same scale the
   *  offline pass's `quietLevelThreshold` is on. */
  level: number;
  /** Seconds into the file — `FileSource.position()`. Read directly, never
   *  independently accumulated, so a gap authored at a given second of the
   *  track always arrives under the player exactly when that second plays. */
  positionSeconds: number;
}

const TRACK_END_EPSILON = 0.1;

export class QuietPassage {
  phase: RoundPhase = 'ready';
  /** The whole track's level, set once by `configureTrack` and preserved
   *  across `reset()` — replaying the same track should not re-run the
   *  offline analysis or reshuffle its gaps. */
  level: QuietPassageLevel | null = null;

  lane: Lane = 0;
  /** 0 = pinned low against the floor (always safe), 1 = at the hazard
   *  ceiling (safe only inside an open gap in the current lane). Driven
   *  entirely by `chaseHeight` — there is no verb that sets this directly. */
  height = 0;
  positionSeconds = 0;
  /** The furthest `positionSeconds` this round ever reached — see `score`. */
  furthestSeconds = 0;
  /** True only on a hazard hit — a track finishing with no hit is
   *  `phase === 'over'` with this still false, the win case. */
  defeated = false;

  /** Set on an accepted lane switch, decays — render hook. */
  laneSwitchFlash = 0;
  /** Set on a tap that was ignored for being too loud, decays — render hook,
   *  so a rejected switch reads as "not now", not as "nothing happened". */
  laneRejectFlash = 0;
  /** Set the frame a hazard hit ends the round, decays — render hook. */
  hurtFlash = 0;

  /** This frame's `Input.level`, stashed so `switchLane` — called from a tap
   *  event, not from `update()` — can judge itself against the most recent
   *  reading, same split Drop Siege's `strike()` uses for its beat reading. */
  private currentLevel = 0;
  private lockedFor = 0;

  constructor(readonly config: Config = DEFAULT_CONFIG) {
    this.reset();
  }

  /**
   * Furthest position reached, as a percentage of the track's duration —
   * not raw seconds or world units. Two reasons: it stays comparable across
   * replays regardless of a track's exact length, and (the brief's own
   * requirement) it stays meaningful on a run that ends in defeat, since
   * "furthest reached" is always a positive number to beat next time, unlike
   * a pass/fail or a count of gaps cleared, which a death mid-gap would
   * report as zero.
   */
  get score(): number {
    if (!this.level || this.level.durationSeconds <= 0) return 0;
    return clamp01(this.furthestSeconds / this.level.durationSeconds) * 100;
  }

  /** Hand the game the whole track's level, once, before play starts. Safe to
   *  call again (a fresh `create()` per round means it normally isn't). */
  configureTrack(level: QuietPassageLevel): void {
    this.level = level;
    this.lane = startingLane(level.laneCount);
  }

  reset(): void {
    this.phase = 'ready';
    // level deliberately survives a reset — see the field doc.
    this.lane = startingLane(this.level?.laneCount ?? this.config.laneCount);
    this.height = 0;
    this.positionSeconds = 0;
    this.furthestSeconds = 0;
    this.defeated = false;
    this.laneSwitchFlash = 0;
    this.laneRejectFlash = 0;
    this.hurtFlash = 0;
    this.currentLevel = 0;
    this.lockedFor = 0;
  }

  update(dt: number, input: Input): void {
    this.laneSwitchFlash = Math.max(0, this.laneSwitchFlash - dt * 3);
    this.laneRejectFlash = Math.max(0, this.laneRejectFlash - dt * 3);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2);

    this.currentLevel = input.level;

    if (this.phase === 'ready') {
      this.tryStart(dt);
      return;
    }
    if (this.phase !== 'playing') return;

    // Chased only once actually playing — deliberately *not* Overtone's own
    // "chase even in 'ready'" precedent. Overtone's source is never paused,
    // so a 'ready' reading is real signal; here `index.ts` pauses the file
    // for the whole analysis pass and the ready-hold after it, so a 'ready'
    // `Frame.level` is just silence from a stopped source, not the track
    // being quiet. Chasing that would pre-lift `height` toward the ceiling
    // before a single real second has played, and the round could open with
    // a hazard hit before the player has heard a note.
    this.chaseHeight(dt, input.level);
    this.positionSeconds = input.positionSeconds;
    this.furthestSeconds = Math.max(this.furthestSeconds, this.positionSeconds);

    if (this.level && this.positionSeconds >= this.level.durationSeconds - TRACK_END_EPSILON) {
      // The track ran out, not a hazard hit — a win, not a loss.
      this.phase = 'over';
      return;
    }

    if (this.isHazardHit()) {
      this.phase = 'over';
      this.defeated = true;
      this.hurtFlash = 1;
    }
  }

  /**
   * Switch lanes now — a tap, not a Frame field, same split every other
   * game's verb uses (ADR-0006). Only takes effect while the track is quiet
   * enough to hear yourself think (`currentLevel <= quietLevelThreshold`):
   * loud passages lock the lane you're already in. A tap made while loud is
   * not queued or buffered for later, just dropped — the same "ignored, not
   * penalised" shape Sonar Maze's off-target steer and RGC's whiff use for an
   * input that simply doesn't apply right now.
   */
  switchLane(lane: Lane): void {
    if (this.phase !== 'playing' || !this.level) return;
    if (this.currentLevel > this.level.quietLevelThreshold) {
      this.laneRejectFlash = 1;
      return;
    }
    this.lane = lane;
    this.laneSwitchFlash = 1;
  }

  private chaseHeight(dt: number, level: number): void {
    const target = 1 - clamp01(level);
    const blend = 1 - Math.exp(-this.config.heightResponsiveness * dt);
    this.height += (target - this.height) * blend;
  }

  private tryStart(dt: number): void {
    if (!this.level) {
      this.lockedFor = 0;
      return;
    }
    this.lockedFor += dt;
    if (this.lockedFor >= this.config.readyHoldSeconds) this.phase = 'playing';
  }

  /**
   * True when the player is up in the hazard zone and nothing currently
   * covers their lane there.
   *
   * `hazardHeightThreshold` is `1 - quietLevelThreshold` — exactly the
   * `height` a `level == quietLevelThreshold` reading chases toward, so
   * "loud enough to be outside the hazard zone" and "loud enough to fail the
   * offline pass's own quiet test" are, by construction, the same boundary.
   * That is what makes a live dip only ever dangerous over ground the
   * offline pass already called survivable — but it is not a hard fairness
   * proof. A live dip briefer than `minQuietSeconds` never got a gap
   * authored for it at all; what mostly keeps it from being fatal anyway is
   * `heightResponsiveness` being tuned slow enough that `height` hasn't
   * finished rising into the hazard zone before a too-short dip ends. That
   * is a tuning bet, not a guarantee — the same "feel judgement no test
   * suite settles" ideas.md names as this game's own risk.
   */
  private isHazardHit(): boolean {
    if (!this.level) return false;
    const hazardHeightThreshold = 1 - this.level.quietLevelThreshold;
    if (this.height < hazardHeightThreshold) return false;
    const covered = this.level.gaps.some(
      (gap) =>
        gap.lane === this.lane &&
        this.positionSeconds >= gap.startSeconds &&
        this.positionSeconds <= gap.endSeconds,
    );
    return !covered;
  }
}

/** The middle lane, rounding down — the most neutral place to start (or
 *  re-centre after a reset) before any gap has told the player where to be. */
function startingLane(laneCount: number): Lane {
  return Math.floor(Math.max(1, laneCount) / 2);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
