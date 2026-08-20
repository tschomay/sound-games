/**
 * Sonar Maze as the shell sees it: a definition, and a Game that owns only its
 * rules and its picture. Everything around it — microphone, canvas, loop,
 * pausing, results, high scores — belongs to `screens/play.ts`.
 *
 * Lane steering is a tap, not a Frame field — see ADR-0006 for why that isn't
 * a betrayal of "voice as controller" for a game whose entire hook is what a
 * clap does. This file owns the tap listener because `Game` has no `onInput`
 * of its own; it attaches directly to the canvas the shell hands `render()`.
 */
import { SonarMaze, type Fork } from './game';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame } from '../../engine/types';

/** Fraction of the screen width the player marker sits at. */
const PLAYER_X = 0.24;
/** How much of the course fits across the screen, in world units. Wide enough
 *  that a full-strength wavefront never clips the edge of the screen. */
const VISIBLE_WORLD = 6.2;
/** Vertical padding so the outer lanes never touch the edge of the canvas. */
const BAND_MARGIN = 0.1;
/** Seconds a wavefront takes to reach its full radius. */
const PULSE_GROW = 0.35;
/** Seconds a wavefront stays on screen at all, growth included. */
const PULSE_LIFE = 0.9;
/** World-distance gap at which the danger vignette starts to show at all. */
const DANGER_RANGE = 3.2;

interface Pulse {
  /** World distance the clap originated at — the ring's origin stays fixed
   *  there and falls behind you as you keep moving, same as a real echo. */
  distance: number;
  lane: number;
  radius: number;
  age: number;
}

class SonarMazeGame implements Game {
  private readonly rules = new SonarMaze();
  private pulses: Pulse[] = [];
  private seenClapSeq = 0;
  /** Eases toward `rules.lane` so a steer reads as a slide, not a jump cut. */
  private visualLane = 0;
  private boundCanvas: HTMLCanvasElement | null = null;

  constructor() {
    this.visualLane = this.rules.lane;
  }

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return 'Louder claps see further — but so does the thing hunting you';
  }

  update(dt: number, frame: Frame): void {
    this.rules.update(dt, { onset: frame.onset, level: frame.level });

    if (this.rules.clapSeq !== this.seenClapSeq) {
      this.seenClapSeq = this.rules.clapSeq;
      this.pulses.push({
        distance: this.rules.lastClapDistance,
        lane: this.rules.lane,
        radius: this.rules.lastClapRadius,
        age: 0,
      });
    }
    this.pulses.forEach((pulse) => (pulse.age += dt));
    this.pulses = this.pulses.filter((pulse) => pulse.age < PULSE_LIFE);

    const blend = 1 - Math.exp(-14 * dt);
    this.visualLane += (this.rules.lane - this.visualLane) * blend;
  }

  reset(): void {
    this.rules.reset();
    this.pulses = [];
    this.seenClapSeq = 0;
    this.visualLane = this.rules.lane;
  }

  render(surface: Surface): void {
    this.attachInput(surface.canvas);
    render(surface, this.rules, this.pulses, this.visualLane);
  }

  private attachInput(canvas: HTMLCanvasElement): void {
    if (this.boundCanvas === canvas) return;
    this.boundCanvas = canvas;
    // Top half steers up a lane, bottom half steers down — a tap, not a drag,
    // because a drag has no clean mapping back onto a discrete lane.
    canvas.addEventListener('pointerdown', (event) => {
      const rect = canvas.getBoundingClientRect();
      const relativeY = (event.clientY - rect.top) / rect.height;
      this.rules.steer(relativeY < 0.5 ? -1 : 1);
    });
  }
}

export const sonarMaze: GameDefinition = {
  id: 'sonar-maze',
  title: 'Sonar Maze',
  description: 'Clap to light up the maze. Louder claps see further — and draw the hunter closer.',
  requires: 'room',
  sources: ['mic'],
  intro:
    'Clap to send out a wavefront that lights up the maze ahead. The louder the clap, the further it reaches — and the more noise it is for the thing hunting you.',
  introDetail: 'Tap the top or bottom half of the screen to change lanes.',
  // No game audio, and the detectors in play are onset/level — there's
  // nothing for headphones to protect here, same reasoning as Quiet Game.
  headphonesRecommended: false,
  readyPrompt: 'Clap to start mapping',
  formatScore: (score) => `${score} fork${score === 1 ? '' : 's'} navigated`,
  create: (_profile: CalibrationProfile) => new SonarMazeGame(),
};

function render(surface: Surface, game: SonarMaze, pulses: Pulse[], visualLane: number): void {
  const { ctx, width, height } = surface;
  const worldScale = width / VISIBLE_WORLD;
  const playerX = width * PLAYER_X;
  const lanes = game.config.lanes;
  const bandTop = height * BAND_MARGIN;
  const bandBottom = height * (1 - BAND_MARGIN);
  const laneY = (lane: number): number =>
    lanes > 1 ? bandTop + (lane / (lanes - 1)) * (bandBottom - bandTop) : (bandTop + bandBottom) / 2;
  const toScreenX = (worldX: number): number => playerX + (worldX - game.distance) * worldScale;
  const revealAll = game.phase === 'over';

  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, width, height);

  drawDangerVignette(ctx, game, width, height);
  for (const fork of game.forks) {
    drawFork(ctx, fork, game, pulses, toScreenX, laneY, width, revealAll);
  }
  drawPulses(ctx, pulses, toScreenX, laneY);
  drawHunter(ctx, game, pulses, toScreenX, laneY, revealAll);
  drawPlayer(ctx, game, playerX, laneY(visualLane));
  drawHud(ctx, game, width);
}

function drawDangerVignette(
  ctx: CanvasRenderingContext2D,
  game: SonarMaze,
  width: number,
  height: number,
): void {
  const gap = Math.abs(game.distance - game.hunterDistance);
  const intensity = Math.max(0, Math.min(1, 1 - gap / DANGER_RANGE));
  if (intensity <= 0) return;

  const cx = width / 2;
  const cy = height / 2;
  const outer = Math.max(width, height) * 0.75;
  const gradient = ctx.createRadialGradient(cx, cy, outer * 0.35, cx, cy, outer);
  gradient.addColorStop(0, 'rgba(248, 113, 113, 0)');
  gradient.addColorStop(1, `rgba(248, 113, 113, ${intensity * 0.35})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

/** How lit a world point is right now: the strongest active wavefront reaching
 *  it, 0..1. Cheap — a handful of pulses at most, no per-pixel work. */
function litness(worldX: number, pulses: Pulse[]): number {
  let best = 0;
  for (const pulse of pulses) {
    const radius = pulse.radius * Math.min(1, pulse.age / PULSE_GROW);
    if (Math.abs(worldX - pulse.distance) > radius) continue;
    const fade = pulse.age <= PULSE_GROW ? 1 : 1 - (pulse.age - PULSE_GROW) / (PULSE_LIFE - PULSE_GROW);
    best = Math.max(best, fade);
  }
  return best;
}

function drawFork(
  ctx: CanvasRenderingContext2D,
  fork: Fork,
  game: SonarMaze,
  pulses: Pulse[],
  toScreenX: (worldX: number) => number,
  laneY: (lane: number) => number,
  screenWidth: number,
  revealAll: boolean,
): void {
  if (!fork.revealed && !revealAll) return;
  const x = toScreenX(fork.x);
  if (x < -40 || x > screenWidth + 40) return;

  const flash = revealAll ? 1 : litness(fork.x, pulses);
  const alpha = Math.max(0.16, flash);
  const wallHeight = (laneY(1) - laneY(0)) * 0.6 || 18;

  ctx.fillStyle = `rgba(148, 218, 255, ${alpha})`;
  for (let lane = 0; lane < game.config.lanes; lane++) {
    if (lane === fork.openLane) continue;
    const y = laneY(lane);
    ctx.fillRect(x - 5, y - wallHeight / 2, 10, wallHeight);
  }
}

function drawPulses(
  ctx: CanvasRenderingContext2D,
  pulses: Pulse[],
  toScreenX: (worldX: number) => number,
  laneY: (lane: number) => number,
): void {
  for (const pulse of pulses) {
    const radius = pulse.radius * Math.min(1, pulse.age / PULSE_GROW);
    if (radius <= 0) continue;
    const fade = pulse.age <= PULSE_GROW ? 1 : 1 - (pulse.age - PULSE_GROW) / (PULSE_LIFE - PULSE_GROW);
    if (fade <= 0) continue;

    const x = toScreenX(pulse.distance);
    const y = laneY(pulse.lane);
    // worldScale isn't available here directly, but toScreenX already applied
    // it to the origin; recover a comparable px radius from two sample points.
    const pxRadius = toScreenX(pulse.distance + radius) - x;

    ctx.strokeStyle = `rgba(148, 218, 255, ${fade * 0.5})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, pxRadius), 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawHunter(
  ctx: CanvasRenderingContext2D,
  game: SonarMaze,
  pulses: Pulse[],
  toScreenX: (worldX: number) => number,
  laneY: (lane: number) => number,
  revealAll: boolean,
): void {
  const flash = revealAll ? 1 : litness(game.hunterDistance, pulses);
  if (flash <= 0) return;

  const x = toScreenX(game.hunterDistance);
  const y = laneY(game.hunterLane);
  ctx.fillStyle = `rgba(248, 113, 113, ${Math.max(0.35, flash)})`;
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  game: SonarMaze,
  x: number,
  y: number,
): void {
  // A faint always-on halo, so the dark screen still has one thing to look
  // at while you wait for a clap — never enough to see a fork by.
  const halo = ctx.createRadialGradient(x, y, 0, x, y, 42);
  halo.addColorStop(0, 'rgba(232, 238, 246, 0.14)');
  halo.addColorStop(1, 'rgba(232, 238, 246, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, 42, 0, Math.PI * 2);
  ctx.fill();

  if (game.celebration > 0) {
    ctx.fillStyle = `rgba(74, 222, 128, ${game.celebration * 0.25})`;
    ctx.beginPath();
    ctx.arc(x, y, 11 * (1 + (1 - game.celebration) * 2.5), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = game.phase === 'over' ? '#f87171' : '#e8eef6';
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fill();
}

function drawHud(ctx: CanvasRenderingContext2D, game: SonarMaze, width: number): void {
  ctx.save();
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(String(game.score), 14, 30);

  const next = game.nextFork();
  if (next?.revealed) {
    ctx.fillStyle = '#8fa3b8';
    ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`next: lane ${next.openLane + 1}`, width - 14, 30);
  }
  ctx.restore();
}
