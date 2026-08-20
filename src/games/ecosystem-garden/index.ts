/**
 * Ecosystem Garden as the shell sees it: a definition, and a Game that owns
 * only its rules and its picture. Everything around it — microphone/file
 * source, canvas, loop, pausing, results, high scores — belongs to
 * `screens/play.ts`.
 *
 * This is the first `GameDefinition` in the project to declare `'file'`
 * support (`sources: ['mic', 'file']`) — see ADR-0012 for how the file path
 * was walked and what, if anything, that surfaced.
 */
import { EcosystemGarden, type Creature, type Predator, type Weather } from './game';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame } from '../../engine/types';

class EcosystemGardenGame implements Game {
  private readonly rules = new EcosystemGarden();

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return 'Play some music, or just let the room settle in — the garden wakes up once it can hear something';
  }

  update(dt: number, frame: Frame): void {
    this.rules.update(dt, { level: frame.level, bands: frame.bands });
  }

  reset(): void {
    this.rules.reset();
  }

  render(surface: Surface): void {
    render(surface, this.rules);
  }
}

export const ecosystemGarden: GameDefinition = {
  id: 'ecosystem-garden',
  title: 'Ecosystem Garden',
  description: 'Tend a garden with your music. Bass grows it, mids populate it, highs are weather — and loud passages bring predators only a shout can scare off.',
  requires: 'room',
  sources: ['mic', 'file'],
  intro:
    'Bass grows the garden, mids spawn creatures, highs bring weather. Loud passages spawn predators — shout or clap loudly to scare them off before they wreck the place.',
  introDetail: 'Play a whole album into the mic, or load a track — either works.',
  // No game audio, and level/bands are read continuously either straight off
  // the room mic or off a file's own output — nothing here for headphones to
  // protect against.
  headphonesRecommended: false,
  readyPrompt: 'Let some sound in to start tending',
  formatScore: (score) => `${Math.round(score)} garden point${Math.round(score) === 1 ? '' : 's'}`,
  create: (_profile: CalibrationProfile) => new EcosystemGardenGame(),
};

const WEATHER_SKY: Record<Weather, [string, string]> = {
  sun: ['#1c2a3a', '#0b0f14'],
  wind: ['#1a2430', '#0b0f14'],
  rain: ['#111a26', '#080b0f'],
};

function render(surface: Surface, game: EcosystemGarden): void {
  const { ctx, width, height } = surface;
  drawSky(ctx, width, height, game.weather);
  drawWeather(ctx, width, height, game);
  drawGround(ctx, width, height);
  drawPlants(ctx, width, height, game);
  for (const creature of game.creatures) drawCreature(ctx, width, height, creature, game.elapsed);
  for (const predator of game.predators) drawPredator(ctx, width, height, predator, game.elapsed);
  if (game.scareFlash > 0) drawScareFlash(ctx, width, height, game.scareFlash);
  if (game.destroyed) drawDestroyedOverlay(ctx, width, height);
  drawHud(ctx, width, game);
}

function drawSky(ctx: CanvasRenderingContext2D, width: number, height: number, weather: Weather): void {
  const [top, bottom] = WEATHER_SKY[weather];
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  if (weather === 'sun') {
    const glow = ctx.createRadialGradient(width * 0.82, height * 0.16, 0, width * 0.82, height * 0.16, width * 0.35);
    glow.addColorStop(0, 'rgba(255, 214, 130, 0.35)');
    glow.addColorStop(1, 'rgba(255, 214, 130, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
  }
}

/** Transient weather dressing only — nothing here is stored state, so this
 *  costs nothing beyond a handful of draw calls no matter how long a session
 *  runs. */
function drawWeather(ctx: CanvasRenderingContext2D, width: number, height: number, game: EcosystemGarden): void {
  if (game.weather === 'rain') {
    ctx.strokeStyle = 'rgba(148, 197, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const drops = 26;
    for (let i = 0; i < drops; i++) {
      const seed = (i * 0.61803399 + game.elapsed * 0.9) % 1;
      const x = seed * width;
      const y = ((i * 0.37812 + game.elapsed * 1.6) % 1) * height;
      ctx.moveTo(x, y);
      ctx.lineTo(x - 4, y + 14);
    }
    ctx.stroke();
  } else if (game.weather === 'wind') {
    ctx.strokeStyle = 'rgba(232, 238, 246, 0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const streaks = 6;
    for (let i = 0; i < streaks; i++) {
      const y = height * (0.1 + i * 0.13);
      const x = ((i * 0.29 + game.elapsed * 0.35) % 1.3) * width - width * 0.15;
      ctx.moveTo(x, y);
      ctx.lineTo(x + 46, y);
    }
    ctx.stroke();
  }
}

function drawGround(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const groundTop = height * 0.78;
  ctx.fillStyle = '#182b1d';
  ctx.fillRect(0, groundTop, width, height - groundTop);
  ctx.fillStyle = 'rgba(74, 222, 128, 0.06)';
  ctx.fillRect(0, groundTop, width, 3);
}

/**
 * Plants aren't simulated objects — `growth` is one scalar, and every slot's
 * height is a pure function of it recomputed here each frame, so there is no
 * per-plant state to leak memory over a long session. Slots bloom in a fixed
 * order but are scattered by a golden-ratio `x`, same "deterministic, no RNG"
 * precedent as the creature/predator placement in `game.ts`.
 */
function drawPlants(ctx: CanvasRenderingContext2D, width: number, height: number, game: EcosystemGarden): void {
  const groundTop = height * 0.78;
  const slots = game.config.plantSlots;
  const maxPlantHeight = height * 0.22;

  for (let i = 0; i < slots; i++) {
    const localGrowth = Math.min(1, Math.max(0, game.growth * slots - i));
    if (localGrowth <= 0) continue;
    const x = ((i * 0.61803399) % 1) * width;
    const plantHeight = maxPlantHeight * (0.35 + localGrowth * 0.65);
    const hue = 96 + ((i * 13) % 40);
    ctx.strokeStyle = `hsla(${hue}, 55%, 45%, ${0.55 + localGrowth * 0.35})`;
    ctx.lineWidth = 2 + localGrowth * 2;
    ctx.beginPath();
    ctx.moveTo(x, groundTop);
    ctx.lineTo(x, groundTop - plantHeight);
    ctx.stroke();
    if (localGrowth > 0.6) {
      ctx.fillStyle = `hsla(${hue + 30}, 70%, 60%, 0.8)`;
      ctx.beginPath();
      ctx.arc(x, groundTop - plantHeight, 3 + localGrowth * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawCreature(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  creature: Creature,
  elapsed: number,
): void {
  const bob = Math.sin(elapsed * 1.6 + creature.id) * height * 0.015;
  const drift = Math.cos(elapsed * 0.7 + creature.id * 1.3) * width * 0.02;
  const x = creature.x * width + drift;
  const y = height * 0.16 + creature.y * height * 0.55 + bob;
  const twinkle = 0.5 + 0.5 * Math.sin(elapsed * 3 + creature.id * 2.1);

  ctx.fillStyle = `rgba(148, 224, 255, ${0.45 + twinkle * 0.4})`;
  ctx.beginPath();
  ctx.arc(x, y, 2.5 + twinkle, 0, Math.PI * 2);
  ctx.fill();
}

function drawPredator(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  predator: Predator,
  elapsed: number,
): void {
  const age = elapsed - predator.spawnedAt;
  const wobble = Math.sin(elapsed * 4 + predator.id) * 4;
  let x = predator.x * width;
  let y = predator.y * height * 0.7 + wobble;
  let scale = Math.min(1, age * 2);
  let alpha = 0.85;

  if (predator.fleeing) {
    const fleeProgress = 1 - predator.fleeRemaining / 1.2;
    const towardEdge = predator.x < 0.5 ? -1 : 1;
    x += towardEdge * fleeProgress * width * 0.25;
    scale *= 1 - fleeProgress * 0.6;
    alpha *= 1 - fleeProgress * 0.7;
  }

  const menace = Math.min(1, predator.aggression / 3);
  const radius = (9 + menace * 6) * scale;
  const r = Math.round(200 + menace * 55);
  const g = Math.round(90 - menace * 60);
  const b = Math.round(90 - menace * 60);

  ctx.fillStyle = `rgba(${r}, ${Math.max(0, g)}, ${Math.max(0, b)}, ${alpha})`;
  ctx.beginPath();
  const spikes = 6;
  for (let i = 0; i < spikes; i++) {
    const angle = (i / spikes) * Math.PI * 2;
    const spikeRadius = i % 2 === 0 ? radius : radius * 0.55;
    const px = x + Math.cos(angle) * spikeRadius;
    const py = y + Math.sin(angle) * spikeRadius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function drawScareFlash(ctx: CanvasRenderingContext2D, width: number, height: number, flash: number): void {
  ctx.fillStyle = `rgba(232, 238, 246, ${flash * 0.18})`;
  ctx.fillRect(0, 0, width, height);
}

function drawDestroyedOverlay(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = 'rgba(60, 12, 12, 0.35)';
  ctx.fillRect(0, 0, width, height);
}

function drawHud(ctx: CanvasRenderingContext2D, width: number, game: EcosystemGarden): void {
  ctx.save();

  // Health bar.
  const barWidth = width * 0.4;
  const barHeight = 8;
  const barX = 14;
  const barY = 14;
  const healthFraction = game.health / game.config.maxHealth;
  ctx.fillStyle = 'rgba(232, 238, 246, 0.15)';
  ctx.fillRect(barX, barY, barWidth, barHeight);
  ctx.fillStyle = healthFraction > 0.35 ? 'rgba(74, 222, 128, 0.85)' : 'rgba(248, 113, 113, 0.9)';
  ctx.fillRect(barX, barY, barWidth * Math.max(0, healthFraction), barHeight);

  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 18px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(String(Math.round(game.score)), barX, barY + barHeight + 26);

  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#8fa3b8';
  ctx.textAlign = 'right';
  const label = game.weather === 'rain' ? 'rain' : game.weather === 'wind' ? 'wind' : 'sun';
  ctx.fillText(`${label} · ${game.creatures.length} creatures`, width - 14, 24);
  if (game.predators.length > 0) {
    ctx.fillStyle = 'rgba(248, 113, 113, 0.9)';
    ctx.fillText(
      `${game.predators.length} predator${game.predators.length === 1 ? '' : 's'} — get loud!`,
      width - 14,
      44,
    );
  }
  ctx.restore();
}
