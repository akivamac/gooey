const CACHE_NAME = 'gooey-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './vendor/marked.min.js',
  './vendor/dompurify.min.js',
  './vendor/highlight.min.js',
  './vendor/highlight-github.min.css'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only cache same-origin static assets; let API calls go to network
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
      return resp;
    }).catch(() => caches.match('./index.html')))
  );
});
