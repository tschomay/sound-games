/**
 * Quiet Passage as the shell sees it: a definition, and a Game that owns only
 * its rules and its picture. Everything around it — the file gate, canvas,
 * loop, pausing, restarts, results, high scores — belongs to
 * `screens/play.ts`.
 *
 * `sources: ['file']` — file-only, same reasoning as Drop Siege and Trackgen
 * (`docs/ideas.md` B8): fairness requires the whole loudness curve, and every
 * gap it implies, before a single second of the round plays. A live mic
 * stream cannot offer that at any price.
 *
 * **Analysing the track is this game's own problem, not shared plumbing's**
 * — same shape as Drop Siege's own `ensureStructure`. `currentSession()` is
 * read directly (`isFileSource`/`FileSource` from `engine/session.ts`/
 * `engine/source.ts`) and `analyseQuietPassageLevel` (`loudness.ts`) runs
 * once, lazily, the first `update()` after a file session exists, gated
 * behind a `setTimeout(0)` so the "Analysing…" overlay actually paints before
 * the synchronous pass blocks the main thread (same trick Drop Siege and
 * `source-picker.ts`'s beat-grid pass use). Playback is paused for the
 * duration of that analysis and for the rules' own short ready-hold
 * afterward, resuming only once `rules.phase` reaches `'playing'` — otherwise
 * the track would run ahead of a level that doesn't exist to react to yet.
 *
 * **World position is `source.position() * WORLD_UNITS_PER_SECOND`** — a
 * fixed x-camera over a world driven by playback position, the same shape
 * Overtone's terrain scrolls under a stationary player, except the position
 * itself is read straight off the transport (like Drop Siege) rather than
 * accumulated from `dt`, so a gap authored at a given second of the track
 * always arrives under the player exactly when that second of audio plays.
 */
import { QuietPassage, type Lane } from './game';
import { analyseQuietPassageLevel, type QuietPassageLevel } from './loudness';
import { currentSession } from '../../engine/session';
import { isFileSource, type FileSource } from '../../engine/source';
import type { Game, GameDefinition } from '../../engine/game';
import type { Surface } from '../../engine/canvas';
import type { CalibrationProfile, Frame } from '../../engine/types';

/** World units per second of playback — fixed, never accumulated; see the
 *  file doc comment. */
const WORLD_UNITS_PER_SECOND = 3.2;
/** How much of the world fits across the screen at once, in world units. */
const VISIBLE_WORLD = 7;
/** Fraction of the screen width the player sits at. */
const PLAYER_X = 0.24;
/** Fraction of the canvas height a small live-loudness meter occupies. */
const METER_FRACTION = 0.08;

type StructureState = 'idle' | 'analysing' | 'ready';

const LANE_COLOR = ['#94daff', '#facc15', '#4ade80', '#f97316', '#c084fc'];

class QuietPassageGame implements Game {
  private readonly rules = new QuietPassage();
  private structureState: StructureState = 'idle';
  private pausedForAnalysis = false;
  private boundCanvas: HTMLCanvasElement | null = null;
  /** Last live `Frame.level` seen — render-only, for the loudness meter. */
  private lastLevel = 0;

  /** The offline pass needs the same calibration profile the live `Frame`
   *  values it's compared against are normalised through — `create()`'s own
   *  argument, stashed rather than read back off the session, so a session
   *  whose profile is refreshed mid-round can't retroactively disagree with
   *  the level it already built. */
  constructor(private readonly profile: CalibrationProfile) {}

  get phase() {
    return this.rules.phase;
  }

  get score(): number {
    return this.rules.score;
  }

  get readyHint(): string {
    return 'Analysing the track — get ready to tap a lane during the quiet parts';
  }

  update(dt: number, frame: Frame): void {
    const source = this.fileSource();
    this.ensureLevel(source);
    this.lastLevel = frame.level;

    const positionSeconds = source?.position() ?? 0;
    this.rules.update(dt, { level: frame.level, positionSeconds });

    if (this.pausedForAnalysis && this.rules.phase === 'playing') {
      this.pausedForAnalysis = false;
      source?.play();
    }
  }

  reset(): void {
    this.rules.reset();
    // A fresh round replays the same track from the top — the level's gaps
    // were authored against absolute track position, so starting mid-track
    // would scramble which gap arrives when.
    const source = this.fileSource();
    if (source) {
      this.pausedForAnalysis = true;
      source.pause();
      source.seek(0);
    }
  }

  render(surface: Surface): void {
    this.attachInput(surface.canvas);
    render(surface, this.rules, this.structureState, this.lastLevel);
  }

  private fileSource(): FileSource | null {
    const session = currentSession();
    return session && isFileSource(session.source) ? session.source : null;
  }

  private ensureLevel(source: FileSource | null): void {
    if (!source || this.structureState !== 'idle') return;
    this.structureState = 'analysing';
    this.pausedForAnalysis = true;
    source.pause();
    // Yield one tick so the "Analysing…" overlay actually paints before the
    // synchronous pass below blocks the main thread — same trick Drop
    // Siege's `ensureStructure` uses.
    setTimeout(() => {
      const level = analyseQuietPassageLevel(source.buffer, this.profile);
      this.rules.configureTrack(level);
      this.structureState = 'ready';
    }, 0);
  }

  private attachInput(canvas: HTMLCanvasElement): void {
    if (this.boundCanvas === canvas) return;
    this.boundCanvas = canvas;
    // Which of the (equal-height, top-to-bottom) lane bands a tap lands in —
    // same absolute-position tap shape Drop Siege's lane strike uses, simpler
    // here because there's no timeline strip stealing the top of the canvas.
    canvas.addEventListener('pointerdown', (event) => {
      const laneCount = this.rules.level?.laneCount ?? this.rules.config.laneCount;
      const rect = canvas.getBoundingClientRect();
      const fraction = (event.clientY - rect.top) / rect.height;
      const lane = Math.min(laneCount - 1, Math.max(0, Math.floor(fraction * laneCount)));
      this.rules.switchLane(lane as Lane);
    });
  }
}

export const quietPassage: GameDefinition = {
  id: 'quiet-passage',
  title: 'Quiet Passage',
  category: 'music',
  description:
    "Load a track and thread a hazard ceiling that only opens where the track is actually quiet — your height is set by the music, not by you; the only thing you control is which lane you're lined up in.",
  requires: 'room',
  sources: ['file'],
  intro:
    "Load a track. Loud pins you down against the floor; quiet lifts you toward gaps in a hazard ceiling above — but you never jump. The only thing you do is tap a lane, and only while it's quiet enough to do it.",
  introDetail:
    'File only — the whole loudness curve is read before you press play, so every gap is honestly crossable.',
  // No game audio of its own, and `level` is read continuously off the file's
  // own output — nothing here for headphones to protect, same reasoning as
  // Drop Siege and Overtone.
  headphonesRecommended: false,
  accessibilityNote:
    'This is the most passive game in the whole catalog: your vertical position is never something ' +
    'you control, only the track\'s own loudness, read live off the same file the level was built ' +
    'from. The only thing you ever do is tap to switch lanes, and even that only works during the ' +
    "quiet stretches that reveal where to go — there is no voice or sound required from you, ever.",
  readyPrompt: 'Wait for the analysis to finish',
  formatScore: (score) => `${Math.round(score)}% of the track`,
  create: (profile: CalibrationProfile) => new QuietPassageGame(profile),
};

function render(
  surface: Surface,
  game: QuietPassage,
  structureState: StructureState,
  liveLevel: number,
): void {
  const { ctx, width, height } = surface;
  ctx.fillStyle = '#0a0a10';
  ctx.fillRect(0, 0, width, height);

  drawHurtFlash(ctx, width, height, game.hurtFlash);

  if (structureState !== 'ready' || !game.level) {
    drawAnalysing(ctx, width, height, structureState);
    return;
  }

  const playArea = { top: 0, height: height * (1 - METER_FRACTION) };
  drawLanes(ctx, width, playArea, game);
  drawPlayer(ctx, width, playArea, game);
  drawMeter(ctx, width, height, playArea.height, liveLevel, game);
  drawHud(ctx, width, game);
}

function drawHurtFlash(ctx: CanvasRenderingContext2D, width: number, height: number, hurtFlash: number): void {
  if (hurtFlash <= 0) return;
  ctx.fillStyle = `rgba(248, 113, 113, ${hurtFlash * 0.25})`;
  ctx.fillRect(0, 0, width, height);
}

function drawAnalysing(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  structureState: StructureState,
): void {
  ctx.fillStyle = 'rgba(232, 238, 246, 0.7)';
  ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = structureState === 'analysing' ? 'Analysing loudness…' : 'Waiting for a track…';
  ctx.fillText(text, width / 2, height / 2);
}

function laneBand(playArea: { top: number; height: number }, laneCount: number, lane: number) {
  const bandHeight = playArea.height / laneCount;
  return { top: playArea.top + lane * bandHeight, height: bandHeight };
}

function worldX(positionSeconds: number): number {
  return positionSeconds * WORLD_UNITS_PER_SECOND;
}

/**
 * Every lane band, each with its own hazard strip along the top: red where
 * the ceiling is closed, a lit gap wherever `loudness.ts` opened one for that
 * lane. Scrolled by playback position, the same "world position from a fixed
 * x-camera" shape Overtone's terrain uses.
 */
function drawLanes(
  ctx: CanvasRenderingContext2D,
  width: number,
  playArea: { top: number; height: number },
  game: QuietPassage,
): void {
  const level = game.level as QuietPassageLevel;
  const playerX = width * PLAYER_X;
  const worldScale = width / VISIBLE_WORLD;
  const cameraWorldX = worldX(game.positionSeconds);
  const toScreenX = (wx: number) => playerX + (wx - cameraWorldX) * worldScale;
  // The fraction of a band's height that counts as the hazard zone — the
  // exact boundary `game.ts`'s `isHazardHit` checks `height` against.
  const hazardFraction = 1 - level.quietLevelThreshold;

  for (let lane = 0; lane < level.laneCount; lane++) {
    const band = laneBand(playArea, level.laneCount, lane);
    const color = LANE_COLOR[lane % LANE_COLOR.length];

    ctx.strokeStyle = 'rgba(232, 238, 246, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, band.top);
    ctx.lineTo(width, band.top);
    ctx.stroke();

    const hazardTop = band.top;
    const hazardHeight = band.height * hazardFraction;
    ctx.fillStyle = 'rgba(248, 113, 113, 0.16)';
    ctx.fillRect(0, hazardTop, width, hazardHeight);

    for (const gap of level.gaps) {
      if (gap.lane !== lane) continue;
      const x0 = toScreenX(worldX(gap.startSeconds));
      const x1 = toScreenX(worldX(gap.endSeconds));
      if (x1 < 0 || x0 > width) continue;
      const left = Math.max(0, x0);
      const right = Math.min(width, x1);
      ctx.fillStyle = `${color}33`;
      ctx.fillRect(left, hazardTop, right - left, hazardHeight);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left, hazardTop, right - left, hazardHeight);
    }

    ctx.strokeStyle = 'rgba(248, 113, 113, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, hazardTop + hazardHeight);
    ctx.lineTo(width, hazardTop + hazardHeight);
    ctx.stroke();
  }
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  width: number,
  playArea: { top: number; height: number },
  game: QuietPassage,
): void {
  const level = game.level as QuietPassageLevel;
  const band = laneBand(playArea, level.laneCount, game.lane);
  const x = width * PLAYER_X;
  // height 0 (loud, pinned low) sits at the band's floor; height 1 (quiet,
  // lifted) sits at the band's ceiling.
  const y = band.top + band.height * (1 - game.height);

  if (game.laneSwitchFlash > 0) {
    ctx.strokeStyle = `rgba(74, 222, 128, ${game.laneSwitchFlash})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (game.laneRejectFlash > 0) {
    ctx.strokeStyle = `rgba(250, 204, 21, ${game.laneRejectFlash})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = game.phase === 'over' && game.defeated ? '#f87171' : '#e8eef6';
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fill();
}

/** A small live-loudness meter along the bottom — the "why did I fail" read:
 *  when a hit lands, this bar shows whether the track really was loud right
 *  then, independent of anything else on screen. */
function drawMeter(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  meterTop: number,
  liveLevel: number,
  game: QuietPassage,
): void {
  const level = game.level as QuietPassageLevel;
  const barHeight = height - meterTop;
  const margin = 14;
  const barWidth = width - margin * 2;

  ctx.fillStyle = 'rgba(232, 238, 246, 0.06)';
  ctx.fillRect(margin, meterTop + 4, barWidth, barHeight - 8);

  const fillWidth = barWidth * Math.max(0, Math.min(1, liveLevel));
  ctx.fillStyle = liveLevel <= level.quietLevelThreshold ? 'rgba(74, 222, 128, 0.65)' : 'rgba(248, 113, 113, 0.55)';
  ctx.fillRect(margin, meterTop + 4, fillWidth, barHeight - 8);

  const thresholdX = margin + barWidth * Math.max(0, Math.min(1, level.quietLevelThreshold));
  ctx.strokeStyle = 'rgba(232, 238, 246, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(thresholdX, meterTop + 2);
  ctx.lineTo(thresholdX, meterTop + barHeight - 2);
  ctx.stroke();
}

function drawHud(ctx: CanvasRenderingContext2D, width: number, game: QuietPassage): void {
  ctx.save();
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${Math.round(game.score)}%`, 14, 30);

  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#8fa3b8';
  ctx.textAlign = 'right';
  ctx.fillText(`lane ${game.lane + 1}`, width - 14, 24);
  ctx.restore();
}
