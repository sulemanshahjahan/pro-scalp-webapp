self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // ---- Parse payload once (JSON first, fall back to text) ----
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    const text = event.data?.text?.() || '';
    payload = { title: 'Notification', body: text };
  }

  const title = payload.title || 'Notification';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon.png',
    badge: payload.badge || '/badge.png',
    tag: payload.tag || 'default',
    data: payload.data || {}
  };

  const category =
    payload.category ||
    payload.data?.category ||
    'BEST_ENTRY'; // default if not provided

  // ---- Show ONE notification and post ONE message ----
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);

    // Notify all open pages so they can play the right sound
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of pages) {
      c.postMessage({ type: 'PLAY_SOUND', category, data: options.data });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) return all[0].focus();
    return self.clients.openWindow('/');
  })());
});
