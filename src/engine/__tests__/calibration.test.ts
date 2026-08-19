import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE,
  hasPitchRange,
  isCalibrated,
  loadProfile,
  normaliseLevel,
  normalisePitch,
  padPitchRange,
  saveProfile,
} from '../calibration';
import type { CalibrationProfile, PitchRange } from '../types';

const STORAGE_KEY = 'sound-games:calibration';

const profile: CalibrationProfile = {
  ...DEFAULT_PROFILE,
  noiseFloorDb: -60,
  loudDb: -20,
  pitchRange: { lowHz: 110, highHz: 440 },
};

const range: PitchRange = { lowHz: 110, highHz: 440 };

describe('normaliseLevel', () => {
  it('reads the noise floor as silence', () => {
    expect(normaliseLevel(-60, profile)).toBe(0);
  });

  it('reads the calibrated loud level as full', () => {
    expect(normaliseLevel(-20, profile)).toBeCloseTo(1, 1);
  });

  it('clamps rather than exceeding 1 when someone shouts', () => {
    expect(normaliseLevel(0, profile)).toBe(1);
  });
});

describe('normalisePitch', () => {
  it('puts the bottom of the range at 0 and the top at 1', () => {
    expect(normalisePitch(110, range)).toBe(0);
    expect(normalisePitch(440, range)).toBe(1);
  });

  it('is logarithmic, so the midpoint is the geometric mean', () => {
    expect(normalisePitch(220, range)).toBeCloseTo(0.5, 5);
  });

  it('clamps outside the calibrated range', () => {
    expect(normalisePitch(50, range)).toBe(0);
    expect(normalisePitch(2000, range)).toBe(1);
  });
});

describe('padPitchRange', () => {
  it('widens a measured range at both ends', () => {
    const padded = padPitchRange(110, 440);
    expect(padded.lowHz).toBeLessThan(110);
    expect(padded.highHz).toBeGreaterThan(440);
  });

  it('opens out a range too narrow to play with, keeping it centred', () => {
    const padded = padPitchRange(200, 210);
    const measuredCentre = Math.sqrt(200 * 210);
    expect(padded.highHz / padded.lowHz).toBeGreaterThanOrEqual(Math.pow(2, 7 / 12) - 1e-9);
    expect(Math.sqrt(padded.lowHz * padded.highHz)).toBeCloseTo(measuredCentre, 0);
  });
});

describe('stored profiles', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reports nothing calibrated when storage is empty', () => {
    expect(loadProfile()).toBeNull();
    expect(isCalibrated()).toBe(false);
    expect(hasPitchRange()).toBe(false);
  });

  it('round-trips a room-only profile', () => {
    saveProfile({ ...profile, pitchRange: null });
    expect(loadProfile()?.noiseFloorDb).toBe(-60);
    expect(isCalibrated()).toBe(true);
    expect(hasPitchRange()).toBe(false);
  });

  it('round-trips a profile with a voice range', () => {
    saveProfile(profile);
    expect(loadProfile()?.pitchRange).toEqual({ lowHz: 110, highHz: 440 });
    expect(hasPitchRange()).toBe(true);
  });

  it('lifts a version 1 profile into the new shape rather than discarding it', () => {
    // Version 1 stored the range inline and always had one.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        noiseFloorDb: -58,
        loudDb: -18,
        lowHz: 120,
        highHz: 400,
        createdAt: 123,
      }),
    );
    const loaded = loadProfile();
    expect(loaded).toEqual({
      version: 2,
      noiseFloorDb: -58,
      loudDb: -18,
      pitchRange: { lowHz: 120, highHz: 400 },
      createdAt: 123,
    });
  });

  it('rejects a stored range that is not usable', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        noiseFloorDb: -58,
        loudDb: -18,
        pitchRange: { lowHz: 400, highHz: 120 },
        createdAt: 1,
      }),
    );
    expect(loadProfile()?.pitchRange).toBeNull();
    expect(isCalibrated()).toBe(true);
  });

  it('ignores junk in storage instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    expect(loadProfile()).toBeNull();
  });

  it('ignores a profile from an unknown future version', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 99, noiseFloorDb: -1 }));
    expect(loadProfile()).toBeNull();
  });
});
