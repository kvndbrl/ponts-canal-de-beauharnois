self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Ponts Beauharnois';
  const options = {
    body: data.body || '',
    icon: data.icon || '/notification-icon-gonzaguois.png',
    badge: '/notification-icon-gonzaguois.png',
    tag: 'pont-' + (data.bridge || 'gonzague'),
    renotify: true,
    requireInteraction: data.persistent || false
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
