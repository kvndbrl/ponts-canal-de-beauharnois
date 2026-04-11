self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Ponts Beauharnois';

  // Always use white-on-transparent icon — Android requires this format
  // The theme-specific icon from data.icon is also white-on-transparent
  const icon = data.icon || '/notification-icon.png';

  const options = {
    body: data.body || '',
    icon: icon,
    badge: '/notification-icon.png',
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
