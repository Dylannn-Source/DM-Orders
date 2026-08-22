// Keeps the app openable at the storage unit, where there is often no signal.
//
// Without this, a phone that reloads out of range gets a browser error page and
// the pickup screen is unreachable — the typed run survives in localStorage, but
// there is no way to look at it until you drive back. So the shell is cached.
//
// Network first, cache second: when there is signal everybody gets the current
// build, and a deploy is picked up on the next load rather than being pinned
// behind a stale cache. The cache only ever answers when the network does not.
const SHELL = 'dm-shell-v1';
const FILES = ['/', '/index.html', '/app.js', '/app.css',
               '/logo.png', '/mark.png', '/favicon.png', '/icon-180.png'];

self.addEventListener('install', e => {
  // addAll fails the whole install if one file 404s, so they are cached
  // individually — a missing icon should not cost us the offline app.
  e.waitUntil(caches.open(SHELL)
    .then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // The API is never cached. A stale count served from disk would be worse than
  // no answer, and the app's own offline handling depends on the fetch failing.
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request)
        .then(hit => hit || caches.match('/index.html'))));
});
