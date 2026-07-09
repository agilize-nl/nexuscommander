/// <reference lib="webworker" />
// Bump this on every release so `activate` evicts the previous cache instead
// of serving stale app-shell/build assets to returning users.
const CACHE_VERSION = 'v0.8.27';
const CACHE_NAME = `app-store-${CACHE_VERSION}`;
const ASSETS = [
  '/',
  '/favicon.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        ASSETS.map((asset) =>
          fetch(asset)
            .then((response) => response.ok ? cache.put(asset, response) : undefined)
            .catch(() => undefined)
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // During Vite/dev or installed-PWA testing against the dev server, stay out
  // of the way entirely. Dev responses are often streamed/HMR-specific and are
  // not useful to cache; trying to cache them can break interactivity.
  if (url.port === '5173' || url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return;
  }

  // For API calls, use Network-First strategy to ensure fresh file listings
  if (url.pathname.startsWith('/api/') || url.port === '3721') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(event.request);
      })
    );
    return;
  }

  // SvelteKit's build output under /_app/immutable/ is content-hashed, so it's
  // safe (and fast) to serve cache-first forever.
  if (url.pathname.startsWith('/_app/immutable/')) {
    event.respondWith(
      caches.match(event.request).then((response) => {
        if (response) return response;
        return fetch(event.request).then((networkResponse) => {
          const cacheResponse = networkResponse.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(event.request, cacheResponse))
            .catch(() => undefined);
          return networkResponse;
        });
      })
    );
    return;
  }

  // Everything else (app shell HTML, non-hashed assets) is mutable across
  // deploys: prefer the network so fixes show up immediately, falling back
  // to cache only when offline.
  event.respondWith(
    fetch(event.request).then((networkResponse) => {
      const cacheResponse = networkResponse.clone();
      caches.open(CACHE_NAME)
        .then((cache) => cache.put(event.request, cacheResponse))
        .catch(() => undefined);
      return networkResponse;
    }).catch(() => caches.match(event.request))
  );
});
