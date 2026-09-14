/* Service worker — offline app shell.
 *
 * The dashboard already survived a dead network in one respect: activity data is
 * mirrored into localStorage, so a failed fetch still had something to render. What
 * it could not survive was the *page* being unavailable — open it on a train and you
 * got the browser's offline error, cached data and all. This closes that gap.
 *
 * Three strategies, by what the request is:
 *
 *   app shell (this origin)  network-first, cache fallback. The dashboard is one
 *                            big HTML file that changes on every deploy, so a stale
 *                            copy must never win while the network is up.
 *   icons / manifest         cache-first. Content-addressed in practice; refetching
 *                            them costs more than it can possibly gain.
 *   CDN libraries            stale-while-revalidate. Chart.js and Leaflet are pinned
 *                            to exact versions, so the cached copy is always correct,
 *                            and having them offline is what makes the shell useful
 *                            rather than merely present.
 *
 * The Worker API is deliberately NOT cached here. Activity data has its own cache in
 * localStorage with its own freshness rules, and a second, invisible copy at the
 * network layer would make "why am I seeing yesterday's numbers" unanswerable.
 *
 * Bump CACHE_VERSION when the shell list changes; activate() drops every older cache.
 */
// v2: Chart.js and Leaflet moved from two CDNs onto this origin, so the separate
// library cache and its cross-origin rule are gone. Old caches are dropped on
// activate, which also clears whatever those CDNs had last served.
const CACHE_VERSION = 'v2';
const SHELL_CACHE = `fitness-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `fitness-assets-${CACHE_VERSION}`;
const ALL_CACHES = [SHELL_CACHE, ASSET_CACHE];

// index.html is markup only now; the CSS and the app's own script were lifted out
// of it and are part of the shell rather than carried inside it. They also cache
// independently, so an edit to one no longer re-downloads the other.
const SHELL = ['/', '/index.html', '/app.css', '/calc.js', '/app.js'];
const ASSETS = [
  // Same-origin now, so they precache like anything else and the Map works on a
  // first visit offline — which it never did while Leaflet came from unpkg.
  '/vendor/chart.umd.js',
  '/vendor/leaflet.js',
  '/vendor/leaflet.css',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // addAll is all-or-nothing; one 404 in the asset list would leave the whole
    // install failed and the worker permanently stuck, so each is added on its own.
    const shell = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map((u) => shell.add(u).catch(() => {})));
    const assets = await caches.open(ASSET_CACHE);
    await Promise.all(ASSETS.map((u) => assets.add(u).catch(() => {})));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('fitness-') && !ALL_CACHES.includes(n))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// The page asks for this after a user-visible action, so the swap is never a
// surprise mid-session.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

function isShellRequest(url, request) {
  if (url.origin !== self.location.origin) return false;
  return request.mode === 'navigate' || SHELL.includes(url.pathname);
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request) || await cache.match('/index.html');
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}


self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Activity and Zwift data belong to localStorage, not to this layer.
  if (/\/(activities|zwift-routes|sync-training-log|backfill-prs)\b/.test(url.pathname)) return;
  // Map tiles are numerous, large and change rarely — but caching them silently
  // would grow without bound, so they are left to the browser's own HTTP cache.
  if (/tile\.openstreetmap\.org$/.test(url.hostname)) return;

  if (isShellRequest(url, request)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
});
