/**
 * Overtone as the shell sees it: a definition, and a Game that owns only its
 * rules and its picture. Everything around it — microphone/file source,
 * canvas, loop, pausing, results, high scores — belongs to `screens/play.ts`.
 *
 * Jump is a tap, not a Frame field — same split as Sonar Maze's `steer()` and
 * Rhythm-Gated Combat's `attack()` (ADR-0006). This file owns the tap
 * listener the same way theirs do: attached directly to the canvas the shell
 * hands `render()`, calling a plain method on the rules object.
 *
 * No game audio: like Ecosystem Garden and Drop Siege, `level`/`bands`/
 * `centroid` are read continuously off whatever the source is already
 * producing, so there is nothing here for headphones to protect.
 */
import { Overtone, type Obstacle, type TerrainSample } from './game';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame } from '../../engine/types';

/** Fraction of the screen width the player marker sits at. */
const PLAYER_X = 0.22;
/** How much of the course fits across the screen, in world units — wider
 *  than `Config.spawnAhead` so freshly spawned terrain never pops in already
 *  visible on the right edge. */
const VISIBLE_WORLD = 7;
/** Fraction of the canvas height the terrain's zero-height baseline sits at. */
const GROUND_FRACTION = 0.7;
/** Pixels of rise per world unit of terrain height / jump height. */
const HEIGHT_SCALE = 220;

class OvertoneGame implements Game {
  private readonly rules = new Overtone();
  private boundCanvas: HTMLCanvasElement | null = null;

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return 'Play some music, or let the room settle — the terrain draws itself in once it can hear something';
  }

  update(dt: number, frame: Frame): void {
    this.rules.update(dt, {
      centroid: frame.centroid,
      bassLevel: frame.bands.bass,
      level: frame.level,
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
    canvas.addEventListener('pointerdown', () => this.rules.jump());
  }
}

export const overtone: GameDefinition = {
  id: 'overtone',
  title: 'Overtone',
  category: 'music',
  description:
    "Ride the terrain your song draws. Bright, cutting sound raises jagged peaks; dark, warm sound flattens valleys. Bass hits launch rocks — tap to jump them.",
  requires: 'room',
  sources: ['mic', 'file'],
  intro:
    "The song's brightness draws the ground under you in real time, and its bass hits launch rock obstacles onto the terrain ahead. Tap to jump — that's the whole game.",
  introDetail: 'Play a track into the mic, or load a file — either works, and the terrain reacts either way.',
  headphonesRecommended: false,
  accessibilityNote:
    'The only thing you personally do is tap to jump — no voice or sound is required from you at all. ' +
    'Choose a music file as the source and the entire terrain and every obstacle come from the track ' +
    'you pick, with nothing needed from your voice or the room.',
  readyPrompt: 'Let some music in to start riding',
  formatScore: (score) => `${Math.round(score)}m`,
  create: (_profile: CalibrationProfile) => new OvertoneGame(),
};

function render(surface: Surface, game: Overtone): void {
  const { ctx, width, height } = surface;
  const worldScale = width / VISIBLE_WORLD;
  const playerX = width * PLAYER_X;
  const groundY = height * GROUND_FRACTION;
  const toScreenX = (worldX: number): number => playerX + (worldX - game.distance) * worldScale;

  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, width, height);

  drawTerrain(ctx, width, groundY, game, toScreenX);
  for (const obstacle of game.obstacles) {
    drawObstacle(ctx, obstacle, toScreenX, groundY, width);
  }
  drawPlayer(ctx, game, playerX, groundY);
  drawHud(ctx, game, width);
}

/** Warm and dark at low brightness (bass, pads), bright and cool at high
 *  brightness (cymbals, cutting synths) — the same "dark background, colour
 *  carries the meaning" palette Ecosystem Garden and Drop Siege already use,
 *  applied here to a single hue/lightness ramp instead of discrete states. */
function brightnessColor(sampleHeight: number): string {
  const h = sampleHeight < 0 ? 0 : sampleHeight > 1 ? 1 : sampleHeight;
  const hue = 26 + h * 176; // ember orange -> icy blue
  const saturation = 55 + h * 25;
  const lightness = 20 + h * 40;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function drawTerrain(
  ctx: CanvasRenderingContext2D,
  width: number,
  groundY: number,
  game: Overtone,
  toScreenX: (worldX: number) => number,
): void {
  const visible: { sx: number; sample: TerrainSample }[] = [];
  for (const sample of game.terrain) {
    const sx = toScreenX(sample.x);
    if (sx < -40 || sx > width + 40) continue;
    visible.push({ sx, sample });
  }
  if (visible.length < 2) return;

  // One gradient across the visible strip, stopped at each sample's own
  // colour, gives a continuous brightness ramp without redrawing a separate
  // shape per segment.
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  let lastStop = -1;
  for (const { sx, sample } of visible) {
    const t = Math.min(1, Math.max(0, sx / width));
    const stop = Math.max(t, lastStop); // addColorStop requires non-decreasing offsets
    gradient.addColorStop(stop, brightnessColor(sample.height));
    lastStop = stop;
  }

  ctx.beginPath();
  ctx.moveTo(visible[0].sx, groundY + 4);
  for (const { sx, sample } of visible) {
    ctx.lineTo(sx, groundY - sample.height * HEIGHT_SCALE);
  }
  ctx.lineTo(visible[visible.length - 1].sx, groundY + 4);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // A brighter ridge line along the top edge so the silhouette reads clearly
  // against the dark sky, the way Drop Siege's timeline outlines its bars.
  ctx.beginPath();
  visible.forEach(({ sx, sample }, i) => {
    const sy = groundY - sample.height * HEIGHT_SCALE;
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.strokeStyle = 'rgba(232, 238, 246, 0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawObstacle(
  ctx: CanvasRenderingContext2D,
  obstacle: Obstacle,
  toScreenX: (worldX: number) => number,
  groundY: number,
  screenWidth: number,
): void {
  const left = toScreenX(obstacle.x - obstacle.halfWidth);
  const right = toScreenX(obstacle.x + obstacle.halfWidth);
  if (right < -20 || left > screenWidth + 20) return;

  const baseY = groundY - obstacle.groundHeight * HEIGHT_SCALE;
  const rockHeight = 24;
  ctx.fillStyle = obstacle.cleared ? 'rgba(74, 222, 128, 0.3)' : 'rgba(248, 113, 113, 0.85)';
  ctx.beginPath();
  ctx.moveTo(left, baseY);
  ctx.lineTo((left + right) / 2, baseY - rockHeight);
  ctx.lineTo(right, baseY);
  ctx.closePath();
  ctx.fill();
}

function drawPlayer(ctx: CanvasRenderingContext2D, game: Overtone, x: number, groundY: number): void {
  const groundHeight = game.heightAt(game.distance);
  const y = groundY - (groundHeight + game.jumpHeight()) * HEIGHT_SCALE;
  const radius = 11;

  if (game.jumping) {
    // A soft trailing halo while airborne, so a jump reads as continuous
    // motion rather than a single frame's teleport.
    ctx.fillStyle = 'rgba(148, 197, 255, 0.22)';
    ctx.beginPath();
    ctx.arc(x, y, radius * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = game.phase === 'over' ? '#f87171' : '#e8eef6';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawHud(ctx: CanvasRenderingContext2D, game: Overtone, width: number): void {
  ctx.save();
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(game.score)}m`, 14, 30);

  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#8fa3b8';
  ctx.textAlign = 'right';
  ctx.fillText('tap to jump', width - 14, 30);
  ctx.restore();
}
