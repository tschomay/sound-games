/**
 * The player's measured audio environment. See ADR-0003 — games consume
 * normalised values only, never raw decibels or hertz, so that a quiet phone at
 * arm's length and a laptop mic six inches away play the same.
 */
import type { CalibrationProfile } from './types';

const STORAGE_KEY = 'sound-games:calibration';
const VERSION = 1;

/** Deliberately forgiving, so an uncalibrated player still gets a playable game. */
export const DEFAULT_PROFILE: CalibrationProfile = {
  version: VERSION,
  noiseFloorDb: -65,
  loudDb: -22,
  lowHz: 110,
  highHz: 440,
  createdAt: 0,
};

export function loadProfile(): CalibrationProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CalibrationProfile;
    if (parsed.version !== VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
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

export function isCalibrated(): boolean {
  return loadProfile() !== null;
}

/** dBFS to 0..1 across the player's own dynamic range. */
export function normaliseLevel(db: number, profile: CalibrationProfile): number {
  const floor = profile.noiseFloorDb + 4;
  const span = Math.max(6, profile.loudDb - floor);
  return clamp01((db - floor) / span);
}

/** Hz to 0..1 across the player's own pitch range, logarithmically — a semitone
 *  should feel the same size at the bottom of the range as at the top. */
export function normalisePitch(hz: number, profile: CalibrationProfile): number {
  const span = Math.log2(profile.highHz / profile.lowHz);
  if (!Number.isFinite(span) || span <= 0) return 0.5;
  return clamp01(Math.log2(hz / profile.lowHz) / span);
}

/** Widen a measured range so the player isn't pinned at the extremes mid-game. */
export function padPitchRange(lowHz: number, highHz: number): { lowHz: number; highHz: number } {
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
