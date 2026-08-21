import { describe, expect, it, vi } from 'vitest';
import { firstRunScreen } from '../first-run';

describe('firstRunScreen', () => {
  it('renders an explanation and a single continue button', () => {
    const root = document.createElement('div');
    firstRunScreen(root, () => {});
    expect(root.querySelector('h1')).not.toBeNull();
    expect(root.querySelectorAll('p').length).toBeGreaterThan(0);
    const buttons = root.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].className).toContain('btn-primary');
  });

  it('mentions the microphone and that nothing leaves the device', () => {
    const root = document.createElement('div');
    firstRunScreen(root, () => {});
    const text = root.textContent ?? '';
    expect(text.toLowerCase()).toContain('microphone');
    expect(text.toLowerCase()).toContain('never');
  });

  it('calls onContinue when the button is clicked, and only then', () => {
    const root = document.createElement('div');
    const onContinue = vi.fn();
    firstRunScreen(root, onContinue);
    expect(onContinue).not.toHaveBeenCalled();
    root.querySelector('button')?.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('clears the root on cleanup', () => {
    const root = document.createElement('div');
    const cleanup = firstRunScreen(root, () => {});
    expect(root.children.length).toBeGreaterThan(0);
    cleanup();
    expect(root.children.length).toBe(0);
  });
});
