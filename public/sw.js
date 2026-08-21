/**
 * The offline app shell. Hand-rolled, not Workbox — this project's convention
 * is to build small pieces of infrastructure itself (see `src/engine/fft.ts`),
 * and a cache-first/network-first split for one SPA shell is small enough
 * that a precache-manifest build plugin would be more machinery than the
 * problem needs. See docs/adr/0014-pwa-offline-shell.md.
 *
 * There is no build-time list of hashed asset filenames to precache — Vite
 * fingerprints them per build and this file is plain, unbuilt JS served
 * as-is from `public/`. Instead, `install` fetches the live document once and
 * regex-scans it for the `/assets/...` URLs it currently references, so the
 * exact shell for *this* deploy gets cached without ever hand-maintaining a
 * file list. Everything else is filled in at runtime as it's requested.
 */
const CACHE_VERSION = 'v1';
const CACHE_NAME = `sound-games-shell-${CACHE_VERSION}`;

/** Always-present shell files, independent of any build's hashed output. */
const CORE_URLS = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  // Best-effort, one URL at a time: a single missing/failed fetch (e.g. an
  // icon renamed since this file was cached) must not sink the whole install.
  const cacheOne = async (url) => {
    try {
      const response = await fetch(url, { cache: 'reload' });
      if (response.ok) await cache.put(url, response);
    } catch {
      // Offline install, or a stale URL. The shell just has one fewer entry.
    }
  };

  await cacheOne('/');
  const assetUrls = await discoverBuiltAssetUrls();
  await Promise.all([...CORE_URLS.filter((u) => u !== '/'), ...assetUrls].map(cacheOne));
}

/** Scrapes the just-fetched index.html for the hashed `/assets/...` URLs this
 *  specific build actually references, so there is nothing to keep in sync by
 *  hand when a new build changes every filename. */
async function discoverBuiltAssetUrls() {
  try {
    const html = await (await caches.open(CACHE_NAME)).match('/').then((r) => r?.text());
    if (!html) return [];
    const urls = new Set();
    const attr = /(?:src|href)="(\/assets\/[^"]+)"/g;
    let match;
    while ((match = attr.exec(html))) urls.add(match[1]);
    return [...urls];
  } catch {
    return [];
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Cross-origin (analytics, fonts, whatever future code adds) and non-GET
  // requests are left completely alone — this shell only knows its own files.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  event.respondWith(cacheFirstRuntime(request));
});

/**
 * The document itself is network-first: an online player always gets
 * whichever build is currently deployed (and that fresh index.html
 * immediately re-populates the cached shell with its own hashed asset URLs).
 * Only a genuinely offline request falls back to whatever shell was cached
 * last — this is the one strategy choice that directly answers "could this
 * serve a stale app forever": no, only ever when there is no network at all.
 */
async function networkFirstShell(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    // Store under the fixed '/' key (hash routing means every route is this
    // same document) so the offline fallback below always has one to find.
    void cache.put('/', response.clone());
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match('/');
    if (cached) return cached;
    throw new Error('offline and nothing cached yet');
  }
}

/** Built assets are content-hashed and therefore immutable: once one is
 *  cached it can never go stale, so cache-first with a runtime fill is both
 *  correct and free of the "am I serving something old" question above. */
async function cacheFirstRuntime(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) void cache.put(request, response.clone());
  return response;
}
