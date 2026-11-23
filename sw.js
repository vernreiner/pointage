// Service Worker Pointage 15 min v2
// Stratégie : persister la config dans IndexedDB, utiliser un timer court
// qui se re-schedule en continu, et un check "catch-up" à chaque réveil

const CACHE_NAME = 'pointage-v2';
const ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Nettoyer anciens caches
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
    // Re-schedule au démarrage
    await loadConfig();
    scheduleNext();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!url.origin.includes(self.location.origin)) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).catch(() => caches.match('./index.html')))
  );
});

// --- Config persistée dans IndexedDB ---
const DB_NAME = 'pointage-sw';
const STORE = 'config';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

let notifConfig = { enabled: false, start: '08:00', end: '19:00', weekdaysOnly: true, lastCategoryName: null };
let scheduledTimer = null;

async function loadConfig() {
  try {
    const saved = await dbGet('config');
    if (saved) notifConfig = { ...notifConfig, ...saved };
  } catch (e) {}
}

async function saveConfig() {
  try { await dbSet('config', notifConfig); } catch(e) {}
}

// --- Messages depuis la page ---
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'CONFIG') {
    notifConfig = { ...notifConfig, ...data.config };
    saveConfig();
    catchUp();
    scheduleNext();
  } else if (data.type === 'TEST_NOTIF') {
    showTestNotif();
  } else if (data.type === 'CATCHUP') {
    catchUp();
    scheduleNext();
  }
});

// --- Logique de scheduling ---
function slotStart(date) {
  const d = new Date(date);
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  return d;
}

function scheduleNext() {
  if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null; }
  if (!notifConfig.enabled) return;
  const now = new Date();
  const next = new Date(now);
  const curQ = Math.floor(now.getMinutes() / 15);
  next.setMinutes((curQ + 1) * 15, 0, 0);
  const delay = next.getTime() - now.getTime();
  scheduledTimer = setTimeout(() => {
    fireNotif(new Date());
    scheduleNext();
  }, delay + 100);
}

// Catch-up : si on vient de se réveiller et qu'un slot est passé depuis la dernière notif, on tire
async function catchUp() {
  if (!notifConfig.enabled) return;
  const lastFired = await dbGet('lastFired');
  const now = new Date();
  const currentSlot = slotStart(now);
  if (!lastFired || new Date(lastFired).getTime() < currentSlot.getTime()) {
    // Un slot est passé sans notif → tirer maintenant si on est dans la fenêtre
    if (isInWindow(now)) {
      fireNotif(now);
    }
  }
}

function isInWindow(when) {
  if (notifConfig.weekdaysOnly) {
    const d = when.getDay();
    if (d === 0 || d === 6) return false;
  }
  const [sh, sm] = notifConfig.start.split(':').map(Number);
  const [eh, em] = notifConfig.end.split(':').map(Number);
  const minOfDay = when.getHours() * 60 + when.getMinutes();
  return minOfDay >= (sh * 60 + sm) && minOfDay < (eh * 60 + em);
}

function fmtTime(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function fireNotif(when) {
  if (!isInWindow(when)) return;
  const slot = slotStart(when);
  const next = new Date(slot.getTime() + 15 * 60000);
  const body = notifConfig.lastCategoryName
    ? `Dernière : ${notifConfig.lastCategoryName}. Tape pour pointer ${fmtTime(slot)} → ${fmtTime(next)}.`
    : `Tape pour pointer ${fmtTime(slot)} → ${fmtTime(next)}.`;

  await self.registration.showNotification("⏱️ Qu'est-ce que tu fais ?", {
    body: body,
    tag: 'pointage',
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 300],
    silent: false,
    badge: './icon-192.png',
    icon: './icon-192.png'
  });

  await dbSet('lastFired', slot.toISOString());
}

async function showTestNotif() {
  await self.registration.showNotification("✅ Notifications activées", {
    body: "Les rappels seront persistants à l'écran, avec son et vibration.",
    tag: 'pointage-test',
    vibrate: [200, 100, 200],
    badge: './icon-192.png',
    icon: './icon-192.png'
  });
}

// --- Click sur notif → focus l'app ou l'ouvre ---
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if ('focus' in client) {
        await client.focus();
        // Envoyer un message pour forcer un re-render
        client.postMessage({ type: 'NOTIF_CLICKED' });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow('./');
  })());
});

// --- Periodic Background Sync (si dispo) ---
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'pointage-tick') {
    event.waitUntil((async () => {
      await loadConfig();
      await catchUp();
      scheduleNext();
    })());
  }
});

// --- Push sync fallback ---
self.addEventListener('sync', (event) => {
  if (event.tag === 'pointage-sync') {
    event.waitUntil((async () => {
      await loadConfig();
      await catchUp();
      scheduleNext();
    })());
  }
});

// Chargement initial
loadConfig().then(() => scheduleNext());
