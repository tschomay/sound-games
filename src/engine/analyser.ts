/**
 * Turns an AudioSource into a stream of Frames — one per animation frame, with
 * every detector's output on it.
 */
import { OnsetDetector } from './onset';
import { PitchDetector } from './pitch';
import { TimbreClassifier } from './timbre-class';
import {
  DEFAULT_PITCH_RANGE,
  DEFAULT_PROFILE,
  normaliseLevel,
  normalisePitch,
} from './calibration';
import type { SuppressionSource } from './output';
import type { AudioSource, Bands, CalibrationProfile, Frame } from './types';

const BAND_EDGES_HZ: Array<[keyof Bands, number, number]> = [
  ['bass', 20, 140],
  ['lowMid', 140, 500],
  ['mid', 500, 2000],
  ['high', 2000, 8000],
];

const BAND_FLOOR_DB = -80;
const BAND_CEILING_DB = -20;

export interface AnalyserOptions {
  fftSize?: number;
  minPitchHz?: number;
  maxPitchHz?: number;
  /**
   * Consulted each `read()` to decide whether this frame's onset/level
   * reflects the room or the game's own speaker output. See ADR-0005 — the
   * output bus implements this, but detectors stay ignorant of it: the
   * analyser is the only thing that asks.
   */
  suppression?: SuppressionSource;
}

export class Analyser {
  readonly node: AnalyserNode;
  profile: CalibrationProfile = DEFAULT_PROFILE;

  // Explicit ArrayBuffer backing: the Web Audio getters refuse a possibly
  // SharedArrayBuffer-backed view.
  private readonly timeDomain: Float32Array<ArrayBuffer>;
  private readonly spectrum: Float32Array<ArrayBuffer>;
  private readonly magnitudes: Float32Array<ArrayBuffer>;
  private readonly pitchDetector: PitchDetector;
  private readonly onsetDetector: OnsetDetector;
  private readonly timbreClassifier = new TimbreClassifier();
  private readonly suppression?: SuppressionSource;
  private readonly startedAt: number;
  private lastT = 0;
  /** Held during a gated frame so a frozen level doesn't just read 0. */
  private lastLevel = 0;

  constructor(readonly source: AudioSource, options: AnalyserOptions = {}) {
    const context = source.context;
    this.suppression = options.suppression;
    this.node = context.createAnalyser();
    this.node.fftSize = options.fftSize ?? 2048;
    // Our own detectors do their own smoothing; the analyser's would just add
    // latency and blunt the transients onset detection depends on.
    this.node.smoothingTimeConstant = 0;
    this.node.minDecibels = -100;
    source.node.connect(this.node);

    this.timeDomain = new Float32Array(this.node.fftSize);
    this.spectrum = new Float32Array(this.node.frequencyBinCount);
    this.magnitudes = new Float32Array(this.node.frequencyBinCount);
    this.pitchDetector = new PitchDetector(context.sampleRate, this.node.fftSize, {
      minHz: options.minPitchHz ?? 70,
      maxHz: options.maxPitchHz ?? 1000,
    });
    this.onsetDetector = new OnsetDetector(
      this.node.frequencyBinCount,
      context.sampleRate / 2,
    );
    this.startedAt = context.currentTime;
  }

  read(): Frame {
    const t = this.source.context.currentTime - this.startedAt;
    const dt = Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;

    this.node.getFloatTimeDomainData(this.timeDomain);
    this.node.getFloatFrequencyData(this.spectrum);

    const db = toDecibels(rms(this.timeDomain));
    const rawLevel = normaliseLevel(db, this.profile);
    const gated = this.suppression?.isSuppressed() ?? false;
    // Frozen, not zeroed: a hard drop to 0 is itself a spike a game could
    // misread, and the point is to look like nothing happened at all.
    const level = gated ? this.lastLevel : rawLevel;
    if (!gated) this.lastLevel = level;

    // Pitch detection on near-silence is wasted work and produces noise-driven
    // garbage, so gate it on the calibrated level rather than trusting clarity
    // alone to reject it.
    const pitch = level > 0.06
      ? this.pitchDetector.detect(this.timeDomain)
      : { hz: null, clarity: 0 };

    // Still fed every frame — even gated — so its rolling flux history stays
    // current and doesn't misfire the instant the gate closes. Only the
    // *result* is suppressed.
    const onset = this.onsetDetector.process(this.spectrum, t);
    this.toMagnitudes();

    const flatness = this.flatness();
    const zcr = zeroCrossingRate(this.timeDomain);
    // Fed the raw (un-frozen) level and the real onset flag every frame, same
    // reasoning as the onset detector above: its own hysteresis state should
    // track what actually happened, not what the frame reports after gating.
    // Only the returned classification is suppressed to 'silence'.
    const timbreClass = this.timbreClassifier.classify(zcr, flatness, rawLevel, onset.onset);

    return {
      t,
      dt,
      db,
      level,
      pitchHz: pitch.hz,
      clarity: pitch.clarity,
      voiced: pitch.hz !== null,
      // A player who skipped the hum steps still gets a pitchNorm, against a
      // default range — games that actually depend on it gate on the profile.
      pitchNorm:
        pitch.hz === null
          ? null
          : normalisePitch(pitch.hz, this.profile.pitchRange ?? DEFAULT_PITCH_RANGE),
      onset: gated ? false : onset.onset,
      flux: onset.flux,
      onsetStrength: gated ? 0 : onset.strength,
      centroid: this.centroid(),
      flatness,
      zcr,
      timbreClass: gated ? 'silence' : timbreClass,
      bands: this.bands(),
      gated,
    };
  }

  /** The most recent spectrum in dBFS. Borrowed, not copied — for drawing only. */
  spectrumView(): Float32Array<ArrayBuffer> {
    return this.spectrum;
  }

  /** The most recent waveform. Borrowed, not copied — for drawing only. */
  waveformView(): Float32Array<ArrayBuffer> {
    return this.timeDomain;
  }

  dispose(): void {
    this.node.disconnect();
  }

  private toMagnitudes(): void {
    for (let i = 0; i < this.spectrum.length; i++) {
      this.magnitudes[i] = Math.pow(10, this.spectrum[i] / 20);
    }
  }

  private binToHz(bin: number): number {
    return (bin * this.source.context.sampleRate) / this.node.fftSize;
  }

  private hzToBin(hz: number): number {
    return Math.round((hz * this.node.fftSize) / this.source.context.sampleRate);
  }

  private centroid(): number {
    let weighted = 0;
    let total = 0;
    for (let i = 1; i < this.magnitudes.length; i++) {
      weighted += this.binToHz(i) * this.magnitudes[i];
      total += this.magnitudes[i];
    }
    return total > 0 ? weighted / total : 0;
  }

  private flatness(): number {
    const epsilon = 1e-10;
    let logSum = 0;
    let sum = 0;
    const n = this.magnitudes.length - 1;
    for (let i = 1; i <= n; i++) {
      const magnitude = this.magnitudes[i] + epsilon;
      logSum += Math.log(magnitude);
      sum += magnitude;
    }
    if (sum <= 0) return 0;
    const geometric = Math.exp(logSum / n);
    return Math.min(1, geometric / (sum / n));
  }

  private bands(): Bands {
    const result = {} as Bands;
    for (const [name, lowHz, highHz] of BAND_EDGES_HZ) {
      const from = Math.max(1, this.hzToBin(lowHz));
      const to = Math.min(this.magnitudes.length - 1, this.hzToBin(highHz));
      let sum = 0;
      let count = 0;
      for (let i = from; i <= to; i++) {
        sum += this.magnitudes[i];
        count++;
      }
      const meanDb = count > 0 ? toDecibels(sum / count) : BAND_FLOOR_DB;
      result[name] = clamp01(
        (meanDb - BAND_FLOOR_DB) / (BAND_CEILING_DB - BAND_FLOOR_DB),
      );
    }
    return result;
  }
}

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Fraction of adjacent sample pairs whose sign flips, 0..1. Normalised per
 * sample rather than per second so the same waveform reads the same
 * regardless of a device's sample rate or this analyser's buffer size — see
 * `Frame.zcr` and `engine/timbre-class.ts`.
 */
export function zeroCrossingRate(samples: Float32Array): number {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] >= 0 !== samples[i - 1] >= 0) crossings++;
  }
  return crossings / (samples.length - 1);
}

export function toDecibels(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, 1e-8));
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
