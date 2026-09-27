/**
 * Service worker.
 *
 * Two jobs:
 *
 *   1. Cache the app shell so an installed copy opens instantly and works with
 *      no network — every sound is synthesised, so once the code is cached the
 *      music needs nothing else.
 *
 *   2. Cache place lookups. A route you have walked before replays offline,
 *      and a flaky signal mid-walk falls back to the last answer for that spot
 *      rather than going silent.
 */

const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const PLACES = `places-${VERSION}`;

/** Place data is stale-tolerant: a cafe does not move. */
const PLACES_MAX_ENTRIES = 400;

const SHELL_FILES = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/src/main.js',
  '/src/ui.js',
  '/src/geo.js',
  '/src/scene.js',
  '/src/scenecontext.js',
  '/src/tags.js',
  '/src/store.js',
  '/src/provider.js',
  '/src/osm-tags.js',
  '/src/audio/engine.js',
  '/src/audio/voices.js',
  '/src/audio/theory.js',
  '/src/themes/index.js',
  '/src/themes/spec.js',
  '/src/themes/pattern.js',
  '/src/themes/cues.js',
  '/src/themes/match.js',
  '/src/themes/util.js',
  '/src/themes/wanderer.js',
  '/src/themes/scifi.js',
  '/src/themes/videogame.js',
  '/src/themes/fantasy.js',
  '/src/themes/noir.js',
  '/src/themes/presets/overworld.js',
  '/packs/index.json',
  '/packs/landmarks.json',
  '/packs/ocarina.json',
  '/packs/cues-example.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll fails the whole install if any single file 404s, which would
    // leave no offline copy at all. Take what we can get.
    await Promise.all(SHELL_FILES.map((url) =>
      cache.add(url).catch(() => console.warn('[sw] could not cache', url))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, PLACES]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Place lookups: network first, fall back to whatever we saw last.
  if (url.origin === self.location.origin && url.pathname === '/api/places') {
    event.respondWith(placesStrategy(request));
    return;
  }

  // Never cache config or geocoding — both are cheap and want to be current.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Cross-origin (Overpass, Nominatim) is left alone; those have their own
  // rate limits and caching them here would confuse the fallback logic.
  if (url.origin !== self.location.origin) return;

  event.respondWith(shellStrategy(request));
});

/** Cache first for the shell: instant open, and offline by default. */
async function shellStrategy(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Refresh in the background so the next open is current.
    fetchAndStore(request, SHELL).catch(() => {});
    return cached;
  }
  try {
    return await fetchAndStore(request, SHELL);
  } catch {
    // A navigation with nothing cached still gets the app shell.
    if (request.mode === 'navigate') {
      const shell = await caches.match('/index.html');
      if (shell) return shell;
    }
    throw new Error('offline and not cached');
  }
}

/** Network first for places: fresh when online, last known when not. */
async function placesStrategy(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(PLACES);
      cache.put(request, response.clone());
      trim(cache, PLACES_MAX_ENTRIES);
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      // Mark it so the UI can say the surroundings may be out of date.
      const body = await cached.json();
      return new Response(JSON.stringify({ ...body, offline: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error('offline and no cached lookup for this spot');
  }
}

async function fetchAndStore(request, cacheName) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

/** Keep the place cache bounded — a long walk would otherwise grow forever. */
async function trim(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const key of keys.slice(0, keys.length - max)) await cache.delete(key);
}
