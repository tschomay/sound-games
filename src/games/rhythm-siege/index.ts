/**
 * Rhythm Siege as the shell sees it: a definition, and a Game that owns only
 * its rules and its picture. Everything around it — the mic/file gate,
 * canvas, loop, pausing, results, high scores — belongs to `screens/play.ts`.
 *
 * **Tap a lane, always lands.** `strike(lane)` is a plain method, not a Frame
 * field — same split every tap-driven game in this project uses (ADR-0006) —
 * and this file owns the tap listener the same way Drop Siege's `index.ts`
 * does: a `pointerdown` on the canvas the shell hands `render()`, translated
 * to a lane by which third of the canvas height it landed in. `laneFromFraction`
 * and `laneCenterY` below are the same pattern Drop Siege's `index.ts` uses,
 * simplified — there's no timeline strip here to carve out room for, so the
 * three lanes just split the full height evenly.
 *
 * **Both sources, genuinely.** `sources: ['mic', 'file']` — this is the
 * live-mic showcase of the beat-driven half of Category B, the counterpart to
 * Drop Siege being the file-only one. Nothing here reads ahead or needs the
 * whole track; a live per-onset classification and a live tempo estimate are
 * the entire input, so a mic session is exactly as playable as a file one.
 */
import { RhythmSiege, type Enemy, type EnemyKind, type Lane } from './game';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame } from '../../engine/types';

const LANE_COUNT = 3;
/** Fraction of the width the player's line sits at. */
const PLAYER_X = 0.1;

const ENEMY_COLOR: Record<EnemyKind, string> = {
  heavy: '#f97316',
  swarm: '#94daff',
};

/** Which lane a tap at this vertical fraction of the canvas selects — the
 *  inverse of `laneCenterY` below, so tap zones line up with what's drawn. */
function laneFromFraction(fraction: number): Lane {
  return Math.min(LANE_COUNT - 1, Math.max(0, Math.floor(fraction * LANE_COUNT))) as Lane;
}

function laneCenterY(lane: Lane): number {
  return (lane + 0.5) / LANE_COUNT;
}

class RhythmSiegeGame implements Game {
  private readonly rules = new RhythmSiege();
  private boundCanvas: HTMLCanvasElement | null = null;

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return 'Waiting for sound in the room — play some music, or make some noise';
  }

  update(dt: number, frame: Frame): void {
    this.rules.update(dt, {
      onset: frame.onset,
      bands: frame.bands,
      level: frame.level,
      bpm: frame.beat.bpm,
      confidence: frame.beat.confidence,
    });
  }

  reset(): void {
    this.rules.reset();
  }

  render(surface: Surface): void {
    this.attachInput(surface.canvas);
    render(surface, this.rules);
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

export const rhythmSiege: GameDefinition = {
  id: 'rhythm-siege',
  title: 'Rhythm Siege',
  category: 'music',
  description:
    'Bass-heavy hits send in slow, tough enemies; bright hits send in fast little swarms. Tap a lane to strike whatever is closing in on it — live tempo sets the pace, no beat gate on your tap.',
  requires: 'room',
  sources: ['mic', 'file'],
  intro:
    "Whatever's playing spawns enemies live: a bassy hit sends a tough Heavy down a lane, a bright hit sends a quick little Swarm. Tap a lane to strike whatever's nearest in it — your tap always lands, no timing required.",
  introDetail:
    'Works equally well on a loaded file or on the room mic — put on a different track mid-round and the enemies and their pace change with it, live.',
  // No game audio of its own, and onset/bands/level/beat are read continuously
  // off whatever's already playing (room or file) — nothing here for
  // headphones to protect, same reasoning as every other music-category game.
  headphonesRecommended: false,
  accessibilityNote:
    'The only thing you personally do is tap a lane — striking never requires producing any ' +
    'sound yourself, and it never needs to land on any particular timing either. Play it with a ' +
    'loaded music file, or with the mic listening to music playing in the room; either way, ' +
    'nothing here requires your voice or any sound from you at all.',
  readyPrompt: 'Let some sound into the room',
  formatScore: (score) => `${Math.round(score)} point${Math.round(score) === 1 ? '' : 's'}`,
  create: (_profile: CalibrationProfile) => new RhythmSiegeGame(),
};

function render(surface: Surface, game: RhythmSiege): void {
  const { ctx, width, height } = surface;
  ctx.fillStyle = '#0a0a10';
  ctx.fillRect(0, 0, width, height);

  drawHurtFlash(ctx, width, height, game.hurtFlash);
  drawLanes(ctx, width, height, game);
  drawAttackFeedback(ctx, width, height, game);
  drawHud(ctx, width, game);
}

function drawHurtFlash(ctx: CanvasRenderingContext2D, width: number, height: number, hurtFlash: number): void {
  if (hurtFlash <= 0) return;
  ctx.fillStyle = `rgba(248, 113, 113, ${hurtFlash * 0.25})`;
  ctx.fillRect(0, 0, width, height);
}

function drawLanes(ctx: CanvasRenderingContext2D, width: number, height: number, game: RhythmSiege): void {
  const playerX = width * PLAYER_X;
  const laneEnd = width - 16;

  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const y = height * laneCenterY(lane as Lane);
    ctx.strokeStyle = 'rgba(232, 238, 246, 0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playerX, y);
    ctx.lineTo(laneEnd, y);
    ctx.stroke();

    if (lane > 0) {
      const dividerY = height * (lane / LANE_COUNT);
      ctx.strokeStyle = 'rgba(232, 238, 246, 0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, dividerY);
      ctx.lineTo(width, dividerY);
      ctx.stroke();
    }

    drawPlayerMarker(ctx, playerX, y, game);
  }

  for (const enemy of game.enemies) {
    drawEnemy(ctx, enemy, playerX, laneEnd, height, game.elapsed);
  }
}

function drawPlayerMarker(ctx: CanvasRenderingContext2D, x: number, y: number, game: RhythmSiege): void {
  ctx.fillStyle = game.phase === 'over' ? '#f87171' : 'rgba(232, 238, 246, 0.7)';
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
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
  const x = laneEnd - enemy.progress * (laneEnd - playerX);
  // A quick pop right after spawn, so a fresh enemy reads as arriving rather
  // than silently appearing mid-lane.
  const age = elapsed - enemy.spawnedAt;
  const pop = Math.max(0, 1 - age * 4);
  ctx.fillStyle = ENEMY_COLOR[enemy.kind];

  if (enemy.kind === 'heavy') {
    // A heavy square, sized so multi-hit progress reads visually too.
    const size = (16 + (enemy.hitsRemaining - 1) * 4) * (1 + pop * 0.35);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-size / 2, -size / 2, size, size);
    ctx.restore();
  } else {
    // A swarm dot — small, single-hit, quick.
    const radius = 6 * (1 + pop * 0.5);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (enemy.hitsRemaining > 1) {
    ctx.fillStyle = 'rgba(10, 10, 16, 0.85)';
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(enemy.hitsRemaining), x, y);
  }
}

function drawAttackFeedback(ctx: CanvasRenderingContext2D, width: number, height: number, game: RhythmSiege): void {
  const x = width * PLAYER_X;
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const y = height * laneCenterY(lane as Lane);
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

function drawHud(ctx: CanvasRenderingContext2D, width: number, game: RhythmSiege): void {
  ctx.save();

  const barX = 14;
  const barY = 14;
  const barWidth = width * 0.4;
  const barHeight = 8;
  const healthFraction = game.health / game.config.maxHealth;
  ctx.fillStyle = 'rgba(232, 238, 246, 0.15)';
  ctx.fillRect(barX, barY, barWidth, barHeight);
  ctx.fillStyle = healthFraction > 0.35 ? 'rgba(74, 222, 128, 0.85)' : 'rgba(248, 113, 113, 0.9)';
  ctx.fillRect(barX, barY, barWidth * Math.max(0, healthFraction), barHeight);

  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(Math.round(game.score)), barX, barY + barHeight + 26);

  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'right';
  if (game.bpm !== null) {
    ctx.fillStyle = '#8fa3b8';
    ctx.fillText(`${Math.round(game.bpm)} BPM`, width - 14, 24);
  } else {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.fillText('no tempo lock — default pace', width - 14, 24);
  }
  ctx.restore();
}
