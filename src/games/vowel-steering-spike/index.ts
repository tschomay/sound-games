/**
 * Vowel Steering (spike) as the shell sees it: a definition, and a Game that
 * owns only its rules and its picture. Everything around it — microphone,
 * canvas, loop, pausing, results, high scores — belongs to `screens/play.ts`.
 *
 * This is a feasibility spike (A5 in `ideas.md`, Phase 5 in `roadmap.md`), not
 * a finished game — it's registered and deployed like every other game
 * specifically so it can be played on a real phone with a real microphone,
 * which is the only way to answer the question it exists to answer: do pitch
 * and vowel brightness feel like two independently steerable axes, or does
 * moving one visibly drag the other? Title, copy and id all say "spike" on
 * purpose so it never gets mistaken for a committed game.
 */
import { VowelSteeringSpike, DEFAULT_CONFIG, DEFAULT_VOWEL_RANGE } from './game';
import { DEFAULT_PITCH_RANGE } from '../../engine/calibration';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame, PitchRange } from '../../engine/types';
import type { VowelRange } from './game';

class VowelSteeringSpikeGame implements Game {
  private readonly rules = new VowelSteeringSpike();
  private centroidHz = 0;

  constructor(
    private readonly pitchRange: PitchRange,
    private readonly vowelRange: VowelRange,
  ) {}

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return `${DEFAULT_CONFIG.roundDuration}s. Hit as many targets as you can.`;
  }

  update(dt: number, frame: Frame): void {
    this.centroidHz = frame.centroid;
    this.rules.update(dt, { voiced: frame.voiced, pitchNorm: frame.pitchNorm, centroid: frame.centroid });
  }

  reset(): void {
    this.rules.reset();
    this.centroidHz = 0;
  }

  render(surface: Surface): void {
    render(surface, this.rules, this.pitchRange, this.vowelRange, this.centroidHz);
  }
}

export const vowelSteeringSpike: GameDefinition = {
  id: 'vowel-steering-spike',
  title: 'Vowel Steering (spike)',
  description:
    'Feasibility test, not a finished game: pitch steers up/down, vowel shape ("ee"–"oo") steers left/right. Might not feel great yet.',
  requires: 'pitchRange',
  sources: ['mic'],
  intro:
    "This is a spike, not a finished game. Testing whether pitch and vowel shape make two usable axes. Hum a note: pitch moves the reticle up/down, and shifting the vowel shape of your hum — toward \"ee\" or toward \"oo\" — moves it left/right. Steer onto the ring to score. Might not feel great yet — that's exactly what this is testing.",
  introDetail: `${DEFAULT_CONFIG.roundDuration} seconds per round. Raw axis numbers are shown on screen the whole time.`,
  headphonesRecommended: false,
  readyPrompt: 'Hum to start steering',
  formatScore: (score) => `${score} target${score === 1 ? '' : 's'}`,
  create: (profile: CalibrationProfile) =>
    new VowelSteeringSpikeGame(profile.pitchRange ?? DEFAULT_PITCH_RANGE, DEFAULT_VOWEL_RANGE),
};

/** Fraction of the shorter screen dimension the square steering field occupies. */
const FIELD_FRACTION = 0.72;

function render(
  surface: Surface,
  game: VowelSteeringSpike,
  pitchRange: PitchRange,
  vowelRange: VowelRange,
  centroidHz: number,
): void {
  const { ctx, width, height } = surface;

  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, width, height);

  const size = Math.min(width, height) * FIELD_FRACTION;
  const left = (width - size) / 2;
  const top = (height - size) / 2 + height * 0.03;
  const toScreen = (x: number, y: number): [number, number] => [left + x * size, top + (1 - y) * size];

  drawField(ctx, left, top, size);
  drawTarget(ctx, game, toScreen, size);
  drawReticle(ctx, game, toScreen, size);
  drawAxisLabels(ctx, left, top, size);
  drawReadout(ctx, game, pitchRange, vowelRange, centroidHz);
  drawHud(ctx, game, width);
}

function drawField(ctx: CanvasRenderingContext2D, left: number, top: number, size: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(143, 163, 184, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(left, top, size, size);

  // A light crosshair grid at the quarter marks, purely to make "did the dot
  // move sideways" easier to judge at a glance than a blank field would.
  ctx.strokeStyle = 'rgba(143, 163, 184, 0.12)';
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(left + frac * size, top);
    ctx.lineTo(left + frac * size, top + size);
    ctx.moveTo(left, top + frac * size);
    ctx.lineTo(left + size, top + frac * size);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTarget(
  ctx: CanvasRenderingContext2D,
  game: VowelSteeringSpike,
  toScreen: (x: number, y: number) => [number, number],
  size: number,
): void {
  const [x, y] = toScreen(game.target.x, game.target.y);
  const radius = game.config.targetRadius * size;

  ctx.save();
  ctx.strokeStyle = 'rgba(148, 197, 255, 0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawReticle(
  ctx: CanvasRenderingContext2D,
  game: VowelSteeringSpike,
  toScreen: (x: number, y: number) => [number, number],
  size: number,
): void {
  const [x, y] = toScreen(game.reticleX, game.reticleY);
  const radius = size * 0.02;

  if (game.celebration > 0) {
    ctx.fillStyle = `rgba(74, 222, 128, ${game.celebration * 0.3})`;
    ctx.beginPath();
    ctx.arc(x, y, radius * (1 + (1 - game.celebration) * 3), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#4ade80';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawAxisLabels(ctx: CanvasRenderingContext2D, left: number, top: number, size: number): void {
  ctx.save();
  ctx.fillStyle = '#8fa3b8';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';

  ctx.textAlign = 'center';
  ctx.fillText('pitch: high', left + size / 2, top - 8);
  ctx.fillText('pitch: low', left + size / 2, top + size + 18);

  ctx.save();
  ctx.translate(left - 10, top + size / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('"oo" (dark)', -size * 0.25, 0);
  ctx.fillText('"ee" (bright)', size * 0.25, 0);
  ctx.restore();
  ctx.restore();
}

/**
 * The whole point of this spike: both raw axis readings on screen at once,
 * live, so a tester can watch whether nudging pitch alone visibly moves the
 * vowel number too. Mirrors `screens/scope.ts`'s live readouts, embedded in
 * the game itself instead of a separate diagnostic screen.
 */
function drawReadout(
  ctx: CanvasRenderingContext2D,
  game: VowelSteeringSpike,
  pitchRange: PitchRange,
  vowelRange: VowelRange,
  centroidHz: number,
): void {
  const pitchText =
    game.lastPitchNorm === null ? 'pitch: --' : `pitch: ${game.lastPitchNorm.toFixed(2)}`;
  const vowelText =
    game.lastVowelNorm === null
      ? 'vowel: --'
      : `vowel: ${game.lastVowelNorm.toFixed(2)} (${Math.round(centroidHz)}Hz)`;

  ctx.save();
  ctx.font = '13px ui-monospace, ui-sans-serif, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#4ade80';
  ctx.fillText(pitchText, 14, 56);
  ctx.fillStyle = '#94c5ff';
  ctx.fillText(vowelText, 14, 74);

  ctx.fillStyle = '#546578';
  ctx.font = '11px ui-monospace, ui-sans-serif, monospace';
  ctx.fillText(
    `pitch range ${Math.round(pitchRange.lowHz)}–${Math.round(pitchRange.highHz)}Hz · vowel range ${Math.round(vowelRange.lowHz)}–${Math.round(vowelRange.highHz)}Hz`,
    14,
    92,
  );
  ctx.restore();
}

function drawHud(ctx: CanvasRenderingContext2D, game: VowelSteeringSpike, width: number): void {
  ctx.save();
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(String(game.score), width - 60, 30);

  ctx.fillStyle = '#8fa3b8';
  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.ceil(game.timeRemaining)}s`, width - 14, 52);
  ctx.restore();
}
