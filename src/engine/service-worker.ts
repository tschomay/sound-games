/**
 * Registers `public/sw.js`, the offline app shell. See docs/adr/0014.
 *
 * Gated on `isDev` so a service worker never runs against Vite's dev server —
 * one aggressively caching `npm run dev`'s constantly-changing output would
 * make iterating on the app miserable, and there is nothing to offer offline
 * during development anyway.
 */
export function registerServiceWorker(isDev: boolean): void {
  if (isDev) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    // A failed registration (unsupported browser quirk, a network hiccup on
    // the very first load) must never block the app itself from playing —
    // the offline shell is a bonus, not a requirement.
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
