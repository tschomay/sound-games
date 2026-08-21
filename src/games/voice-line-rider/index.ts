/**
 * Voice Line Rider as the shell sees it: a definition, and a Game that owns
 * only its rules and its picture. Everything around it — microphone, canvas,
 * loop, pausing, results, high scores — belongs to `screens/play.ts`.
 *
 * `render` reads `rules.mode` to pick between two very different pictures — a
 * growing waveform while recording, a terrain-and-marble scene once replaying
 * — the same way Sonar Maze's render reads `crashed`/`caught` for its own
 * extra state. See `game.ts`'s doc comment for why that's a `mode` field
 * rather than a new `RoundPhase`.
 */
import { VoiceLineRider, DEFAULT_CONFIG, MAX_SCORE, SCORE_PER_UNIT } from './game';
import { DEFAULT_PITCH_RANGE } from '../../engine/calibration';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame, PitchRange } from '../../engine/types';

/** Fraction of width/height left as breathing room around the terrain. */
const X_MARGIN = 0.06;
const BAND_MARGIN = 0.14;

/** The score at/above which the marble is within `goalRadius` of the goal —
 *  computed from the config, not measured, so it's exact regardless of the
 *  small variance in how many samples a real round happens to capture (see
 *  `VoiceLineRider.score`, which is normalised against a fixed scale rather
 *  than the recorded contour's actual length). */
const REACHED_SCORE_THRESHOLD = MAX_SCORE - DEFAULT_CONFIG.goalRadius * SCORE_PER_UNIT;

/** Total samples a full recording captures at the default config — used to
 *  size the terrain's coordinate space consistently while it's still filling
 *  in, so the line grows into place rather than stretching to fill the
 *  screen as it goes. */
function totalSamples(config: typeof DEFAULT_CONFIG): number {
  return Math.max(2, Math.floor(config.recordDuration / config.sampleInterval) + 1);
}

class VoiceLineRiderGame implements Game {
  private readonly rules = new VoiceLineRider();

  constructor(private readonly range: PitchRange) {}

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return `Hum for about ${this.rules.config.recordDuration}s — that becomes the terrain`;
  }

  update(dt: number, frame: Frame): void {
    // Replay ignores this entirely inside the rules — see game.ts. It's still
    // passed every frame because the shell always hands one in.
    this.rules.update(dt, { voiced: frame.voiced, pitchNorm: frame.pitchNorm });
  }

  reset(): void {
    this.rules.reset();
  }

  render(surface: Surface): void {
    render(surface, this.rules, this.range);
  }
}

export const voiceLineRider: GameDefinition = {
  id: 'voice-line-rider',
  title: 'Voice Line Rider',
  description: 'Hum a few seconds of tune; a marble rolls down what you sang. Get it to the goal.',
  requires: 'pitchRange',
  sources: ['mic'],
  intro:
    'Hum for a few seconds — your pitch contour becomes a terrain line. Then a marble rolls down what you sang, no more humming needed. Shape the tune so it settles on the goal.',
  introDetail: `Recording lasts ${DEFAULT_CONFIG.recordDuration} seconds once you start humming.`,
  // No game audio, and the mic is only read during the short recording
  // window — the replay that follows needs nothing from it at all, so
  // there's no ongoing listening for a phone speaker to bleed into.
  headphonesRecommended: false,
  accessibilityNote:
    'Needs a few seconds of a hummed, pitched tune, with no alternative input — this one really ' +
    'is built entirely around your own voice. If that is not possible for you, this one is not ' +
    'for you; try Rhythm-Gated Combat or Drop Siege instead, which read music rather than ' +
    'requiring sound from you.',
  readyPrompt: 'Hum to start recording',
  formatScore: (score) => {
    if (score >= REACHED_SCORE_THRESHOLD) return 'Reached the goal!';
    const short = (MAX_SCORE - score) / SCORE_PER_UNIT;
    return `${short.toFixed(1)} units short`;
  },
  create: (profile: CalibrationProfile) => new VoiceLineRiderGame(profile.pitchRange ?? DEFAULT_PITCH_RANGE),
};

function render(surface: Surface, game: VoiceLineRider, range: PitchRange): void {
  const { ctx, width, height } = surface;

  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, width, height);

  if (game.mode === 'recording') {
    drawRecording(ctx, game, width, height);
  } else {
    drawReplay(ctx, game, width, height);
  }
  drawHud(ctx, game, range, width);
}

/** Maps a contour index (0..span) to a screen X, leaving margin on both
 *  sides. `span` is the coordinate space's total width in samples, which
 *  during recording is the *expected* final length, not the partial one so
 *  far, so the line grows into place instead of rescaling every frame. */
function xScale(width: number, span: number): (index: number) => number {
  const usable = width * (1 - 2 * X_MARGIN);
  const denom = Math.max(1, span);
  return (index: number) => width * X_MARGIN + (index / denom) * usable;
}

function yScale(height: number): (value: number) => number {
  const bandTop = height * BAND_MARGIN;
  const bandHeight = height * (1 - BAND_MARGIN * 2);
  return (value: number) => bandTop + (1 - value) * bandHeight;
}

function drawRecording(
  ctx: CanvasRenderingContext2D,
  game: VoiceLineRider,
  width: number,
  height: number,
): void {
  const span = totalSamples(game.config) - 1;
  const toX = xScale(width, span);
  const toY = yScale(height);

  if (game.contour.length > 1) {
    ctx.save();
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    game.contour.forEach((value, i) => {
      const x = toX(i);
      const y = toY(value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  // A pulsing dot at the pen's current position — reads as "still listening"
  // even during a held note where the line itself isn't visibly growing.
  if (game.contour.length > 0) {
    const last = game.contour.length - 1;
    ctx.fillStyle = '#4ade80';
    ctx.beginPath();
    ctx.arc(toX(last), toY(game.contour[last]), 6, 0, Math.PI * 2);
    ctx.fill();
  }

  const progress = Math.min(1, game.elapsed / game.config.recordDuration);
  ctx.fillStyle = 'rgba(143, 163, 184, 0.18)';
  ctx.fillRect(0, height - 8, width, 8);
  ctx.fillStyle = '#4ade80';
  ctx.fillRect(0, height - 8, width * progress, 8);

  ctx.save();
  ctx.fillStyle = '#8fa3b8';
  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText('recording…', 14, 24);
  ctx.restore();
}

function drawReplay(
  ctx: CanvasRenderingContext2D,
  game: VoiceLineRider,
  width: number,
  height: number,
): void {
  const span = game.contour.length - 1;
  const toX = xScale(width, span);
  const toY = yScale(height);

  drawTerrain(ctx, game, height, toX, toY);
  drawGoal(ctx, game, height, toX);
  drawMarble(ctx, game, toX, toY);
}

function drawTerrain(
  ctx: CanvasRenderingContext2D,
  game: VoiceLineRider,
  height: number,
  toX: (index: number) => number,
  toY: (value: number) => number,
): void {
  if (game.contour.length < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(toX(0), height);
  game.contour.forEach((value, i) => ctx.lineTo(toX(i), toY(value)));
  ctx.lineTo(toX(game.contour.length - 1), height);
  ctx.closePath();
  ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
  ctx.fill();

  ctx.beginPath();
  game.contour.forEach((value, i) => {
    const x = toX(i);
    const y = toY(value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = 'rgba(148, 197, 255, 0.7)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawGoal(
  ctx: CanvasRenderingContext2D,
  game: VoiceLineRider,
  height: number,
  toX: (index: number) => number,
): void {
  const left = toX(game.goalX - game.config.goalRadius);
  const right = toX(game.goalX + game.config.goalRadius);

  ctx.fillStyle = game.reached ? 'rgba(74, 222, 128, 0.28)' : 'rgba(232, 238, 246, 0.12)';
  ctx.fillRect(left, 0, right - left, height);

  ctx.strokeStyle = game.reached ? 'rgba(74, 222, 128, 0.8)' : 'rgba(232, 238, 246, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 5]);
  const x = toX(game.goalX);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawMarble(
  ctx: CanvasRenderingContext2D,
  game: VoiceLineRider,
  toX: (index: number) => number,
  toY: (value: number) => number,
): void {
  const x = toX(game.marbleX);
  const y = toY(game.heightAt(game.marbleX));
  const radius = 10;

  if (game.celebration > 0) {
    ctx.fillStyle = `rgba(74, 222, 128, ${game.celebration * 0.3})`;
    ctx.beginPath();
    ctx.arc(x, y, radius * (1 + (1 - game.celebration) * 2.5), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = game.phase === 'over' && game.reached ? '#4ade80' : '#e8eef6';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  game: VoiceLineRider,
  range: PitchRange,
  width: number,
): void {
  if (game.mode !== 'replaying') return;
  ctx.save();
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(game.reached ? 'On target' : String(game.score), 14, 30);

  ctx.fillStyle = '#8fa3b8';
  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`range: ${Math.round(range.lowHz)}–${Math.round(range.highHz)}Hz`, width - 14, 30);
  ctx.restore();
}
