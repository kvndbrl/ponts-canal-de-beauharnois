self.addEventListener('install', function(event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

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
  const url = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
