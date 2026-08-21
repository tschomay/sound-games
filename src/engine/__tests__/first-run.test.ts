import { beforeEach, describe, expect, it } from 'vitest';
import { hasSeenFirstRun, markFirstRunSeen } from '../first-run';

const STORAGE_KEY = 'sound-games:first-run';

describe('first-run flag', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('has not been seen when storage is empty', () => {
    expect(hasSeenFirstRun()).toBe(false);
  });

  it('is remembered after being marked seen', () => {
    markFirstRunSeen();
    expect(hasSeenFirstRun()).toBe(true);
  });

  it('is not fooled by junk left under the key', () => {
    localStorage.setItem(STORAGE_KEY, 'not the version');
    expect(hasSeenFirstRun()).toBe(false);
  });

  it('would re-show if the stored value were an older version', () => {
    localStorage.setItem(STORAGE_KEY, '0');
    expect(hasSeenFirstRun()).toBe(false);
  });
});
