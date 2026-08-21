# Installable PWA offline shell, and a one-time first-run mic explainer

Phase 9 ships two of its five bullets: an installable PWA with an offline
shell, and a first-run flow that explains the microphone before any game's own
gate ever requests it. Both are shell-only changes — no game code, no
detector, no `GameDefinition` field.

## Decision: a hand-rolled service worker, not a precache-manifest plugin

The brief allowed either a hand-rolled service worker or a small,
well-justified build-time plugin that generates a precache list, and asked for
the hand-rolled option unless there was a real wall. There wasn't one, for one
reason: this app has nothing that needs a *build-time* list of filenames at
all.

Vite fingerprints every JS/CSS file per build (`index-f1spL0kk.js`, different
next build), which is normally exactly why a precache manifest plugin exists —
so the service worker knows what those hashed names currently are without
scraping them at runtime. But `public/sw.js` is plain, unbuilt JS that ships
untouched by Vite, and its `install` handler simply **fetches the live
`index.html` itself and regex-scans it** for the `/assets/...` URLs *this*
document currently references, then caches exactly those. There is no list to
keep in sync, checked in, or go stale between a dependency bump and a
forgotten regeneration — the source of truth is the same file the browser is
about to load anyway. That is simpler than standing up a plugin, matches the
codebase's general "build it yourself" convention (`src/engine/fft.ts`), and
carries less risk of the plugin itself going stale than the hand-rolled
alternative it would replace.

## Decision: network-first for the document, cache-first for hashed assets

Two different correctness questions, two different answers, both driven by
whether the resource in question can go stale:

- **The document (`/`, and every hash route, since hash routing never leaves
  it)** can absolutely go stale — a new deploy changes it. So it is
  **network-first**: an online player always gets whichever build is
  currently live, and that fresh response both serves the page and
  re-populates the cached fallback (stored under a fixed `'/'` key) with
  itself. Only when the network fetch itself fails — genuinely offline — does
  the cached copy get served. This is the direct answer to "can this serve a
  stale app forever": no, only when there is no network at all to ask.
- **Built JS/CSS under `/assets/...`** are content-hashed by Vite, so a given
  URL's bytes can never change — there is no "stale" for them, only "already
  have it" or "don't yet." So they're **cache-first**, filled in at runtime
  the first time each is requested. An old build's hashed files linger
  harmlessly in the cache after a new deploy (nothing references them anymore,
  so nothing serves them) rather than being actively pruned — a small,
  accepted amount of wasted storage in exchange for not needing any
  cross-build bookkeeping. `CACHE_VERSION` exists to force a clean slate by
  hand if that ever needs to change (bump it, `activate` deletes every
  differently-named cache).

## Decision: `registerServiceWorker(isDev)` is gated in `main.ts`, not in the SW itself

The service worker file has no way to know it's being loaded by `vite dev`
versus a production build — from its own vantage point every request looks
the same. So the gate lives one level up, in `src/engine/service-worker.ts`,
which takes `import.meta.env.DEV` as a plain boolean and simply never calls
`navigator.serviceWorker.register` when it's true. `npm run dev`'s constantly
changing, unhashed output is exactly what a caching layer must never sit in
front of.

## Decision: the first-run explainer intercepts `main.ts`'s `render()`, not a route

The brief wants the explainer ahead of *any* screen — game, calibration, the
scope — the very first time the app is ever opened, then never again. That
ruled out making it a route (`#/first-run`): a route can be navigated away
from, back to, or skipped by a deep link, none of which is what "intercepts
the very first render, regardless of what was asked for" means.

Instead, `render()` itself checks `hasSeenFirstRun()` (`engine/first-run.ts`,
the same versioned-localStorage-key-plus-try/catch shape as
`engine/calibration.ts`) before it calls `screenFor(...)`. Unseen, it renders
`firstRunScreen` instead — passing a plain callback that marks the flag and
calls `render()` again. Because `render()` still reads
`window.location.hash` on that second pass, whatever route the player actually
asked for (a specific game, `#/scope`, a bare `/`) is exactly where they land
once they dismiss the explainer — a deep link to Sonar Maze on someone's very
first visit still explains the microphone first, then takes them to Sonar
Maze, not to the menu.

## Consequences

- Neither change touches `Game`/`GameDefinition` or any detector — this is
  entirely shell wiring, the same scope-of-change precedent ADR-0009 set for
  the source picker.
- The per-game mic gates (`ui.ts`'s `overlay()`, `source-picker.ts`'s
  `sourceGate`) are completely unchanged. The explainer is strictly upstream
  of all of them, shown once; it does not replace, skip, or know about any of
  them.
- **What is and isn't verified:** a real, running `vite preview` build was
  driven with headless Chromium (Playwright, the same tool ADR-0012's and
  Phase 8's precedent used) confirming, against the actual built output: the
  explainer appears on a true first visit (including a first visit that deep-
  links straight to a game or the scope) and not on a reload; the flag
  persists across reload; the manifest is reachable and parses; the service
  worker installs and reaches `activated`; and — the one that matters most —
  reloading with the browser context's network fully disabled after one prior
  visit still renders the app and lets it navigate between routes, not a
  browser error page. What that cannot establish is real-device behaviour:
  Safari's and Android Chrome's actual "Add to Home Screen" install prompts
  and icon rendering were not exercised by anything in this sandboxed
  environment, matching every other phase's honest caveat about real hardware.
- The icons (`public/icons/icon-192.png`, `icon-512.png`) are a plain
  geometric microphone silhouette on the app's `--bg` colour, generated by a
  small script (not shipped) that hand-builds the PNG container (chunks,
  CRC32) around Node's built-in `zlib` for the actual compression — no new
  dependency, and consistent with the existing favicon's dark-background,
  mic-only styling without depending on a font being available to rasterize
  the emoji glyph itself. Whether they read well as an actual home-screen
  icon at a glance is a design judgment worth a second look, not something
  this task can fully settle on its own.
