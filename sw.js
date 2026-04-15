self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Ponts Beauharnois';
  const tag = data.tag || ('pont-' + (data.bridge || 'gonzague'));
  const isAvailable = data.body && (
    data.body.includes('Disponible') || data.body.includes('Available') ||
    data.body.includes('normale') || data.body.includes('normal')
  );

  const options = {
    body: data.body || '',
    icon: data.icon || '/notification-icon.png',
    badge: '/notification-icon.png',
    tag: tag,
    renotify: true,
    requireInteraction: !isAvailable,
    silent: isAvailable
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
