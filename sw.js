self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Ponts Beauharnois';
  const options = {
    body: data.body || '',
    icon: '/notification-icon.png',
    badge: '/notification-icon.png',
    tag: 'pont-beauharnois',
    renotify: true,
    requireInteraction: data.persistent || false
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
