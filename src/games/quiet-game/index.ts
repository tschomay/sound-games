/**
 * Quiet Game as the shell sees it: a definition, and a Game that owns only its
 * rules and its picture. Everything around it — microphone, canvas, loop,
 * pausing, results, high scores — belongs to `screens/play.ts`.
 */
import { QuietGame, type Obstacle } from './game';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame } from '../../engine/types';

/** Fraction of the screen width the player marker sits at. */
const PLAYER_X = 0.22;
/** How much of the course fits across the screen, in world units. */
const VISIBLE_WORLD = 4.4;

class QuietGameGame implements Game {
  private readonly rules = new QuietGame();
  private level = 0;

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return 'Hold quiet for a beat to start sneaking';
  }

  update(dt: number, frame: Frame): void {
    this.level = frame.level;
    this.rules.update(dt, frame);
  }

  reset(): void {
    this.rules.reset();
    this.level = 0;
  }

  render(surface: Surface): void {
    render(surface, this.rules, this.level);
  }
}

export const quietGame: GameDefinition = {
  id: 'quiet-game',
  title: 'Quiet Game',
  description: 'Sneak below the line past the guards. Shout on purpose to shatter glass.',
  requires: 'room',
  sources: ['mic'],
  intro:
    'Stay under the line to sneak past the guards. Shout on purpose to shatter a glass panel and pull their attention off you.',
  introDetail: 'Yes, the room you are actually sitting in counts.',
  // No game audio, and the only detector in play is level — there's nothing
  // for headphones to protect here.
  headphonesRecommended: false,
  readyPrompt: 'Stay quiet to begin',
  formatScore: (score) => `${score} obstacle${score === 1 ? '' : 's'} cleared`,
  create: (_profile: CalibrationProfile) => new QuietGameGame(),
};

function render(surface: Surface, game: QuietGame, level: number): void {
  const { ctx, width, height } = surface;
  const worldScale = width / VISIBLE_WORLD;
  const playerX = width * PLAYER_X;
  const laneTop = height * 0.12;
  const laneBottom = height * 0.82;

  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, width, height);

  drawLane(ctx, width, laneTop, laneBottom);
  for (const obstacle of game.obstacles) {
    drawObstacle(ctx, obstacle, game, playerX, worldScale, laneTop, laneBottom, width);
  }
  drawPlayer(ctx, game, playerX, laneTop, laneBottom);
  drawLevelMeter(ctx, game, level, width, height);
  drawHud(ctx, game, width);
}

function drawLane(
  ctx: CanvasRenderingContext2D,
  width: number,
  top: number,
  bottom: number,
): void {
  ctx.fillStyle = 'rgba(143, 163, 184, 0.06)';
  ctx.fillRect(0, top, width, bottom - top);
}

function drawObstacle(
  ctx: CanvasRenderingContext2D,
  obstacle: Obstacle,
  game: QuietGame,
  playerX: number,
  worldScale: number,
  top: number,
  bottom: number,
  screenWidth: number,
): void {
  const centre = playerX + (obstacle.x - game.distance) * worldScale;
  const halfWidthPx = obstacle.halfWidth * worldScale;
  if (centre + halfWidthPx < 0 || centre - halfWidthPx > screenWidth) return;

  const left = centre - halfWidthPx;
  const zoneWidth = halfWidthPx * 2;

  if (obstacle.kind === 'glass') {
    ctx.fillStyle = obstacle.shattered ? 'rgba(74, 222, 128, 0.3)' : 'rgba(148, 197, 255, 0.5)';
    ctx.fillRect(left, top, zoneWidth, bottom - top);
    if (!obstacle.shattered) {
      // A pane-like cross reads as "glass" at small sizes better than a plain block.
      ctx.strokeStyle = 'rgba(232, 238, 246, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(centre, top);
      ctx.lineTo(centre, bottom);
      ctx.moveTo(left, (top + bottom) / 2);
      ctx.lineTo(left + zoneWidth, (top + bottom) / 2);
      ctx.stroke();
    }
    return;
  }

  // A guard's zone shades from a calm blue to an alarmed red as suspicion rises.
  const heat = obstacle.suspicion;
  const r = Math.round(56 + heat * (248 - 56));
  const g = Math.round(189 - heat * (189 - 113));
  const b = Math.round(248 - heat * (248 - 113));
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.14 + heat * 0.3})`;
  ctx.fillRect(left, top, zoneWidth, bottom - top);
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.5)`;
  ctx.lineWidth = 1;
  ctx.strokeRect(left, top, zoneWidth, bottom - top);

  // The guard themself, at the zone's centre.
  const guardY = (top + bottom) / 2;
  ctx.fillStyle = obstacle.cleared ? 'rgba(74, 222, 128, 0.55)' : `rgb(${r}, ${g}, ${b})`;
  ctx.beginPath();
  ctx.arc(centre, guardY, 9, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  game: QuietGame,
  playerX: number,
  top: number,
  bottom: number,
): void {
  const y = (top + bottom) / 2;
  const radius = 11;

  if (game.celebration > 0) {
    ctx.fillStyle = `rgba(74, 222, 128, ${game.celebration * 0.25})`;
    ctx.beginPath();
    ctx.arc(playerX, y, radius * (1 + (1 - game.celebration) * 2.5), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = game.phase === 'over' ? '#f87171' : '#e8eef6';
  ctx.beginPath();
  ctx.arc(playerX, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** A live readout of the current volume against the sneak and shout lines —
 *  the whole game hinges on reading this correctly, so it gets real space. */
function drawLevelMeter(
  ctx: CanvasRenderingContext2D,
  game: QuietGame,
  level: number,
  width: number,
  height: number,
): void {
  const barTop = height * 0.88;
  const barHeight = height * 0.06;
  const { sneakThreshold, shoutThreshold } = game.config;

  ctx.fillStyle = 'rgba(143, 163, 184, 0.12)';
  ctx.fillRect(0, barTop, width, barHeight);

  const safeWidth = width * sneakThreshold;
  ctx.fillStyle = 'rgba(74, 222, 128, 0.18)';
  ctx.fillRect(0, barTop, safeWidth, barHeight);

  const shoutX = width * shoutThreshold;
  ctx.fillStyle = 'rgba(148, 197, 255, 0.18)';
  ctx.fillRect(shoutX, barTop, width - shoutX, barHeight);

  const fillWidth = Math.min(width, width * level);
  const over = level >= shoutThreshold;
  const risky = !over && level >= sneakThreshold;
  ctx.fillStyle = over
    ? 'rgba(148, 197, 255, 0.9)'
    : risky
      ? 'rgba(248, 113, 113, 0.85)'
      : 'rgba(74, 222, 128, 0.85)';
  ctx.fillRect(0, barTop, fillWidth, barHeight);

  ctx.strokeStyle = 'rgba(232, 238, 246, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(safeWidth, barTop);
  ctx.lineTo(safeWidth, barTop + barHeight);
  ctx.moveTo(shoutX, barTop);
  ctx.lineTo(shoutX, barTop + barHeight);
  ctx.stroke();
}

function drawHud(ctx: CanvasRenderingContext2D, game: QuietGame, width: number): void {
  ctx.save();
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(String(game.score), 14, 30);

  if (game.distracted) {
    ctx.fillStyle = '#94c5ff';
    ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('guards distracted', width - 14, 30);
  }
  ctx.restore();
}
