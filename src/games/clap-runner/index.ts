/**
 * Clap Runner as the shell sees it: a definition, and a Game that owns only
 * its rules and its picture. Everything around it — microphone, canvas, loop,
 * pausing, results, high scores — belongs to `screens/play.ts`.
 *
 * No game audio: like Sonar Maze and Quiet Game before it, this ships with no
 * SFX. If a later pass adds hit/land sounds, they need to go through
 * `session.output` (`engine/output.ts`) so ADR-0005's gating protects the
 * onset detector this game's jump depends on — see `ideas.md`'s hazard 2.
 */
import { ClapRunner, type Obstacle } from './game';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame } from '../../engine/types';

/** Fraction of the screen width the player marker sits at. */
const PLAYER_X = 0.22;
/** How much of the course fits across the screen, in world units. */
const VISIBLE_WORLD = 4.6;
/** Fraction of the canvas height the ground line sits at. */
const GROUND_FRACTION = 0.68;
/** Pixels of rise per world unit of jump height. */
const HEIGHT_SCALE = 130;

class ClapRunnerGame implements Game {
  private readonly rules = new ClapRunner();

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return 'Clap to start running';
  }

  update(dt: number, frame: Frame): void {
    this.rules.update(dt, {
      onset: frame.onset,
      level: frame.level,
      timbreClass: frame.timbreClass,
    });
  }

  reset(): void {
    this.rules.reset();
  }

  render(surface: Surface): void {
    render(surface, this.rules);
  }
}

export const clapRunner: GameDefinition = {
  id: 'clap-runner',
  title: 'Clap Runner',
  description: 'Clap to jump, hold "aaah" to glide, shout to ground-pound.',
  requires: 'room',
  sources: ['mic'],
  intro:
    'An auto-runner with three voice verbs. Clap to jump a low bar, hold a sustained "aaah" to glide across a gap, and shout to ground-pound through a breakable wall.',
  introDetail: 'Clap timing matters for the jump — hold the "aaah" the whole way across a gap.',
  // No game audio — nothing for headphones to protect yet, same reasoning as
  // Sonar Maze and Quiet Game.
  headphonesRecommended: false,
  accessibilityNote:
    'Needs three different sounds from you — a clap, a held tone, a shout — with no alternative ' +
    'input for any of them. If you cannot produce those sounds, this one is not for you; try ' +
    'Rhythm-Gated Combat or Drop Siege instead, which read music rather than requiring sound ' +
    'from you.',
  readyPrompt: 'Clap to start',
  formatScore: (score) => `${score} obstacle${score === 1 ? '' : 's'} cleared`,
  create: (_profile: CalibrationProfile) => new ClapRunnerGame(),
};

function render(surface: Surface, game: ClapRunner): void {
  const { ctx, width, height } = surface;
  const worldScale = width / VISIBLE_WORLD;
  const playerX = width * PLAYER_X;
  const groundY = height * GROUND_FRACTION;
  const toScreenX = (worldX: number): number => playerX + (worldX - game.distance) * worldScale;

  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, width, height);

  drawGround(ctx, width, groundY);
  for (const obstacle of game.obstacles) {
    drawObstacle(ctx, obstacle, game, toScreenX, groundY, width);
  }
  drawPlayer(ctx, game, playerX, groundY);
  drawHud(ctx, game, width);
}

function drawGround(ctx: CanvasRenderingContext2D, width: number, groundY: number): void {
  ctx.fillStyle = 'rgba(143, 163, 184, 0.14)';
  ctx.fillRect(0, groundY, width, 3);
}

function drawObstacle(
  ctx: CanvasRenderingContext2D,
  obstacle: Obstacle,
  game: ClapRunner,
  toScreenX: (worldX: number) => number,
  groundY: number,
  screenWidth: number,
): void {
  const left = toScreenX(obstacle.x - obstacle.halfWidth);
  const right = toScreenX(obstacle.x + obstacle.halfWidth);
  if (right < 0 || left > screenWidth) return;

  if (obstacle.kind === 'low') {
    // A bar at the height a jump has to clear — drawn at the game's own
    // lowClearance so the visual and the rule can never disagree.
    const barTop = groundY - game.config.lowClearance * HEIGHT_SCALE;
    ctx.fillStyle = obstacle.cleared ? 'rgba(74, 222, 128, 0.35)' : 'rgba(248, 113, 113, 0.75)';
    ctx.fillRect(left, barTop, Math.max(2, right - left), groundY - barTop);
    return;
  }

  if (obstacle.kind === 'gap') {
    ctx.fillStyle = obstacle.cleared ? 'rgba(74, 222, 128, 0.2)' : '#05070a';
    ctx.fillRect(left, groundY, Math.max(2, right - left), 3);
    if (!obstacle.cleared) {
      ctx.fillStyle = 'rgba(148, 197, 255, 0.18)';
      ctx.fillRect(left, groundY - 20, Math.max(2, right - left), 20);
    }
    return;
  }

  // breakable
  const blockHeight = 46;
  ctx.fillStyle = obstacle.broken
    ? 'rgba(74, 222, 128, 0.3)'
    : obstacle.cleared
      ? 'rgba(74, 222, 128, 0.35)'
      : 'rgba(251, 191, 36, 0.75)';
  ctx.fillRect(left, groundY - blockHeight, Math.max(2, right - left), blockHeight);
  if (obstacle.broken && !obstacle.cleared) {
    // A crack, so "broken but not yet passed" reads differently from "solid".
    ctx.strokeStyle = 'rgba(11, 15, 20, 0.6)';
    ctx.lineWidth = 2;
    const mid = (left + right) / 2;
    ctx.beginPath();
    ctx.moveTo(mid, groundY - blockHeight);
    ctx.lineTo(mid, groundY);
    ctx.stroke();
  }
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  game: ClapRunner,
  x: number,
  groundY: number,
): void {
  const y = groundY - game.jumpHeight() * HEIGHT_SCALE;
  const radius = 11;

  if (game.gliding) {
    // A soft trailing halo while holding the tone, so glide reads as
    // continuous rather than a single frame's state.
    ctx.fillStyle = 'rgba(148, 197, 255, 0.28)';
    ctx.beginPath();
    ctx.arc(x, y, radius * 2.1, 0, Math.PI * 2);
    ctx.fill();
  }
  if (game.pounding) {
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, groundY, radius * 2.4, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (game.celebration > 0) {
    ctx.fillStyle = `rgba(74, 222, 128, ${game.celebration * 0.25})`;
    ctx.beginPath();
    ctx.arc(x, y, radius * (1 + (1 - game.celebration) * 2.5), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = game.phase === 'over' ? '#f87171' : '#e8eef6';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawHud(ctx: CanvasRenderingContext2D, game: ClapRunner, width: number): void {
  ctx.save();
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(String(game.score), 14, 30);

  const next = game.nextObstacle();
  if (next) {
    ctx.fillStyle = '#8fa3b8';
    ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    const label = next.kind === 'low' ? 'clap' : next.kind === 'gap' ? 'hold aaah' : 'shout';
    ctx.fillText(`next: ${label}`, width - 14, 30);
  }
  ctx.restore();
}
