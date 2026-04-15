self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Ponts Beauharnois';
  const tag = data.tag || ('pont-' + (data.bridge || 'gonzague'));
  const isAvailable = data.body && (
    data.body.includes('Disponible') || data.body.includes('Available') ||
    data.body.includes('normale') || data.body.includes('normal')
  );

  const actions = [];
  if (data.mapsUrl && !isAvailable) {
    actions.push({ action: 'maps', title: '🗺 Itinéraire alternatif' });
  }

  const options = {
    body: data.body || '',
    icon: data.icon || '/notification-icon.png',
    badge: '/notification-icon.png',
    tag: tag,
    renotify: true,
    // disponible auto-dismisses after 8s, other statuses stay until dismissed
    requireInteraction: !isAvailable,
    silent: isAvailable, // no sound/vibration for disponible
    actions: actions,
    data: { mapsUrl: data.mapsUrl }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const mapsUrl = event.notification.data?.mapsUrl;

  if (event.action === 'maps' && mapsUrl) {
    event.waitUntil(clients.openWindow(mapsUrl));
  } else {
    event.waitUntil(clients.openWindow('/'));
  }
});
