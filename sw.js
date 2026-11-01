// ─── Cache ──────────────────────────────────────────────────────────────
// Bump this version on every deploy that changes images, icons, CSS or JS:
// the new service worker then deletes the old cache and re-downloads them.
const CACHE_VERSION = 'v1';
const STATIC_CACHE = 'static-' + CACHE_VERSION;
const PAGES_CACHE = 'pages-' + CACHE_VERSION;

// Files served cache-first (one download, then zero network requests)
const STATIC_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|woff2?|ttf|otf|json|webmanifest)$/i;

// Never touched by the service worker
const BYPASS_PATHS = ['/sw.js', '/visitor-ping', '/_vercel/'];

self.addEventListener('install', function(event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(
          keys
            .filter(function(key) { return key !== STATIC_CACHE && key !== PAGES_CACHE; })
            .map(function(key) { return caches.delete(key); })
        );
      })
      .then(function() { return clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same origin only: Render backend, SSE, Umami, GitHub, BMC go straight to the network
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PATHS.some(function(p) { return url.pathname.startsWith(p); })) return;

  // HTML pages: network-first (always fresh), cache as offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(function(res) {
          if (res.ok) {
            const copy = res.clone();
            caches.open(PAGES_CACHE).then(function(cache) { cache.put(req, copy); });
          }
          return res;
        })
        .catch(function() {
          return caches.match(req, { ignoreSearch: true })
            .then(function(cached) { return cached || caches.match('/', { ignoreSearch: true }); });
        })
    );
    return;
  }

  // Static assets: cache-first
  if (STATIC_EXT.test(url.pathname)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(function(cache) {
        return cache.match(req).then(function(cached) {
          if (cached) return cached;
          return fetch(req).then(function(res) {
            if (res.ok && res.type === 'basic') cache.put(req, res.clone());
            return res;
          });
        });
      })
    );
  }
});

// ─── Push ───────────────────────────────────────────────────────────────
self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};

  const options = {
    body: data.body || '',
    icon: data.icon || '/notification-icon.png',
    badge: data.badge || '/badge-default.png',
    tag: data.tag || 'pont-widget',
    renotify: false,
    requireInteraction: false,
    silent: false,
    vibrate: [],
    data: { url: data.url || '/' },
  };

  if (data.actions && data.actions.length > 0) {
    options.actions = data.actions;
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Ponts Beauharnois', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const tag = event.notification.tag;
  const url = tag === 'donation-monthly'
    ? 'https://buymeacoffee.com/kvndbrl'
    : (event.notification.data?.url || '/');
  event.waitUntil(clients.openWindow(url));
});
