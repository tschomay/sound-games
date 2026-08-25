/**
 * Trackgen as the shell sees it: a definition, and a Game that owns only its
 * rules and its picture. Everything around it — the file gate, canvas, loop,
 * pausing, results, high scores — belongs to `screens/play.ts`.
 *
 * `sources: ['file']` — file-only, same reasoning as Drop Siege: the whole
 * point (`docs/ideas.md` B5) is a level generated from the *whole* track
 * before a single note of it plays, which a live mic stream cannot offer.
 *
 * **Generating the level is this game's own problem, not shared plumbing's**
 * — same posture Drop Siege takes toward `analyseSongStructure`. This module
 * reads `currentSession()?.source` itself and runs the whole offline pipeline
 * — `analyseSongStructure`, this game's own `computeSectionBrightness`, and
 * `computeOnsetEnvelope` plus a simple peak-picker — once, lazily, the first
 * `update()` after a file session exists. **Playback is paused for that
 * analysis**, the same `pausedForAnalysis` mechanism Drop Siege uses, because
 * `play.ts` starts a file playing before this game gets any say.
 *
 * Unlike Drop Siege, the round does not start the instant analysis finishes:
 * `Trackgen.jump()` only starts the round on the player's first tap (mirroring
 * Sonar Maze's "the one verb both starts and drives the game"), so playback
 * stays paused — via the same `pausedForAnalysis` flag, which only clears once
 * `rules.phase` reaches `'playing'` — until that tap actually lands.
 */
import { Trackgen, type RuntimeCollectible } from './game';
import { computeSectionBrightness } from './sectionBrightness';
import { currentSession } from '../../engine/session';
import { analyseSongStructure } from '../../engine/sections';
import { computeOnsetEnvelope, type OnsetEnvelope } from '../../engine/beat-offline';
import { isFileSource, type FileSource } from '../../engine/source';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame } from '../../engine/types';

/** Fraction of the screen width the player marker sits at. */
const PLAYER_X = 0.22;
/** How much of the course fits across the screen, in world units. At the
 *  default `worldUnitsPerSecond` (4) this is a 3-second window, giving a
 *  little over 2 seconds of advance notice on an approaching collectible —
 *  short, because unlike Overtone's ramping speed this game always scrolls at
 *  exactly the track's own real-time pace, but enough to read and react. */
const VISIBLE_WORLD = 12;
/** Fraction of the canvas height the baseline sits at. */
const GROUND_FRACTION = 0.72;
/** Pixels of rise per world unit of jump/pickup height. */
const HEIGHT_SCALE = 220;
/** Fraction of the canvas height the section timeline strip occupies. */
const TIMELINE_FRACTION = 0.12;

/** Minimum spacing between placed collectibles, in seconds — so a busy
 *  passage doesn't pack them shoulder to shoulder. Tighter inside the drop
 *  section, so the track's climax reads as the densest chapter. */
const MIN_COLLECTIBLE_SPACING_SECONDS = 0.55;
const DROP_COLLECTIBLE_SPACING_SECONDS = 0.3;
/** A peak must clear this fraction of the envelope's own whole-track maximum
 *  to place a collectible — a simple, honest threshold rather than a
 *  statistically fitted one, per the brief's "simple local-maximum-above-a-
 *  threshold scan". */
const PEAK_FRACTION = 0.18;

class TrackgenGame implements Game {
  private readonly rules = new Trackgen();
  private levelState: 'idle' | 'analysing' | 'ready' = 'idle';
  private pausedForAnalysis = false;
  private boundCanvas: HTMLCanvasElement | null = null;

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return this.levelState === 'ready' ? this.rules.readyHint : 'Analysing the track';
  }

  update(dt: number, _frame: Frame): void {
    const source = this.fileSource();
    this.ensureLevel(source);

    const positionSeconds = source?.position() ?? 0;
    this.rules.update(dt, { positionSeconds });

    if (this.pausedForAnalysis && this.rules.phase === 'playing') {
      this.pausedForAnalysis = false;
      source?.play();
    }
  }

  reset(): void {
    this.rules.reset();
    // A fresh round replays the same generated level from the top — the
    // whole point of "collectibles authored at a given second" is the
    // authored placement, which a round starting mid-track would scramble.
    const source = this.fileSource();
    if (source) {
      this.pausedForAnalysis = true;
      source.pause();
      source.seek(0);
    }
  }

  render(surface: Surface): void {
    this.attachInput(surface.canvas);
    render(surface, this.rules, this.levelState);
  }

  private fileSource(): FileSource | null {
    const session = currentSession();
    return session && isFileSource(session.source) ? session.source : null;
  }

  private ensureLevel(source: FileSource | null): void {
    if (!source || this.levelState !== 'idle') return;
    this.levelState = 'analysing';
    this.pausedForAnalysis = true;
    source.pause();
    // Yield one tick so the "Analysing…" overlay actually paints before the
    // synchronous pass below blocks the main thread — same trick Drop Siege
    // (and `source-picker.ts`'s beat grid, ADR-0011) already use.
    setTimeout(() => {
      const structure = analyseSongStructure(source.buffer);
      const sectionCentroidHz = computeSectionBrightness(source.buffer, structure.sections);
      const envelope = computeOnsetEnvelope(source.buffer);
      const dropSection = structure.dropIndex !== null ? structure.sections[structure.dropIndex] : null;
      const collectibleSeconds = pickCollectibleTimestamps(envelope, dropSection);
      this.rules.configureTrack(structure, sectionCentroidHz, collectibleSeconds);
      this.levelState = 'ready';
    }, 0);
  }

  private attachInput(canvas: HTMLCanvasElement): void {
    if (this.boundCanvas === canvas) return;
    this.boundCanvas = canvas;
    canvas.addEventListener('pointerdown', () => this.rules.jump());
  }
}

/**
 * Onset-peak collectible placement: a local maximum in the whole-track onset
 * envelope, clearing `PEAK_FRACTION` of the envelope's own maximum, with a
 * minimum spacing so nothing packs shoulder to shoulder — exactly the "simple
 * local-maximum-above-a-threshold scan" the brief asks for, nothing more
 * elaborate. Spacing tightens inside the drop section (when there is one) so
 * the track's climax reads as the densest chapter, per the brief's "densest
 * ... chapter" requirement for the drop.
 */
function pickCollectibleTimestamps(
  envelope: OnsetEnvelope,
  dropSection: { startSeconds: number; endSeconds: number } | null,
): number[] {
  const { values, hopSeconds, firstFrameSeconds } = envelope;
  if (values.length === 0) return [];

  let peak = 0;
  for (const value of values) if (value > peak) peak = value;
  if (peak <= 0) return [];
  const threshold = peak * PEAK_FRACTION;

  const timestamps: number[] = [];
  let lastAt = -Infinity;
  for (let i = 1; i < values.length - 1; i++) {
    if (values[i] < threshold) continue;
    if (values[i] < values[i - 1] || values[i] < values[i + 1]) continue;

    const at = firstFrameSeconds + i * hopSeconds;
    const inDrop = dropSection !== null && at >= dropSection.startSeconds && at < dropSection.endSeconds;
    const minSpacing = inDrop ? DROP_COLLECTIBLE_SPACING_SECONDS : MIN_COLLECTIBLE_SPACING_SECONDS;
    if (at - lastAt < minSpacing) continue;

    timestamps.push(at);
    lastAt = at;
  }
  return timestamps;
}

export const trackgen: GameDefinition = {
  id: 'trackgen',
  title: 'Trackgen',
  category: 'music',
  description:
    'Load a track and get a level generated from it: its sections become biomes coloured by their own brightness, and its onsets become notes to jump for as your own chapter of the song scrolls by.',
  requires: 'room',
  sources: ['file'],
  intro:
    "Load a track. Its structure becomes the level — one biome per section, coloured by that section's own brightness, brightest and busiest at the track's own drop — and its onsets become notes scrolling toward you. Tap to jump and grab them.",
  introDetail:
    'File only — the whole level is generated from the whole track before you press play, which is the one thing live mic can never do.',
  // No game audio of its own, and the world is generated once offline rather
  // than read continuously — nothing here for headphones to protect, same
  // reasoning as Drop Siege and Overtone.
  headphonesRecommended: false,
  accessibilityNote:
    'The only thing you personally do is tap to jump — no voice or sound is required from you at ' +
    'all. It is file-only by design (the whole track is read in advance to generate the level), so ' +
    'nothing here requires your voice or any sound from you at all.',
  readyPrompt: 'Wait for the analysis to finish, then tap to jump in',
  formatScore: (score) => {
    // Decodes the `Trackgen.score` encoding documented on its getter: the
    // integer part is collectibles grabbed, the total rides along in the
    // fractional part scaled by 10,000.
    const grabbed = Math.floor(score);
    const total = Math.round((score - grabbed) * 10_000);
    return `${grabbed}/${total} note${total === 1 ? '' : 's'}`;
  },
  create: (_profile: CalibrationProfile) => new TrackgenGame(),
};

function render(surface: Surface, game: Trackgen, levelState: 'idle' | 'analysing' | 'ready'): void {
  const { ctx, width, height } = surface;

  if (levelState !== 'ready') {
    ctx.fillStyle = '#0a0a10';
    ctx.fillRect(0, 0, width, height);
    drawAnalysing(ctx, width, height, levelState);
    return;
  }

  const worldScale = width / VISIBLE_WORLD;
  const playerX = width * PLAYER_X;
  const groundY = height * GROUND_FRACTION;
  const cameraX = game.playerWorldX();
  const toScreenX = (worldX: number): number => playerX + (worldX - cameraX) * worldScale;

  drawBackground(ctx, width, height, game);
  drawTimeline(ctx, width, height, game);
  drawGround(ctx, width, groundY);
  for (const collectible of game.collectibles) {
    drawCollectible(ctx, collectible, game, toScreenX, groundY, width);
  }
  drawPlayer(ctx, game, playerX, groundY);
  drawHud(ctx, game, width);
}

function drawAnalysing(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  levelState: 'idle' | 'analysing' | 'ready',
): void {
  ctx.fillStyle = 'rgba(232, 238, 246, 0.7)';
  ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = levelState === 'analysing' ? 'Analysing track structure…' : 'Waiting for a track…';
  ctx.fillText(text, width / 2, height / 2);
}

/** Dark background at low brightness (bass, pads), brighter and cooler at high
 *  brightness (cymbals, cutting synths) — the same "dark background, colour
 *  carries the meaning" palette Overtone and Drop Siege already use, boosted
 *  in saturation/lightness for the drop section so the climax reads brighter
 *  without `Biome.brightness01` itself being adjusted (see `game.ts`'s doc). */
function drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number, game: Trackgen): void {
  const brightness = game.brightnessAt(game.positionSeconds);
  const index = game.biomeIndexAt(game.positionSeconds);
  const isDrop = index !== null ? game.biomes[index].isDrop : false;
  ctx.fillStyle = biomeColor(brightness, isDrop);
  ctx.fillRect(0, 0, width, height);
}

function biomeColor(brightness01: number, isDrop: boolean): string {
  const h = brightness01 < 0 ? 0 : brightness01 > 1 ? 1 : brightness01;
  const hue = 26 + h * 176; // ember orange -> icy blue, same ramp as Overtone's
  const saturation = Math.min(95, (isDrop ? 62 : 38) + h * 25);
  const lightness = Math.min(34, (isDrop ? 20 : 10) + h * 16);
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function drawTimeline(ctx: CanvasRenderingContext2D, width: number, height: number, game: Trackgen): void {
  if (game.duration <= 0) return;
  const margin = 14;
  const top = 8;
  const trackHeight = height * TIMELINE_FRACTION - top - 6;
  const innerWidth = width - margin * 2;
  const toX = (seconds: number) => margin + (seconds / game.duration) * innerWidth;

  ctx.strokeStyle = 'rgba(232, 238, 246, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(margin, top, innerWidth, trackHeight);

  for (const biome of game.biomes) {
    const x = toX(biome.startSeconds);
    const w = Math.max(1, toX(biome.endSeconds) - x);
    const barHeight = trackHeight * (0.15 + biome.brightness01 * 0.85);
    ctx.fillStyle = biome.isDrop ? 'rgba(244, 63, 94, 0.75)' : 'rgba(148, 218, 255, 0.35)';
    ctx.fillRect(x, top + trackHeight - barHeight, w, barHeight);
  }

  const playheadX = toX(game.positionSeconds);
  ctx.strokeStyle = 'rgba(232, 238, 246, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playheadX, top - 4);
  ctx.lineTo(playheadX, top + trackHeight + 4);
  ctx.stroke();
}

function drawGround(ctx: CanvasRenderingContext2D, width: number, groundY: number): void {
  ctx.strokeStyle = 'rgba(232, 238, 246, 0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(width, groundY);
  ctx.stroke();
}

function drawCollectible(
  ctx: CanvasRenderingContext2D,
  collectible: RuntimeCollectible,
  game: Trackgen,
  toScreenX: (worldX: number) => number,
  groundY: number,
  screenWidth: number,
): void {
  const x = toScreenX(game.worldX(collectible.atSeconds));
  if (x < -20 || x > screenWidth + 20) return;
  const y = groundY - game.config.pickupHeight * HEIGHT_SCALE;
  const radius = 8;

  if (collectible.grabbed) {
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  ctx.save();
  ctx.shadowColor = 'rgba(250, 204, 21, 0.6)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#facc15';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlayer(ctx: CanvasRenderingContext2D, game: Trackgen, x: number, groundY: number): void {
  const y = groundY - game.jumpHeight() * HEIGHT_SCALE;
  const radius = 11;

  if (game.jumping) {
    ctx.fillStyle = 'rgba(148, 197, 255, 0.22)';
    ctx.beginPath();
    ctx.arc(x, y, radius * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = game.phase === 'over' ? '#8fa3b8' : '#e8eef6';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** HUD text baseline y — below the timeline strip's own top-of-canvas real estate. */
const HUD_Y = 34;

function drawHud(ctx: CanvasRenderingContext2D, game: Trackgen, width: number): void {
  ctx.save();
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const grabbed = game.collectibles.filter((c) => c.grabbed).length;
  ctx.fillText(`${grabbed}/${game.collectibles.length}`, 14, HUD_Y);

  if (game.phase === 'ready') {
    ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#8fa3b8';
    ctx.textAlign = 'right';
    ctx.fillText('tap to jump in', width - 14, HUD_Y);
  }
  ctx.restore();
}
