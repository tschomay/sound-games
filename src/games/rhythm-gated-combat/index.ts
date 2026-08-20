/**
 * Rhythm-Gated Combat as the shell sees it: a definition, and a Game that owns
 * only its rules and its picture. Everything around it — microphone/file
 * source, canvas, loop, pausing, results, high scores — belongs to
 * `screens/play.ts`.
 *
 * Attack is a tap, not a Frame field — same split as Sonar Maze (ADR-0006):
 * this game's whole hook is rhythm, not voice, so a tap for "attack" is the
 * natural non-audio verb, leaving `Frame.beat`/`Frame.bands` free to gate and
 * flavour it. This file owns the tap listener the same way `sonar-maze/index.ts`
 * does — attached directly to the canvas the shell hands `render()`.
 *
 * **The mic-vs-file difference.** `game.ts`'s rules are identical either way —
 * same hit window, same enemy stats, same everything — deliberately, so a
 * player's actual odds don't secretly change with their source. What differs
 * is purely what the screen *shows*: on a file source the whole beat grid is
 * known before playback starts (`BeatGridReader`/`BeatGrid`,
 * `engine/beat-offline.ts`), so several beats' worth of future arrival times
 * can be trusted and drawn in advance — a countdown of approaching markers on
 * the beat lane. The causal mic tracker (`beat-causal.ts`) only ever commits
 * to "the next beat is coming, this soon," and its phase lock can still be
 * nudging itself into place (ADR-0010): trusting it several beats out would
 * be showing the player a prediction the tracker itself doesn't stand behind.
 * So mic mode gets exactly one thing — the live pulse at the beat instant
 * itself — and file mode gets that pulse plus the approaching queue.
 *
 * Detecting which is live reads `currentSession()`'s `source.kind`
 * (`engine/session.ts`) once per render call. `GameDefinition.create(profile)`
 * runs before the mic/file gate resolves — no session exists yet at that
 * point, sometimes not even the *previous* game's — so the mode can't be
 * fixed at construction; it has to be read live, in `render()`, once a
 * session is actually open. That's a cheap property read, not a subscription,
 * so there's no lifecycle to manage for it.
 */
import { RhythmGatedCombat, type Enemy, type EnemyKind } from './game';
import { currentSession } from '../../engine/session';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame } from '../../engine/types';

/** How many beats ahead the file path's telegraph shows. Wide enough to be
 *  genuinely useful warning, narrow enough that the lane doesn't feel empty. */
const LOOKAHEAD_BEATS = 3;
/** Fraction of the width the target/attack zone sits at. */
const TARGET_X = 0.14;
/** y position of the beat lane, as a fraction of height. */
const BEAT_LANE_Y = 0.22;
/** y position of the enemy lane. */
const ENEMY_LANE_Y = 0.62;

const ENEMY_COLOR: Record<EnemyKind, string> = {
  brute: '#f97316',
  grunt: '#94daff',
  sprite: '#facc15',
};

class RhythmGatedCombatGame implements Game {
  private readonly rules = new RhythmGatedCombat();
  private boundCanvas: HTMLCanvasElement | null = null;

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return 'Waiting for the beat to lock in — then tap in time with it to attack';
  }

  update(dt: number, frame: Frame): void {
    this.rules.update(dt, {
      bpm: frame.beat.bpm,
      beatPhase: frame.beat.beatPhase,
      onBeat: frame.beat.onBeat,
      confidence: frame.beat.confidence,
      beatIndex: frame.beat.beatIndex,
      bands: frame.bands,
    });
  }

  reset(): void {
    this.rules.reset();
  }

  render(surface: Surface): void {
    this.attachInput(surface.canvas);
    // Only meaningful once a file's beat grid — not just an estimate — is
    // actually driving `Frame.beat`; see the module doc comment.
    const lookAhead = currentSession()?.source.kind === 'file';
    render(surface, this.rules, lookAhead);
  }

  private attachInput(canvas: HTMLCanvasElement): void {
    if (this.boundCanvas === canvas) return;
    this.boundCanvas = canvas;
    canvas.addEventListener('pointerdown', () => this.rules.attack());
  }
}

export const rhythmGatedCombat: GameDefinition = {
  id: 'rhythm-gated-combat',
  title: 'Rhythm-Gated Combat',
  description:
    'You can only attack on the beat. Enemies close in on the beat too — a file source shows you them coming.',
  requires: 'room',
  sources: ['mic', 'file'],
  intro:
    'Tap in time with the beat to attack — off the beat, your tap does nothing. Enemies advance one step closer on every beat, so time your hits before they reach you.',
  introDetail:
    'Load a track and you\'ll see upcoming beats telegraphed in advance. Play into the mic and you get the live pulse only — no peeking ahead.',
  // No game audio of its own, and level/bands/beat are read continuously off
  // whatever's already playing (room or file) — nothing here for headphones
  // to protect, same reasoning as Ecosystem Garden.
  headphonesRecommended: false,
  readyPrompt: 'Let the beat lock in',
  formatScore: (score) => `${Math.round(score)} point${Math.round(score) === 1 ? '' : 's'}`,
  create: (_profile: CalibrationProfile) => new RhythmGatedCombatGame(),
};

function render(surface: Surface, game: RhythmGatedCombat, lookAhead: boolean): void {
  const { ctx, width, height } = surface;
  ctx.fillStyle = '#0a0a10';
  ctx.fillRect(0, 0, width, height);

  drawHurtFlash(ctx, width, height, game.hurtFlash);
  drawBeatLane(ctx, width, height, game, lookAhead);
  drawEnemyLane(ctx, width, height, game);
  drawAttackFeedback(ctx, width, height, game);
  drawHud(ctx, width, game, lookAhead);
}

function drawHurtFlash(ctx: CanvasRenderingContext2D, width: number, height: number, hurtFlash: number): void {
  if (hurtFlash <= 0) return;
  ctx.fillStyle = `rgba(248, 113, 113, ${hurtFlash * 0.25})`;
  ctx.fillRect(0, 0, width, height);
}

function drawBeatLane(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  game: RhythmGatedCombat,
  lookAhead: boolean,
): void {
  const y = height * BEAT_LANE_Y;
  const targetX = width * TARGET_X;

  ctx.strokeStyle = 'rgba(232, 238, 246, 0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(targetX, y);
  ctx.lineTo(width - 16, y);
  ctx.stroke();

  // The file-only telegraph: markers for the next few beats, positioned by
  // exactly when they'll arrive. This is trustworthy multiple beats out only
  // because the grid behind it is fixed before playback starts — see the
  // module doc comment.
  if (lookAhead && game.bpm !== null && game.beatPhase !== null) {
    const period = 60 / game.bpm;
    const horizon = LOOKAHEAD_BEATS * period;
    for (let k = 0; k < LOOKAHEAD_BEATS; k++) {
      const secondsToArrival = (1 - game.beatPhase + k) * period;
      if (secondsToArrival > horizon) continue;
      const x = targetX + (secondsToArrival / horizon) * (width - 16 - targetX);
      const fade = 1 - secondsToArrival / horizon;
      ctx.fillStyle = `rgba(148, 218, 255, ${0.25 + fade * 0.45})`;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawWindowWedge(ctx, targetX, y, game.config.hitWindowFraction);

  // The one thing both modes get: a ring that sweeps with the live phase and
  // snaps bright on the beat itself.
  const phase = game.beatPhase ?? 0;
  const known = game.bpm !== null;
  const ringAlpha = known ? 0.35 + 0.4 * (game.onBeatFlag ? 1 : 0) : 0.12;
  ctx.strokeStyle = `rgba(196, 181, 253, ${ringAlpha})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(targetX, y, 16, -Math.PI / 2, -Math.PI / 2 + phase * Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = known ? `rgba(196, 181, 253, ${0.5 + (game.onBeatFlag ? 0.5 : 0)})` : 'rgba(148, 163, 184, 0.3)';
  ctx.beginPath();
  ctx.arc(targetX, y, known ? 6 + (game.onBeatFlag ? 4 : 0) : 4, 0, Math.PI * 2);
  ctx.fill();
}

/** The tolerance window itself, drawn as a wedge on the ring — visible and
 *  identical on both sources, since the rules never differ by source. */
function drawWindowWedge(ctx: CanvasRenderingContext2D, x: number, y: number, windowFraction: number): void {
  const span = windowFraction * Math.PI * 2;
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.25)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(x, y, 24, -Math.PI / 2 - span, -Math.PI / 2 + span);
  ctx.stroke();
}

function drawEnemyLane(ctx: CanvasRenderingContext2D, width: number, height: number, game: RhythmGatedCombat): void {
  const y = height * ENEMY_LANE_Y;
  const playerX = width * TARGET_X;
  const maxSteps = Math.max(...Object.values(game.config.enemyStats).map((s) => s.spawnSteps));
  const laneEnd = width - 16;

  ctx.strokeStyle = 'rgba(232, 238, 246, 0.08)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playerX, y);
  ctx.lineTo(laneEnd, y);
  ctx.stroke();

  // Attack range, shown as a highlighted stretch of the lane.
  const rangeX = playerX + (game.config.attackRange / maxSteps) * (laneEnd - playerX);
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.18)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(playerX, y);
  ctx.lineTo(rangeX, y);
  ctx.stroke();

  drawPlayer(ctx, playerX, y, game);

  for (const enemy of game.enemies) {
    drawEnemy(ctx, enemy, playerX, laneEnd, maxSteps, y, game.elapsed);
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, x: number, y: number, game: RhythmGatedCombat): void {
  const halo = ctx.createRadialGradient(x, y, 0, x, y, 30);
  halo.addColorStop(0, 'rgba(232, 238, 246, 0.16)');
  halo.addColorStop(1, 'rgba(232, 238, 246, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, 30, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = game.phase === 'over' ? '#f87171' : '#e8eef6';
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
}

function drawEnemy(
  ctx: CanvasRenderingContext2D,
  enemy: Enemy,
  playerX: number,
  laneEnd: number,
  maxSteps: number,
  y: number,
  elapsed: number,
): void {
  const x = playerX + (enemy.steps / maxSteps) * (laneEnd - playerX);
  // A quick squash-pop right after it steps, so a beat-locked hop still reads
  // as motion rather than a silent teleport.
  const age = elapsed - enemy.lastStepAt;
  const pop = Math.max(0, 1 - age * 5);
  const radius = (8 + (enemy.hitsRemaining - 1) * 3) * (1 + pop * 0.35);

  ctx.fillStyle = ENEMY_COLOR[enemy.kind];
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  if (enemy.hitsRemaining > 1) {
    ctx.fillStyle = 'rgba(10, 10, 16, 0.85)';
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(enemy.hitsRemaining), x, y);
  }
}

function drawAttackFeedback(ctx: CanvasRenderingContext2D, width: number, height: number, game: RhythmGatedCombat): void {
  const y = height * ENEMY_LANE_Y;
  const x = width * TARGET_X;
  if (game.attackFlash > 0) {
    ctx.strokeStyle = `rgba(74, 222, 128, ${game.attackFlash})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 20 + (1 - game.attackFlash) * 20, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (game.glanceFlash > 0) {
    ctx.strokeStyle = `rgba(250, 204, 21, ${game.glanceFlash})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 20 + (1 - game.glanceFlash) * 12, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (game.missFlash > 0) {
    ctx.strokeStyle = `rgba(148, 163, 184, ${game.missFlash * 0.6})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawHud(ctx: CanvasRenderingContext2D, width: number, game: RhythmGatedCombat, lookAhead: boolean): void {
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

  ctx.textAlign = 'right';
  ctx.fillStyle = lookAhead ? 'rgba(148, 218, 255, 0.85)' : 'rgba(148, 163, 184, 0.85)';
  ctx.fillText(lookAhead ? 'file source — beats telegraphed' : 'mic source — live beat only', width - 14, 24);

  if (game.bpm !== null) {
    ctx.fillStyle = '#8fa3b8';
    ctx.fillText(`${Math.round(game.bpm)} BPM`, width - 14, 42);
  }
  ctx.restore();
}
