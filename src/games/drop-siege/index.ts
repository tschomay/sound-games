/**
 * Drop Siege as the shell sees it: a definition, and a Game that owns only its
 * rules and its picture. Everything around it — the file gate, canvas, loop,
 * pausing, results, high scores — belongs to `screens/play.ts`.
 *
 * `sources: ['file']` — no mic option at all, the first game in the project
 * to omit it. The whole hook (`docs/ideas.md` B2) is seeing the boss coming
 * before it arrives, which needs the whole track decoded up front
 * (`engine/sections.ts`'s `analyseSongStructure`); a live mic stream cannot
 * offer that at any price. See `screens/source-picker.ts`'s `allowMic` option
 * and `screens/play.ts`'s call site — verified with a DOM test
 * (`screens/__tests__/source-picker.test.ts`) that a `sources: ['file']`-only
 * game actually renders a lone "Choose a file" button, not a silently
 * unusable mic one.
 *
 * **Analysing the structure is this game's own problem, not shared
 * plumbing's.** `source-picker.ts` already runs `analyseBeatGrid` for every
 * file (ADR-0011); `analyseSongStructure` also needs a beat grid but computes
 * its own if none is supplied, and `Session` has nowhere to carry one back
 * out to a game that wants it (only an opaque `BeatInput`). Rather than widen
 * `Session`/`openSession` for the one game that needs this, `DropSiegeGame`
 * reads `currentSession()?.source` itself (same pattern RGC already uses for
 * its look-ahead telegraph) and calls `analyseSongStructure` on the file's own
 * `AudioBuffer` once, lazily, the first `update()` after a session exists.
 * That costs a second, redundant beat-grid pass — measured at ~1.7s vs ~700ms
 * for a four-minute file per ADR-0013 — which is judged an acceptable
 * one-time cost against the alternative of changing shared session plumbing
 * for a single game's benefit.
 *
 * **Playback is paused for that analysis.** `play.ts`'s shell starts a file
 * playing the instant its session is ready, before this game gets any say —
 * so without intervention the track would run for a second or two of real
 * content while the game is still figuring out its own structure. This game
 * pauses the source itself the moment it notices a file session, and resumes
 * it only once the rules actually reach `'playing'` (structure loaded, beat
 * locked in) — the same "don't start losing content before the player can
 * react" instinct behind every other game's ready-hold, just reaching one
 * layer further out because this is the first game paying for a synchronous
 * pre-play analysis pass at all.
 */
import { DropSiege, type Enemy, type EnemyKind, type Lane } from './game';
import { currentSession } from '../../engine/session';
import { analyseSongStructure } from '../../engine/sections';
import { isFileSource, type FileSource } from '../../engine/source';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame } from '../../engine/types';

/** How long before the boss section arrives the warning banner appears. Long
 *  enough to be genuinely useful advance notice — the whole point of a
 *  file-only game — short enough that it doesn't sit on screen for the whole
 *  track. */
const BOSS_WARNING_SECONDS = 12;
/** Fraction of the canvas height the wave-preview timeline occupies. */
const TIMELINE_FRACTION = 0.14;
/** Enemy steps normalised against this for lane drawing — the boss's own
 *  `spawnSteps`, the longest any enemy travels, so nothing overshoots the lane. */
const MAX_LANE_STEPS = 10;
/** Fraction of the width the player's position ("the keep") sits at. */
const PLAYER_X = 0.14;

const ENEMY_COLOR: Record<EnemyKind, string> = {
  brute: '#f97316',
  grunt: '#94daff',
  sprite: '#facc15',
  boss: '#f43f5e',
};

/** High lane (2) on top, mid (1) in the middle, bass (0) on the bottom — a
 *  player's ear and eye agree on where a threat sits. */
const LANE_ORDER: readonly Lane[] = [2, 1, 0];

class DropSiegeGame implements Game {
  private readonly rules = new DropSiege();
  private structureState: 'idle' | 'analysing' | 'ready' = 'idle';
  private pausedForAnalysis = false;
  private boundCanvas: HTMLCanvasElement | null = null;

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return 'Analysing the track — then wait for the beat to lock in';
  }

  update(dt: number, frame: Frame): void {
    const source = this.fileSource();
    this.ensureStructure(source);

    const positionSeconds = source?.position() ?? 0;
    this.rules.update(dt, {
      bpm: frame.beat.bpm,
      beatPhase: frame.beat.beatPhase,
      onBeat: frame.beat.onBeat,
      confidence: frame.beat.confidence,
      beatIndex: frame.beat.beatIndex,
      bands: frame.bands,
      positionSeconds,
    });

    if (this.pausedForAnalysis && this.rules.phase === 'playing') {
      this.pausedForAnalysis = false;
      source?.play();
    }
  }

  reset(): void {
    this.rules.reset();
    // A fresh round replays the same track from the top — the whole point of
    // "wave structure derived from song structure" is the authored order,
    // which a round starting mid-track would scramble.
    const source = this.fileSource();
    if (source) {
      this.pausedForAnalysis = true;
      source.pause();
      source.seek(0);
    }
  }

  render(surface: Surface): void {
    this.attachInput(surface.canvas);
    render(surface, this.rules, this.structureState);
  }

  private fileSource(): FileSource | null {
    const session = currentSession();
    return session && isFileSource(session.source) ? session.source : null;
  }

  private ensureStructure(source: FileSource | null): void {
    if (!source || this.structureState !== 'idle') return;
    this.structureState = 'analysing';
    this.pausedForAnalysis = true;
    source.pause();
    // Yield one tick so the "Analysing…" overlay actually paints before the
    // synchronous pass below blocks the main thread — same trick
    // source-picker.ts already uses for the beat grid (ADR-0011).
    setTimeout(() => {
      const structure = analyseSongStructure(source.buffer);
      this.rules.configureTrack(structure);
      this.structureState = 'ready';
    }, 0);
  }

  private attachInput(canvas: HTMLCanvasElement): void {
    if (this.boundCanvas === canvas) return;
    this.boundCanvas = canvas;
    canvas.addEventListener('pointerdown', (event) => {
      const rect = canvas.getBoundingClientRect();
      const fraction = (event.clientY - rect.top) / rect.height;
      this.rules.strike(laneFromFraction(fraction));
    });
  }
}

/** Which lane a tap at this vertical fraction of the canvas selects — the
 *  inverse of `laneCenterY` below, so the tap zones line up with what's drawn.
 *  Clamped, so a tap on the timeline strip still resolves to the top (high) lane
 *  rather than nothing. */
function laneFromFraction(fraction: number): Lane {
  const span = 1 - TIMELINE_FRACTION;
  const zone = Math.min(2, Math.max(0, Math.floor(((fraction - TIMELINE_FRACTION) / span) * 3)));
  return LANE_ORDER[zone];
}

function laneCenterY(lane: Lane): number {
  const zone = LANE_ORDER.indexOf(lane);
  const span = 1 - TIMELINE_FRACTION;
  return TIMELINE_FRACTION + span * ((zone + 0.5) / 3);
}

export const dropSiege: GameDefinition = {
  id: 'drop-siege',
  title: 'Drop Siege',
  description:
    "Load a track and defend against waves shaped by its own structure — quiet sections trickle enemies in, loud ones swarm, and the track's biggest moment arrives as a boss you can see coming.",
  requires: 'room',
  sources: ['file'],
  intro:
    "Load a track. Its sections become waves — quiet ones send a few enemies, intense ones swarm — and its loudest section arrives as a boss. Enemies close in on the beat; tap the lane something's attacking from, on the beat, to strike it.",
  introDetail:
    'File only — this game reads the whole track before you press play, which is the one thing live mic can never do.',
  // No game audio of its own, and bands/beat are read continuously off the
  // file's own output — nothing here for headphones to protect, same
  // reasoning as Ecosystem Garden and Rhythm-Gated Combat.
  headphonesRecommended: false,
  accessibilityNote:
    'The only thing you personally do is tap a lane on the beat — striking never requires ' +
    'producing any sound yourself. It is file-only by design (the whole track is read in ' +
    'advance), so nothing here requires your voice or any sound from you at all.',
  readyPrompt: 'Wait for the analysis to finish and the beat to lock in',
  formatScore: (score) => `${Math.round(score)} point${Math.round(score) === 1 ? '' : 's'}`,
  create: (_profile: CalibrationProfile) => new DropSiegeGame(),
};

function render(surface: Surface, game: DropSiege, structureState: 'idle' | 'analysing' | 'ready'): void {
  const { ctx, width, height } = surface;
  ctx.fillStyle = '#0a0a10';
  ctx.fillRect(0, 0, width, height);

  drawHurtFlash(ctx, width, height, game.hurtFlash);

  if (structureState !== 'ready' || !game.structure) {
    drawAnalysing(ctx, width, height, structureState);
    return;
  }

  drawTimeline(ctx, width, height, game);
  drawLanes(ctx, width, height, game);
  drawAttackFeedback(ctx, width, height, game);
  drawBossWarning(ctx, width, height, game);
  drawHud(ctx, width, game);
}

function drawHurtFlash(ctx: CanvasRenderingContext2D, width: number, height: number, hurtFlash: number): void {
  if (hurtFlash <= 0) return;
  ctx.fillStyle = `rgba(248, 113, 113, ${hurtFlash * 0.25})`;
  ctx.fillRect(0, 0, width, height);
}

function drawAnalysing(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  structureState: 'idle' | 'analysing' | 'ready',
): void {
  ctx.fillStyle = 'rgba(232, 238, 246, 0.7)';
  ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = structureState === 'analysing' ? 'Analysing track structure…' : 'Waiting for a track…';
  ctx.fillText(text, width / 2, height / 2);
}

/**
 * The whole-track look-ahead this game is built around: every section drawn
 * as a bar sized by its own `intensity`, the boss section picked out in a
 * different colour, and a playhead sweeping across as the file plays. This is
 * the file-only advantage RGC's beat lane only gestures at a few beats out —
 * here the entire track's shape is known and shown before a single enemy
 * spawns.
 */
function drawTimeline(ctx: CanvasRenderingContext2D, width: number, height: number, game: DropSiege): void {
  const structure = game.structure;
  if (!structure || structure.duration <= 0) return;
  const margin = 14;
  const top = 8;
  const trackHeight = height * TIMELINE_FRACTION - top - 6;
  const innerWidth = width - margin * 2;
  const toX = (seconds: number) => margin + (seconds / structure.duration) * innerWidth;

  ctx.strokeStyle = 'rgba(232, 238, 246, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(margin, top, innerWidth, trackHeight);

  for (const section of structure.sections) {
    const x = toX(section.startSeconds);
    const w = Math.max(1, toX(section.endSeconds) - x);
    const barHeight = trackHeight * (0.15 + section.intensity * 0.85);
    const isBoss = section.index === game.bossSectionIndex;
    ctx.fillStyle = isBoss ? 'rgba(244, 63, 94, 0.75)' : 'rgba(148, 218, 255, 0.35)';
    ctx.fillRect(x, top + trackHeight - barHeight, w, barHeight);
    if (isBoss) {
      ctx.fillStyle = 'rgba(244, 63, 94, 0.95)';
      ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('BOSS', x + w / 2, top - 1);
    }
  }

  const playheadX = toX(game.positionSeconds);
  ctx.strokeStyle = 'rgba(232, 238, 246, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playheadX, top - 4);
  ctx.lineTo(playheadX, top + trackHeight + 4);
  ctx.stroke();
}

function drawLanes(ctx: CanvasRenderingContext2D, width: number, height: number, game: DropSiege): void {
  const playerX = width * PLAYER_X;
  const laneEnd = width - 16;

  for (const lane of LANE_ORDER) {
    const y = height * laneCenterY(lane);
    ctx.strokeStyle = 'rgba(232, 238, 246, 0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playerX, y);
    ctx.lineTo(laneEnd, y);
    ctx.stroke();

    const range = lane === 1 ? game.config.bossAttackRange : game.config.attackRange;
    const rangeX = playerX + (Math.min(range, MAX_LANE_STEPS) / MAX_LANE_STEPS) * (laneEnd - playerX);
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.14)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(playerX, y);
    ctx.lineTo(rangeX, y);
    ctx.stroke();

    drawKeepMarker(ctx, playerX, y, game);
  }

  for (const enemy of game.enemies) {
    drawEnemy(ctx, enemy, playerX, laneEnd, height, game.elapsed);
  }
}

function drawKeepMarker(ctx: CanvasRenderingContext2D, x: number, y: number, game: DropSiege): void {
  ctx.fillStyle = game.phase === 'over' && game.defeated ? '#f87171' : 'rgba(232, 238, 246, 0.7)';
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
}

function drawEnemy(
  ctx: CanvasRenderingContext2D,
  enemy: Enemy,
  playerX: number,
  laneEnd: number,
  height: number,
  elapsed: number,
): void {
  const y = height * laneCenterY(enemy.lane);
  const x = playerX + (Math.min(enemy.steps, MAX_LANE_STEPS) / MAX_LANE_STEPS) * (laneEnd - playerX);
  // A quick squash-pop right after it steps, so a beat-locked hop still reads
  // as motion rather than a silent teleport — same trick RGC's render uses.
  const age = elapsed - enemy.lastStepAt;
  const pop = Math.max(0, 1 - age * 5);
  const isBoss = enemy.kind === 'boss';
  const baseRadius = isBoss ? 16 : 8 + (enemy.hitsRemaining - 1) * 3;
  const radius = baseRadius * (1 + pop * 0.35);

  if (isBoss) {
    ctx.save();
    ctx.shadowColor = 'rgba(244, 63, 94, 0.6)';
    ctx.shadowBlur = 16;
  }
  ctx.fillStyle = ENEMY_COLOR[enemy.kind];
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  if (isBoss) ctx.restore();

  if (enemy.hitsRemaining > 1) {
    ctx.fillStyle = 'rgba(10, 10, 16, 0.85)';
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(enemy.hitsRemaining), x, y);
  }
}

function drawAttackFeedback(ctx: CanvasRenderingContext2D, width: number, height: number, game: DropSiege): void {
  const x = width * PLAYER_X;
  for (const lane of LANE_ORDER) {
    const y = height * laneCenterY(lane);
    if (game.attackFlash > 0) {
      ctx.strokeStyle = `rgba(74, 222, 128, ${game.attackFlash})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 14 + (1 - game.attackFlash) * 14, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (game.glanceFlash > 0) {
      ctx.strokeStyle = `rgba(250, 204, 21, ${game.glanceFlash})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 14 + (1 - game.glanceFlash) * 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (game.missFlash > 0) {
      ctx.strokeStyle = `rgba(148, 163, 184, ${game.missFlash * 0.5})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/**
 * The other half of the file-only look-ahead: a telegraph for the boss
 * specifically, not just the timeline's passive shape. Shows once the boss
 * section is within `BOSS_WARNING_SECONDS`, and switches to a steady label
 * once the wave has actually started — the moment the player no longer needs
 * warning, they need confirmation.
 */
function drawBossWarning(ctx: CanvasRenderingContext2D, width: number, height: number, game: DropSiege): void {
  const structure = game.structure;
  if (!structure || game.bossSectionIndex === null) return;
  const bossSection = structure.sections[game.bossSectionIndex];
  if (!bossSection) return;

  const y = height * TIMELINE_FRACTION + 18;
  if (game.currentSectionIndex === game.bossSectionIndex) {
    ctx.fillStyle = 'rgba(244, 63, 94, 0.85)';
    ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BOSS WAVE', width / 2, y);
    return;
  }

  const secondsToBoss = bossSection.startSeconds - game.positionSeconds;
  if (secondsToBoss <= 0 || secondsToBoss > BOSS_WARNING_SECONDS) return;
  const pulse = 0.55 + 0.35 * Math.sin(game.elapsed * 6);
  ctx.fillStyle = `rgba(244, 63, 94, ${pulse})`;
  ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`BOSS INCOMING — ${Math.ceil(secondsToBoss)}s`, width / 2, y);
}

function drawHud(ctx: CanvasRenderingContext2D, width: number, game: DropSiege): void {
  ctx.save();
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(Math.round(game.score)), 14, 30);

  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#f87171';
  const hearts = '♥'.repeat(Math.max(0, Math.ceil(game.health)));
  ctx.fillText(hearts || '—', 14, 50);

  if (game.bpm !== null) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#8fa3b8';
    ctx.fillText(`${Math.round(game.bpm)} BPM`, width - 14, 24);
  }
  ctx.restore();
}
