// Service Worker pour Pointage 15 min
// Gère les notifications programmées toutes les 15 min, même app fermée

const CACHE_NAME = 'pointage-v1';
const ASSETS = ['./', './index.html', './manifest.json'];

// Install : cache les assets essentiels
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Fetch : servir depuis le cache en offline
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).catch(() => caches.match('./index.html')))
  );
});

// Message : recevoir les paramètres de notification depuis la page
let notifConfig = { enabled: false, start: '08:00', end: '19:00', weekdaysOnly: true, lastCategoryName: null };
let scheduledTimer = null;

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'CONFIG') {
    notifConfig = { ...notifConfig, ...data.config };
    scheduleNext();
  } else if (data.type === 'TEST_NOTIF') {
    showTestNotif();
  }
});

function scheduleNext() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  if (!notifConfig.enabled) return;

  const now = new Date();
  const next = new Date(now);
  const curQ = Math.floor(now.getMinutes() / 15);
  next.setMinutes((curQ + 1) * 15, 0, 0);
  const delay = next.getTime() - now.getTime();

  scheduledTimer = setTimeout(() => {
    fireNotif();
    scheduleNext();
  }, delay);
}

function isInWindow() {
  const now = new Date();
  if (notifConfig.weekdaysOnly) {
    const d = now.getDay();
    if (d === 0 || d === 6) return false;
  }
  const [sh, sm] = notifConfig.start.split(':').map(Number);
  const [eh, em] = notifConfig.end.split(':').map(Number);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= (sh * 60 + sm) && nowMin < (eh * 60 + em);
}

function fmtTime(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function fireNotif() {
  if (!isInWindow()) return;
  const slot = new Date();
  slot.setMinutes(Math.floor(slot.getMinutes() / 15) * 15, 0, 0);
  const next = new Date(slot.getTime() + 15 * 60000);
  const body = notifConfig.lastCategoryName
    ? `Dernière : ${notifConfig.lastCategoryName}. Tape pour pointer ${fmtTime(slot)} → ${fmtTime(next)}.`
    : `Tape pour pointer ${fmtTime(slot)} → ${fmtTime(next)}.`;

  self.registration.showNotification("⏱️ Qu'est-ce que tu fais ?", {
    body: body,
    tag: 'pointage',
    renotify: true,
    requireInteraction: true, // reste à l'écran jusqu'à action
    vibrate: [300, 100, 300, 100, 300], // vibration longue qui réveille
    silent: false,
    badge: './icon-192.png',
    icon: './icon-192.png'
  });
}

function showTestNotif() {
  self.registration.showNotification("✅ Notifications activées", {
    body: "Les rappels seront persistants à l'écran, avec son et vibration.",
    tag: 'pointage-test',
    vibrate: [200, 100, 200],
    badge: './icon-192.png',
    icon: './icon-192.png'
  });
}

// Click sur la notif → ouvrir l'app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

// Periodic Background Sync : réveil périodique pour re-schedule
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'pointage-tick') {
    event.waitUntil((async () => { scheduleNext(); fireNotif(); })());
  }
});
