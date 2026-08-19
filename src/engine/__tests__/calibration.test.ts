import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, normaliseLevel, normalisePitch, padPitchRange } from '../calibration';
import type { CalibrationProfile } from '../types';

const profile: CalibrationProfile = {
  ...DEFAULT_PROFILE,
  noiseFloorDb: -60,
  loudDb: -20,
  lowHz: 110,
  highHz: 440,
};

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
    expect(normalisePitch(110, profile)).toBe(0);
    expect(normalisePitch(440, profile)).toBe(1);
  });

  it('is logarithmic, so the midpoint is the geometric mean', () => {
    expect(normalisePitch(220, profile)).toBeCloseTo(0.5, 5);
  });

  it('clamps outside the calibrated range', () => {
    expect(normalisePitch(50, profile)).toBe(0);
    expect(normalisePitch(2000, profile)).toBe(1);
  });
});

describe('padPitchRange', () => {
  it('widens a measured range at both ends', () => {
    const range = padPitchRange(110, 440);
    expect(range.lowHz).toBeLessThan(110);
    expect(range.highHz).toBeGreaterThan(440);
  });

  it('opens out a range too narrow to play with, keeping it centred', () => {
    const range = padPitchRange(200, 210);
    const measuredCentre = Math.sqrt(200 * 210);
    expect(range.highHz / range.lowHz).toBeGreaterThanOrEqual(Math.pow(2, 7 / 12) - 1e-9);
    expect(Math.sqrt(range.lowHz * range.highHz)).toBeCloseTo(measuredCentre, 0);
  });
});
