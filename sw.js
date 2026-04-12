self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Ponts Beauharnois';
  const tag = data.tag || ('pont-' + (data.bridge || 'gonzague'));

  const actions = [];
  if (data.mapsUrl) {
    actions.push({
      action: 'maps',
      title: '🗺 Itinéraire alternatif'
    });
  }

  const options = {
    body: data.body || '',
    icon: data.icon || '/notification-icon.png',
    badge: '/notification-icon.png',
    tag: tag,           // same tag per bridge = replaces previous notification
    renotify: true,     // vibrate/sound even when replacing
    requireInteraction: data.persistent !== false,
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
