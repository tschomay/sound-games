import { describe, expect, it } from 'vitest';
import { micSetupScreen } from '../mic-setup';

describe('micSetupScreen', () => {
  it('renders a gate mentioning the microphone and Bluetooth before anything opens', () => {
    const root = document.createElement('div');
    micSetupScreen(root);
    const buttons = Array.from(root.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Continue');
    expect(root.textContent?.toLowerCase()).toContain('microphone');
    expect(root.textContent?.toLowerCase()).toContain('bluetooth');
  });

  it('clears the root on cleanup without ever opening the microphone', () => {
    const root = document.createElement('div');
    const cleanup = micSetupScreen(root);
    expect(root.children.length).toBeGreaterThan(0);
    cleanup();
    expect(root.children.length).toBe(0);
  });
});
