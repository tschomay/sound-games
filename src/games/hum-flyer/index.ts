/**
 * Hum Flyer as the shell sees it: a definition, and a Game that owns only its
 * rules and its picture. Everything around it — microphone, canvas, loop,
 * pausing, results, high scores — belongs to `screens/play.ts`.
 */
import { hzToNote } from '../../engine/pitch';
import { DEFAULT_PITCH_RANGE } from '../../engine/calibration';
import { HumFlyer, MELODIES, type Gate } from './game';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame, PitchRange } from '../../engine/types';

/** Fraction of the screen width the flyer sits at. */
const FLYER_X = 0.28;
/**
 * How much of the course fits across the screen, in world units. A phone in
 * portrait is narrow, and this is what decides how many gates — how much of the
 * melody — you can read ahead of you.
 */
const VISIBLE_WORLD = 2.4;
/** Vertical padding so the flyer never touches the very edge of the canvas. */
const BAND_MARGIN = 0.08;

class HumFlyerGame implements Game {
  private readonly rules: HumFlyer;
  private pitchNorm: number | null = null;

  constructor(private readonly range: PitchRange) {
    this.rules = new HumFlyer(undefined, Math.floor(Math.random() * MELODIES.length));
  }

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return `Gaps follow "${this.rules.melody.name}"`;
  }

  update(dt: number, frame: Frame): void {
    this.pitchNorm = frame.pitchNorm;
    this.rules.update(dt, frame);
  }

  reset(): void {
    this.rules.reset();
  }

  render(surface: Surface): void {
    render(surface, this.rules, this.range, this.pitchNorm);
  }
}

export const humFlyer: GameDefinition = {
  id: 'hum-flyer',
  title: 'Hum Flyer',
  description: 'Hum to fly. Higher note, higher flight. Thread the gaps.',
  requires: 'pitchRange',
  sources: ['mic'],
  intro: 'Hum to fly — the higher your note, the higher you fly. The gaps trace a melody.',
  introDetail: 'Stop humming and you fall. Headphones recommended.',
  readyPrompt: 'Hum to take off',
  formatScore: (score) => `${score} ${score === 1 ? 'gate' : 'gates'}`,
  create: (profile: CalibrationProfile) =>
    new HumFlyerGame(profile.pitchRange ?? DEFAULT_PITCH_RANGE),
};

function render(
  surface: Surface,
  game: HumFlyer,
  range: PitchRange,
  pitchNorm: number | null,
): void {
  const { ctx, width, height } = surface;
  const bandTop = height * BAND_MARGIN;
  const bandHeight = height * (1 - BAND_MARGIN * 2);
  const toY = (value: number): number => bandTop + (1 - value) * bandHeight;
  const worldScale = width / VISIBLE_WORLD;
  const flyerX = width * FLYER_X;

  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, width, height);

  drawMelodyLine(ctx, game, flyerX, worldScale, toY);
  for (const gate of game.gates) {
    drawGate(ctx, gate, game, flyerX, worldScale, toY, height, width);
  }
  drawPitchGuide(ctx, pitchNorm, width, toY);
  drawFlyer(ctx, game, flyerX, toY, surface);
  drawHud(ctx, game, range, width);
}

function drawMelodyLine(
  ctx: CanvasRenderingContext2D,
  game: HumFlyer,
  flyerX: number,
  worldScale: number,
  toY: (value: number) => number,
): void {
  if (game.gates.length === 0) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(143, 163, 184, 0.28)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  game.gates.forEach((gate, index) => {
    const x = flyerX + (gate.x - game.distance) * worldScale;
    const y = toY(gate.centre);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawGate(
  ctx: CanvasRenderingContext2D,
  gate: Gate,
  game: HumFlyer,
  flyerX: number,
  worldScale: number,
  toY: (value: number) => number,
  height: number,
  screenWidth: number,
): void {
  const x = flyerX + (gate.x - game.distance) * worldScale;
  const columnWidth = Math.max(14, game.config.radius * 2 * worldScale);
  if (x + columnWidth < 0 || x - columnWidth > screenWidth) return;

  const top = toY(gate.centre + gate.halfGap);
  const bottom = toY(gate.centre - gate.halfGap);

  ctx.fillStyle = gate.cleared ? 'rgba(74, 222, 128, 0.35)' : 'rgba(56, 189, 248, 0.55)';
  ctx.fillRect(x - columnWidth / 2, 0, columnWidth, top);
  ctx.fillRect(x - columnWidth / 2, bottom, columnWidth, height - bottom);

  // A soft mouth on the gap edges reads much better on a small screen than a
  // hard rectangle end.
  ctx.fillStyle = 'rgba(232, 238, 246, 0.5)';
  ctx.fillRect(x - columnWidth / 2, top - 2, columnWidth, 2);
  ctx.fillRect(x - columnWidth / 2, bottom, columnWidth, 2);
}

function drawPitchGuide(
  ctx: CanvasRenderingContext2D,
  pitchNorm: number | null,
  width: number,
  toY: (value: number) => number,
): void {
  if (pitchNorm === null) return;
  const y = toY(pitchNorm);
  ctx.save();
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(width, y);
  ctx.stroke();
  ctx.restore();
}

function drawFlyer(
  ctx: CanvasRenderingContext2D,
  game: HumFlyer,
  flyerX: number,
  toY: (value: number) => number,
  surface: Surface,
): void {
  const radius = game.config.radius * surface.height * (1 - BAND_MARGIN * 2);
  const y = toY(game.height);

  if (game.celebration > 0) {
    ctx.fillStyle = `rgba(74, 222, 128, ${game.celebration * 0.25})`;
    ctx.beginPath();
    ctx.arc(flyerX, y, radius * (1 + (1 - game.celebration) * 2.5), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = game.phase === 'over' ? '#f87171' : '#4ade80';
  ctx.beginPath();
  ctx.arc(flyerX, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  game: HumFlyer,
  range: PitchRange,
  width: number,
): void {
  ctx.save();
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(String(game.score), 14, 30);

  const next = game.nextGate();
  if (next) {
    ctx.fillStyle = '#8fa3b8';
    ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`next: ${noteForCentre(next.centre, range)}`, width - 14, 30);
  }
  ctx.restore();
}

/** The note a gap sits at, so the player can learn the tune by name. */
function noteForCentre(centre: number, range: PitchRange): string {
  const span = Math.log2(range.highHz / range.lowHz);
  const hz = range.lowHz * Math.pow(2, centre * span);
  const note = hzToNote(hz);
  return `${note.name}${note.octave}`;
}
