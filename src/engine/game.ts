/**
 * The contract every game implements, and the shell fulfils.
 *
 * Hum Flyer originally owned its own microphone gate, canvas, render loop,
 * restart handling and game-over banner. None of that is specific to flying, and
 * writing it eight more times is how eight games become eight prototypes. So the
 * shell owns the furniture and a game owns only its rules and its picture.
 */
import type { CalibrationProfile, Frame, SourceKind } from './types';
import type { Surface } from './canvas';

/** What a game needs calibrated before it can run. See ADR-0004. */
export type Requirement = 'room' | 'pitchRange';

/** Where a round is. Games and the shell share one vocabulary for this. */
export type RoundPhase = 'ready' | 'playing' | 'over';

export interface Game {
  /** Where the current round is. The shell watches this to drive its own UI. */
  readonly phase: RoundPhase;
  readonly score: number;
  /** Line shown under the "ready" prompt; may differ per round. */
  readonly readyHint: string;
  /** Advance the simulation by `dt` seconds against the latest detector output. */
  update(dt: number, frame: Frame): void;
  /** Draw the world. The shell draws everything around it. */
  render(surface: Surface): void;
  /** Begin a fresh round. */
  reset(): void;
}

export interface GameDefinition {
  /** Stable — it is the route and the high-score key, so renaming it loses scores. */
  id: string;
  title: string;
  description: string;
  requires: Requirement | null;
  /** Which audio sources this game can be played with. See ADR-0001. */
  sources: readonly SourceKind[];
  /** Shown on the microphone prompt before the first round. */
  intro: string;
  introDetail?: string;
  /**
   * Set when headphones meaningfully help — most importantly a game that
   * plays sound *and* reads `level`/`onset` while it does, since the output
   * bus's suppression window (ADR-0005) only covers a short SFX, not
   * continuous playback, but also any game continuously listening for voice
   * where a phone speaker's own bleed can hurt it. The shell renders a
   * standard hint on the microphone prompt rather than every such game
   * writing its own copy of it.
   */
  headphonesRecommended?: boolean;
  /** What the player is told to do to start a round. */
  readyPrompt: string;
  /** Turns a score into something readable: 3 → "3 gates". */
  formatScore(score: number): string;
  create(profile: CalibrationProfile): Game;
}
