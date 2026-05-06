// NYC Field Guide — Service Worker
// =============================================================================
// Provides offline support: the app shell and recent map tiles work without
// network so the guide is usable on the subway, in basements, etc.
//
// Cache strategies by resource type:
//   - APP SHELL (the HTML page itself, fonts, Leaflet): stale-while-revalidate.
//     Serve from cache instantly, fetch in background to update for next visit.
//   - MAP TILES (Carto Voyager basemap): cache-first with size cap. Tiles are
//     immutable per zoom-x-y so cache lifetime can be long; we cap at ~200
//     tiles to respect Carto TOS (no aggressive bulk caching) and disk usage.
//   - GITHUB API (api.github.com, raw.githubusercontent.com): network-first.
//     User edits are ground truth — never serve stale.
//   - GEOCODERS (photon.komoot.io, nominatim.openstreetmap.org): never cache.
//     Results would be stale and the app degrades gracefully on geocoder
//     failure (yellow banner, manual entry).
//
// Cache versioning:
//   Bump CACHE_VERSION to invalidate all caches on the next SW activation.
//   The activate handler deletes any cache that doesn't match the current
//   version prefix.
// =============================================================================

const CACHE_VERSION = 'nyc-guide-v1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const TILE_CACHE = `${CACHE_VERSION}-tiles`;
const TILE_CACHE_LIMIT = 200;

// Files to pre-cache on install. The HTML itself we cache via "./" so it
// works whether deployed to a root or subdirectory (e.g. GitHub Pages).
// Leaflet and Google Fonts go in here so the first offline visit has them.
const SHELL_URLS = [
  './',
  './index.html',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// On install: pre-cache the shell. Use addAll so any single failure aborts
// install — better to have no SW than one with a half-broken cache.
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Use individual put() calls instead of cache.addAll so a single CDN
    // failure (e.g. unpkg blip) doesn't abort the entire install.
    await Promise.all(SHELL_URLS.map(async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (e) {
        // Skip silently — page will still work, just no offline for that asset.
      }
    }));
    // Activate as soon as install finishes, even if other tabs are open with
    // an older SW. Combined with clients.claim() below, the new SW takes
    // control immediately on update.
    self.skipWaiting();
  })());
});

// On activate: clean up any caches from older versions and claim all clients.
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(name => {
      if (!name.startsWith(CACHE_VERSION)) return caches.delete(name);
    }));
    await self.clients.claim();
  })());
});

// Trim a cache to a maximum number of entries, deleting the oldest first.
// Browsers don't expose insertion order directly via the Cache API, but
// keys() returns them in insertion order in practice.
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.slice(0, keys.length - maxEntries);
  await Promise.all(toDelete.map(req => cache.delete(req)));
}

// Identify which strategy to use for a given URL. Centralized here so the
// fetch handler stays a clean dispatch.
function classifyRequest(url) {
  // Carto map tiles
  if (url.hostname.endsWith('basemaps.cartocdn.com')) return 'tile';
  // GitHub API and raw content (user edits, additions, hidden reels)
  if (url.hostname === 'api.github.com') return 'github';
  if (url.hostname === 'raw.githubusercontent.com') return 'github';
  // Geocoders — bypass cache entirely
  if (url.hostname.endsWith('photon.komoot.io')) return 'bypass';
  if (url.hostname.endsWith('nominatim.openstreetmap.org')) return 'bypass';
  if (url.hostname.endsWith('corsproxy.io')) return 'bypass';
  if (url.hostname.endsWith('allorigins.win')) return 'bypass';
  // Google Fonts
  if (url.hostname.endsWith('fonts.googleapis.com')) return 'shell';
  if (url.hostname.endsWith('fonts.gstatic.com')) return 'shell';
  // Leaflet from unpkg
  if (url.hostname === 'unpkg.com') return 'shell';
  // Same-origin requests (the HTML page, app subresources)
  if (url.origin === self.location.origin) return 'shell';
  return 'bypass';
}

// Stale-while-revalidate: return cached response immediately if available,
// while fetching a fresh copy in the background to update the cache for the
// next visit. Best for the app shell — fast loads, eventually consistent.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  // Background fetch (don't await — let it run after we've returned).
  const fetchPromise = fetch(request).then(res => {
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return cached || (await fetchPromise) || new Response('Offline', {
    status: 503,
    statusText: 'Offline and not cached',
  });
}

// Cache-first with size cap: ideal for immutable tiles. We use cache, and
// only fetch + store when the tile isn't already there. Trim runs after
// each successful fetch so we don't grow unbounded.
async function cacheFirstWithCap(request, cacheName, cap) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      // Cache the response, then trim asynchronously — don't block return.
      cache.put(request, res.clone()).then(() => trimCache(cacheName, cap)).catch(() => {});
    }
    return res;
  } catch (e) {
    // Tile unavailable offline — return a 1x1 transparent PNG placeholder
    // so the map doesn't get gray squares (which look broken).
    return new Response(
      Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='), c => c.charCodeAt(0)),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
}

// Network-first: try fetching, fall back to cache if offline. Used for the
// GitHub API where the cached version is a fallback, never the primary.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.ok && request.method === 'GET') {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
}

// The main fetch dispatcher. Only intercept GET requests — POST/PUT/DELETE
// are user-initiated writes (e.g. GitHub commits) that must always go to the
// network. We also explicitly skip non-http(s) schemes to avoid issues with
// chrome-extension://, blob:, etc.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const kind = classifyRequest(url);
  if (kind === 'bypass') return; // let the browser handle it normally

  if (kind === 'shell') {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  } else if (kind === 'tile') {
    event.respondWith(cacheFirstWithCap(request, TILE_CACHE, TILE_CACHE_LIMIT));
  } else if (kind === 'github') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});

// Listen for a "skipWaiting" message from the page — useful when the page
// detects a new SW and wants to activate it without a manual reload.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'skipWaiting') {
    self.skipWaiting();
  }
});
