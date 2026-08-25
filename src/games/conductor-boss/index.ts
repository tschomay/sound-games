/**
 * Conductor Boss as the shell sees it: a definition, and a Game that owns only
 * its rules and its picture. Everything around it — the mic/file gate,
 * canvas, loop, pausing, restarts, results, high scores — belongs to
 * `screens/play.ts`.
 *
 * Lane switching is a tap, not a Frame field — see ADR-0006, and `game.ts`'s
 * own doc comment for why. This file owns the tap listener (`Game` has no
 * `onInput` of its own) and reuses Drop Siege's exact
 * `laneFromFraction`/`laneCenterY` shape: the canvas is divided into three
 * equal horizontal bands, top-to-bottom high-to-bass, so a tap anywhere in a
 * band moves the player into that lane.
 */
import { ConductorBoss, LANE_COUNT, type BossAttack, type Lane } from './game';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame } from '../../engine/types';

/** Top-to-bottom on screen is high-to-bass, same convention Drop Siege uses,
 *  so a player's ear and eye agree on where a threat sits. */
const LANE_ORDER: readonly Lane[] = [2, 1, 0];

class ConductorBossGame implements Game {
  private readonly rules = new ConductorBoss();
  private boundCanvas: HTMLCanvasElement | null = null;

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return 'Play some music, or let the room settle in — the boss wakes up once it can hear something';
  }

  update(dt: number, frame: Frame): void {
    this.rules.update(dt, { bands: frame.bands, onset: frame.onset, level: frame.level });
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
      this.rules.setLane(laneFromFraction(fraction));
    });
  }
}

/** Which lane a tap at this vertical fraction of the canvas selects — the
 *  inverse of `laneCenterY` below, so tap zones line up with what's drawn.
 *  Clamped, so a tap right at an edge still resolves to a legal lane. */
function laneFromFraction(fraction: number): Lane {
  const zone = Math.min(2, Math.max(0, Math.floor(fraction * 3)));
  return LANE_ORDER[zone];
}

function laneCenterY(lane: Lane): number {
  const zone = LANE_ORDER.indexOf(lane);
  return (zone + 0.5) / 3;
}

export const conductorBoss: GameDefinition = {
  id: 'conductor-boss',
  title: 'Conductor Boss',
  category: 'music',
  description:
    "A single boss fight where every attack is the song itself, live: a bass hit telegraphs a ground slam, a bright onset telegraphs a projectile aimed at your lane. Dodge to counter, get caught to take damage.",
  requires: 'room',
  sources: ['mic', 'file'],
  intro:
    "Face the boss across three lanes. A bass hit telegraphs, then slams every lane but one safe one — get into it. A bright, non-bass onset telegraphs a projectile aimed at whatever lane you're standing in — get out of it. Dodge either and it counters for boss damage; get caught and it costs you.",
  introDetail: 'Works the same on a live mic or a loaded file — every attack is decided off whatever is actually sounding right now, not scripted in advance.',
  // No game audio of its own, and bands/onset are read continuously off
  // whatever's actually playing — nothing here for headphones to protect,
  // same reasoning as Ecosystem Garden and Rhythm-Gated Combat.
  headphonesRecommended: false,
  accessibilityNote:
    'The only thing you personally do is tap a lane — dodging never requires producing any ' +
    'sound yourself. It works identically whether the music comes from the room mic or a ' +
    'loaded file, so it is fully playable with headphones on, from a file, with no sound from ' +
    'you at all.',
  readyPrompt: 'Let some music in to wake the boss',
  formatScore: (score) => `${score} counter${score === 1 ? '' : 's'}`,
  create: (_profile: CalibrationProfile) => new ConductorBossGame(),
};

function render(surface: Surface, game: ConductorBoss): void {
  const { ctx, width, height } = surface;
  ctx.fillStyle = '#0a0a10';
  ctx.fillRect(0, 0, width, height);

  drawLanes(ctx, width, height, game);
  drawBoss(ctx, width, height, game);
  drawPlayer(ctx, width, height, game);
  drawFlashes(ctx, width, height, game);
  drawHud(ctx, width, height, game);

  if (game.phase === 'over') drawOverBanner(ctx, width, height, game);
}

/**
 * The lane bands themselves, plus whatever the current attack is telegraphing
 * or executing. A slam highlights the two *unsafe* lanes (danger everywhere
 * except its one safe lane); a projectile highlights only its one *targeted*
 * lane — the opposite shape, matching `game.ts`'s own reasoning for picking
 * three lanes in the first place. Intensity ramps up across the telegraph
 * (`progress` 0..1) so the danger visibly builds toward the moment it lands,
 * then holds at full brightness for the short 'executing' flash.
 */
function drawLanes(ctx: CanvasRenderingContext2D, width: number, height: number, game: ConductorBoss): void {
  const bandHeight = height / LANE_COUNT;

  for (const lane of LANE_ORDER) {
    const y = laneCenterY(lane) * height;
    ctx.fillStyle = 'rgba(232, 238, 246, 0.03)';
    ctx.fillRect(0, y - bandHeight / 2, width, bandHeight - 2);
    ctx.strokeStyle = 'rgba(232, 238, 246, 0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, y - bandHeight / 2, width, bandHeight - 2);
  }

  const attack = game.attack;
  if (!attack) return;
  const progress = attackProgress(attack, game);

  if (attack.kind === 'slam') {
    for (const lane of LANE_ORDER) {
      const y = laneCenterY(lane) * height;
      if (lane === attack.lane) {
        drawLaneOverlay(ctx, y, bandHeight, width, `rgba(74, 222, 128, ${0.25 + progress * 0.35})`);
      } else {
        const alpha = attack.stage === 'executing' ? 0.55 : 0.12 + progress * 0.3;
        drawLaneOverlay(ctx, y, bandHeight, width, `rgba(244, 63, 94, ${alpha})`);
      }
    }
  } else {
    const y = laneCenterY(attack.lane) * height;
    const alpha = attack.stage === 'executing' ? 0.65 : 0.15 + progress * 0.4;
    drawLaneOverlay(ctx, y, bandHeight, width, `rgba(250, 204, 21, ${alpha})`);
  }
}

function drawLaneOverlay(
  ctx: CanvasRenderingContext2D,
  y: number,
  bandHeight: number,
  width: number,
  fillStyle: string,
): void {
  ctx.fillStyle = fillStyle;
  ctx.fillRect(0, y - bandHeight / 2, width, bandHeight - 2);
}

/** 0 at the start of the telegraph, 1 the instant it resolves — used purely
 *  to ramp visual intensity, never gameplay (see `game.ts`'s `resolveAttack`
 *  for where the real decision happens). Clamped to 1 during 'executing' so
 *  the flash reads as fully lit rather than snapping back down. */
function attackProgress(attack: BossAttack, game: ConductorBoss): number {
  if (attack.stage === 'executing') return 1;
  const windup = game.config.windupSeconds;
  if (windup <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - attack.remaining / windup));
}

/** A simple shape — this is a small canvas game, not an art project. A
 *  diamond that grows and glows brighter the closer an attack is to landing,
 *  and flashes hardest during the brief 'executing' stage — the "wind-up vs.
 *  executing" visual distinction the brief asks for lives here as much as in
 *  the lane overlays above. */
function drawBoss(ctx: CanvasRenderingContext2D, width: number, height: number, game: ConductorBoss): void {
  const x = width / 2;
  const y = height * 0.13;
  const attack = game.attack;
  const progress = attack ? attackProgress(attack, game) : 0;
  const pulse = 0.5 + 0.5 * Math.sin(game.elapsed * 2.4);
  const baseRadius = 20 + pulse * 3;
  const radius = attack ? baseRadius * (1 + progress * (attack.stage === 'executing' ? 0.9 : 0.5)) : baseRadius;
  const color = attack?.kind === 'slam' ? '244, 63, 94' : attack?.kind === 'projectile' ? '250, 204, 21' : '148, 218, 255';
  const alpha = attack ? 0.55 + progress * 0.4 : 0.5;

  ctx.save();
  ctx.shadowColor = `rgba(${color}, ${attack ? 0.7 : 0.25})`;
  ctx.shadowBlur = attack ? 14 + progress * 18 : 8;
  ctx.fillStyle = `rgba(${color}, ${alpha})`;
  ctx.beginPath();
  ctx.moveTo(x, y - radius);
  ctx.lineTo(x + radius * 0.75, y);
  ctx.lineTo(x, y + radius);
  ctx.lineTo(x - radius * 0.75, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  if (attack) {
    ctx.fillStyle = 'rgba(232, 238, 246, 0.85)';
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const label = attack.stage === 'telegraph' ? (attack.kind === 'slam' ? 'WIND-UP' : 'AIMING') : 'STRIKE';
    ctx.fillText(label, x, y + radius + 16);
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, width: number, height: number, game: ConductorBoss): void {
  const x = width / 2;
  const y = laneCenterY(game.playerLane) * height;
  const glow = game.hurtFlash > 0 ? 'rgba(248, 113, 113, 0.9)' : game.counterFlash > 0 ? 'rgba(74, 222, 128, 0.9)' : '#e8eef6';

  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = game.hurtFlash > 0 || game.counterFlash > 0 ? 16 : 0;
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFlashes(ctx: CanvasRenderingContext2D, width: number, height: number, game: ConductorBoss): void {
  if (game.hurtFlash > 0) {
    ctx.fillStyle = `rgba(248, 113, 113, ${game.hurtFlash * 0.22})`;
    ctx.fillRect(0, 0, width, height);
  }
  if (game.counterFlash > 0) {
    ctx.fillStyle = `rgba(74, 222, 128, ${game.counterFlash * 0.18})`;
    ctx.fillRect(0, 0, width, height);
  }
}

function drawHud(ctx: CanvasRenderingContext2D, width: number, height: number, game: ConductorBoss): void {
  ctx.save();

  // Boss health bar, top centre — the thing you're actually here to beat.
  const bossBarWidth = width * 0.6;
  const bossBarX = (width - bossBarWidth) / 2;
  const bossBarY = 10;
  const bossFraction = Math.max(0, game.bossHealth / game.config.bossStartHealth);
  ctx.fillStyle = 'rgba(232, 238, 246, 0.12)';
  ctx.fillRect(bossBarX, bossBarY, bossBarWidth, 7);
  ctx.fillStyle = 'rgba(244, 63, 94, 0.85)';
  ctx.fillRect(bossBarX, bossBarY, bossBarWidth * bossFraction, 7);

  // Player health, bottom-left hearts — same idiom Drop Siege uses.
  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#f87171';
  ctx.textAlign = 'left';
  const hearts = '♥'.repeat(Math.max(0, Math.ceil(game.health)));
  ctx.fillText(hearts || '—', 14, height - 14);

  // Score, top-left.
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(String(game.score), 14, 34);

  ctx.restore();
}

function drawOverBanner(ctx: CanvasRenderingContext2D, width: number, height: number, game: ConductorBoss): void {
  ctx.fillStyle = game.victory ? 'rgba(74, 222, 128, 0.12)' : 'rgba(60, 12, 12, 0.35)';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = game.victory ? '#4ade80' : '#f87171';
  ctx.font = '700 22px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(game.victory ? 'BOSS DOWN' : 'DEFEATED', width / 2, height / 2);
}
