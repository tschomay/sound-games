/**
 * The player's measured audio environment. See ADR-0003 — games consume
 * normalised values only, never raw decibels or hertz, so that a quiet phone at
 * arm's length and a laptop mic six inches away play the same.
 *
 * A profile comes in two halves (ADR-0004): the room measurements every game
 * needs, and a pitch range only voice-controlled games need.
 */
import type { CalibrationProfile, PitchRange } from './types';

const STORAGE_KEY = 'sound-games:calibration';
const VERSION = 2;

/** Used when nothing has been measured, so an uncalibrated player still plays. */
export const DEFAULT_PITCH_RANGE: PitchRange = { lowHz: 110, highHz: 440 };

/** Deliberately forgiving, so an uncalibrated player still gets a playable game. */
export const DEFAULT_PROFILE: CalibrationProfile = {
  version: VERSION,
  noiseFloorDb: -65,
  loudDb: -22,
  pitchRange: DEFAULT_PITCH_RANGE,
  createdAt: 0,
};

export function loadProfile(): CalibrationProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Version 1 stored `lowHz`/`highHz` inline and always had them, because the hum
 * steps were mandatory. Those profiles are still perfectly good measurements, so
 * lift them into the new shape rather than making people calibrate again.
 */
function migrate(stored: unknown): CalibrationProfile | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const record = stored as Record<string, unknown>;

  if (record.version === VERSION) {
    if (typeof record.noiseFloorDb !== 'number' || typeof record.loudDb !== 'number') return null;
    return {
      version: VERSION,
      noiseFloorDb: record.noiseFloorDb,
      loudDb: record.loudDb,
      pitchRange: readRange(record.pitchRange),
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    };
  }

  if (record.version === 1) {
    if (typeof record.noiseFloorDb !== 'number' || typeof record.loudDb !== 'number') return null;
    return {
      version: VERSION,
      noiseFloorDb: record.noiseFloorDb,
      loudDb: record.loudDb,
      pitchRange: readRange(record),
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    };
  }

  return null;
}

function readRange(value: unknown): PitchRange | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.lowHz !== 'number' || typeof record.highHz !== 'number') return null;
  if (!(record.lowHz > 0) || !(record.highHz > record.lowHz)) return null;
  return { lowHz: record.lowHz, highHz: record.highHz };
}

export function saveProfile(profile: CalibrationProfile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Private browsing. The profile just won't persist; play continues.
  }
}

export function clearProfile(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** The room has been measured — enough for any game that doesn't read pitch. */
export function isCalibrated(): boolean {
  return loadProfile() !== null;
}

/** The player has also given a hum range, so voice-controlled games can run. */
export function hasPitchRange(): boolean {
  return loadProfile()?.pitchRange != null;
}

/** dBFS to 0..1 across the player's own dynamic range. */
export function normaliseLevel(db: number, profile: CalibrationProfile): number {
  const floor = profile.noiseFloorDb + 4;
  const span = Math.max(6, profile.loudDb - floor);
  return clamp01((db - floor) / span);
}

/** Hz to 0..1 across the player's own pitch range, logarithmically — a semitone
 *  should feel the same size at the bottom of the range as at the top. */
export function normalisePitch(hz: number, range: PitchRange): number {
  const span = Math.log2(range.highHz / range.lowHz);
  if (!Number.isFinite(span) || span <= 0) return 0.5;
  return clamp01(Math.log2(hz / range.lowHz) / span);
}

/** Widen a measured range so the player isn't pinned at the extremes mid-game. */
export function padPitchRange(lowHz: number, highHz: number): PitchRange {
  const semitone = Math.pow(2, 1 / 12);
  const padding = Math.pow(semitone, 2);
  const low = lowHz / padding;
  const high = highHz * padding;
  // A range narrower than a fifth makes for twitchy, unplayable control.
  const minimumSpan = Math.pow(semitone, 7);
  if (high / low < minimumSpan) {
    const centre = Math.sqrt(low * high);
    return { lowHz: centre / Math.sqrt(minimumSpan), highHz: centre * Math.sqrt(minimumSpan) };
  }
  return { lowHz: low, highHz: high };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
