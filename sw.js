// ТАЙМЕНЬ · service worker: офлайн-оболочка, API всегда по сети
const CACHE = 'taimen-v1';
const SHELL = ['/', 'manifest.json', 'icon-192.png', 'icon-512.png', 'sounds/birth.wav'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return; // API — только сеть
  // сеть в приоритете (свежий код после деплоя), кэш — как офлайн-фолбэк
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/')))
  );
});
