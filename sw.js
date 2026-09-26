const CACHE = 'neu-schedule-v15';
const CORE = [
  './',
  './index.html',
  './styles.css?v=15',
  './data.js?v=15',
  './push-config.js?v=15',
  './app.js?v=15',
  './manifest.webmanifest?v=15',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let message;
    try { message = event.data?.json(); } catch (_) {}
    const notice = message?.web_push === 8030 ? message.notification : null;
    const title = typeof notice?.title === 'string' && notice.title ? notice.title : '课表提醒';
    const body = typeof notice?.body === 'string' ? notice.body : '';
    const url = typeof notice?.navigate === 'string' && new URL(notice.navigate, self.location.href).origin === self.location.origin
      ? notice.navigate : new URL('./', self.registration.scope).href;
    await self.registration.showNotification(title, { body, icon: './icons/icon-192.png', badge: './icons/icon-192.png', data: { url } });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = event.notification.data?.url || new URL('./', self.registration.scope).href;
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const found = windows.find(client => client.url.startsWith(self.registration.scope));
    if (found) { await found.focus(); if ('navigate' in found) await found.navigate(url); }
    else await clients.openWindow(url);
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) caches.open(CACHE).then(cache => cache.put('./index.html', response.clone()));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
        return response;
      });
    })
  );
});
