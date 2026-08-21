import { beforeEach, describe, expect, it } from 'vitest';
import { latencySetupScreen } from '../latency-setup';
import { DEFAULT_PROFILE, saveProfile } from '../../engine/calibration';

describe('latencySetupScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = '';
  });

  it('redirects to calibrate when there is no room profile yet', () => {
    const root = document.createElement('div');
    latencySetupScreen(root);
    expect(window.location.hash).toBe('#/calibrate');
  });

  it('does not render anything of its own when redirecting', () => {
    const root = document.createElement('div');
    latencySetupScreen(root);
    expect(root.children.length).toBe(0);
  });

  it('renders a start gate mentioning the microphone when a room profile exists', () => {
    saveProfile({ ...DEFAULT_PROFILE });
    const root = document.createElement('div');
    latencySetupScreen(root);
    const buttons = Array.from(root.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Start');
    expect(root.textContent?.toLowerCase()).toContain('microphone');
  });

  it('clears the root on cleanup', () => {
    saveProfile({ ...DEFAULT_PROFILE });
    const root = document.createElement('div');
    const cleanup = latencySetupScreen(root);
    expect(root.children.length).toBeGreaterThan(0);
    cleanup();
    expect(root.children.length).toBe(0);
  });
});
