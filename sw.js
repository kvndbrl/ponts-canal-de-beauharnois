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

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientList) {
        // Si l'app est ouverte ET visible (premier plan), ne pas notifier
        const appVisible = clientList.some(client =>
          client.visibilityState === 'visible'
        );

        if (appVisible) {
          console.log('App is in foreground, skipping notification');
          return;
        }

        return self.registration.showNotification(title, options);
      })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
