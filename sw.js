// The Basic Land Game — service worker.
// Cache-first, precaches every app asset so the game plays fully offline.
// Bump CACHE_VERSION whenever any precached asset changes.

const CACHE_VERSION = 'blg-v8';

// All app assets. Paths are relative to the service-worker scope (the project
// root), so this works regardless of where the app is hosted.
const ASSETS = [
  './',
  'index.html',
  'game.html',
  'styles.css',
  'manifest.webmanifest',
  'version.js',
  'icon-192.png',
  'icon-512.png',
  'icon-1024.png',
  'logos/blg-5.svg',
  'src/ui.js',
  'src/engine.js',
  'src/ai.js',
  'src/cards.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // version.js carries the build stamp; serve it network-first so the displayed
  // version is current online, falling back to the cached copy when offline.
  if (new URL(req.url).pathname.endsWith('version.js')) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok && new URL(req.url).origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Cache same-origin successful responses for future offline use.
          if (res && res.ok && new URL(req.url).origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => {
          // Offline fallback: for navigations, serve the cached landing page.
          if (req.mode === 'navigate') return caches.match('index.html');
          return Response.error();
        });
    })
  );
});
