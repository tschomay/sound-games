/** Where audio samples come from. See ADR-0001. */
export type SourceKind = 'mic' | 'file';

export interface AudioSource {
  readonly kind: SourceKind;
  readonly label: string;
  readonly context: AudioContext;
  /** Node to tap for analysis. Not connected to the destination by the source. */
  readonly node: AudioNode;
  stop(): void;
}

export interface Bands {
  bass: number;
  lowMid: number;
  mid: number;
  high: number;
}

/**
 * Every detector's output for a single moment. Produced once per animation
 * frame and handed to the game — the unit of communication between the engine
 * and everything else.
 */
export interface Frame {
  /** Seconds since the analyser started. */
  t: number;
  /** Seconds since the previous frame, clamped to something sane. */
  dt: number;

  /** Raw loudness in dBFS, before calibration. */
  db: number;
  /** Loudness normalised 0..1 against the player's calibration profile. */
  level: number;

  /** Fundamental in Hz, or null when nothing pitched was found. */
  pitchHz: number | null;
  /** How periodic the signal is, 0..1. Above ~0.9 is a confident pitch. */
  clarity: number;
  /** Sustained tone with a findable fundamental. */
  voiced: boolean;
  /** Pitch as a 0..1 position inside the player's calibrated range. */
  pitchNorm: number | null;

  /** A broadband transient started this frame. */
  onset: boolean;
  /** Raw spectral flux, for debugging and for onset strength. */
  flux: number;
  /** Loudness of the transient that fired, 0..1. Zero when `onset` is false. */
  onsetStrength: number;

  /** Spectral centroid in Hz — "brightness", tracks vowel shape. */
  centroid: number;
  /** Spectral flatness 0..1 — near 0 is tonal, near 1 is noise. */
  flatness: number;

  bands: Bands;
}

export interface CalibrationProfile {
  version: number;
  /** Measured dBFS of the player's silent room. */
  noiseFloorDb: number;
  /** Measured dBFS of the player making a comfortable sustained sound. */
  loudDb: number;
  /** Bottom of the player's comfortable hum range, Hz. */
  lowHz: number;
  /** Top of the player's comfortable hum range, Hz. */
  highHz: number;
  createdAt: number;
}
