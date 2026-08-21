import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from '../service-worker';

describe('registerServiceWorker', () => {
  const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

  afterEach(() => {
    if (originalServiceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
    } else {
      // @ts-expect-error -- jsdom doesn't define it by default; restore that.
      delete navigator.serviceWorker;
    }
  });

  it('never registers in dev — an aggressively caching worker would break `npm run dev`', () => {
    const register = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
    registerServiceWorker(true);
    window.dispatchEvent(new Event('load'));
    expect(register).not.toHaveBeenCalled();
  });

  it('registers /sw.js on window load outside of dev', () => {
    const register = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
    registerServiceWorker(false);
    window.dispatchEvent(new Event('load'));
    expect(register).toHaveBeenCalledWith('/sw.js');
  });

  it('does nothing when the browser has no serviceWorker support', () => {
    // @ts-expect-error -- simulating an unsupported browser.
    delete navigator.serviceWorker;
    expect(() => registerServiceWorker(false)).not.toThrow();
  });
});
