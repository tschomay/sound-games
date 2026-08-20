/**
 * Output bus: music and SFX channels on top of the shared `AudioContext`, plus
 * a short suppression window the `Analyser` consults so a game's own sound
 * effects cannot be mistaken for the player. See ADR-0005.
 *
 * Music is continuous, so this does not try to "gate" it for its whole
 * duration — only the short attack/decay of a loop starting or stopping. The
 * actual hazard (`ideas.md` #2) is percussive SFX retriggering the onset
 * detector, and the suppression window is sized for that. A game that wants
 * sustained level/onset detection *while* music plays needs headphones; see
 * `GameDefinition.headphonesRecommended`.
 */

/** What the analyser consults each frame. Small on purpose — see ADR-0005. */
export interface SuppressionSource {
  isSuppressed(): boolean;
}

export interface OutputBusOptions {
  /** 0..1 */
  musicVolume?: number;
  /** 0..1 */
  sfxVolume?: number;
}

export interface PlaySfxOptions {
  /** 0..1, multiplies the sfx channel volume for this one sound. */
  gain?: number;
  /** How long the analyser should ignore onset/level after this plays, ms. */
  suppressMs?: number;
}

export interface PlayMusicOptions {
  /** 0..1, multiplies the music channel volume for this one loop. */
  gain?: number;
  loop?: boolean;
}

/**
 * Long enough to cover a percussive SFX plus its room reverberation through a
 * phone speaker, short enough that a real clap from the player a beat later
 * still gets through. Unverified on real hardware — tune from the scope (see
 * `screens/scope.ts`) if it proves too short or too long.
 */
const DEFAULT_SFX_SUPPRESS_MS = 220;
/** Only covers the click of a loop starting or stopping, not its duration. */
const MUSIC_TRANSITION_SUPPRESS_MS = 80;

export class OutputBus implements SuppressionSource {
  private readonly musicGain: GainNode;
  private readonly sfxGain: GainNode;
  private musicNode: AudioBufferSourceNode | null = null;
  private suppressedUntil = -Infinity;

  constructor(private readonly context: AudioContext, options: OutputBusOptions = {}) {
    this.musicGain = context.createGain();
    this.musicGain.gain.value = clamp01(options.musicVolume ?? 0.6);
    this.musicGain.connect(context.destination);

    this.sfxGain = context.createGain();
    this.sfxGain.gain.value = clamp01(options.sfxVolume ?? 0.8);
    this.sfxGain.connect(context.destination);
  }

  setMusicVolume(value: number): void {
    this.musicGain.gain.value = clamp01(value);
  }

  setSfxVolume(value: number): void {
    this.sfxGain.gain.value = clamp01(value);
  }

  /** Fire-and-forget one-shot SFX. Opens the suppression window. */
  playSfx(buffer: AudioBuffer, options: PlaySfxOptions = {}): void {
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    if (options.gain !== undefined) {
      // A per-sound gain so one loud effect doesn't require turning down every
      // other SFX to match it.
      const perSound = this.context.createGain();
      perSound.gain.value = clamp01(options.gain);
      node.connect(perSound);
      perSound.connect(this.sfxGain);
    } else {
      node.connect(this.sfxGain);
    }
    node.onended = () => node.disconnect();
    node.start();
    this.openGate(options.suppressMs ?? DEFAULT_SFX_SUPPRESS_MS);
  }

  /** Starts a looping music bed, replacing whatever was already playing. */
  startMusic(buffer: AudioBuffer, options: PlayMusicOptions = {}): void {
    this.stopMusic();
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.loop = options.loop ?? true;
    if (options.gain !== undefined) this.musicGain.gain.value = clamp01(options.gain);
    node.connect(this.musicGain);
    node.start();
    this.musicNode = node;
    this.openGate(MUSIC_TRANSITION_SUPPRESS_MS);
  }

  stopMusic(): void {
    if (!this.musicNode) return;
    this.musicNode.stop();
    this.musicNode.disconnect();
    this.musicNode = null;
    this.openGate(MUSIC_TRANSITION_SUPPRESS_MS);
  }

  /**
   * Open the suppression window without playing anything through this bus —
   * for a game that plays sound through some other path (e.g. an `<audio>`
   * element) but still wants the analyser to ignore it.
   */
  suppressFor(ms: number): void {
    this.openGate(ms);
  }

  /** Whether the analyser should currently ignore onset/level. */
  isSuppressed(): boolean {
    return this.context.currentTime < this.suppressedUntil;
  }

  dispose(): void {
    this.stopMusic();
    this.musicGain.disconnect();
    this.sfxGain.disconnect();
  }

  private openGate(ms: number): void {
    // Max, not overwrite: an SFX fired while the gate is already open extends
    // it rather than shortening it.
    this.suppressedUntil = Math.max(this.suppressedUntil, this.context.currentTime + ms / 1000);
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
