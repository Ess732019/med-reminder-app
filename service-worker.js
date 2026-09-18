const CACHE_NAME = 'med-reminder-cache-v1';
const ASSETS = ['./index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first, cache-fallback: always try to fetch the latest version when
// online (so updates reach everyone automatically), and only fall back to the
// saved offline copy when there's no connection.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Let the page ask this worker to show a system notification.
// Note: this only fires while the browser/PWA process is still running in the
// background. It cannot wake up a fully closed/terminated app without a real
// push server (Web Push + VAPID) sending the message from the outside.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(event.data.title || 'تذكير', {
      body: event.data.body || '',
      icon: 'icon.svg',
      badge: 'icon.svg'
    });
  }
});

// إشعار حقيقي جاي من السيرفر (عبر Web Push). النص جوه الإشعار مشفّر - السيرفر
// نفسه ما يقدرش يقرأه، فك التشفير بيحصل هنا بس على جهاز المريض بمفتاحه الخاص
// المحفوظ في IndexedDB (نفس المفتاح اللي التطبيق ولّده أول مرة).
function openKeyDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('medapp-keys', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('keys'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function b64ToBuf(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }
async function decryptText(packed) {
  if (!packed) return '';
  try {
    const [ivB64, cipherB64] = packed.split('.');
    const db = await openKeyDB();
    const key = await new Promise((res) => {
      const tx = db.transaction('keys', 'readonly').objectStore('keys').get('patientKey');
      tx.onsuccess = () => res(tx.result || null);
      tx.onerror = () => res(null);
    });
    if (!key) return '';
    const iv = b64ToBuf(ivB64);
    const cipher = b64ToBuf(cipherB64);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plainBuf);
  } catch (e) {
    return '';
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) {}
    let title = 'تذكير';
    let body = '';
    if (data.encrypted) {
      title = (await decryptText(data.title)) || 'تذكير الدواء';
      body = (await decryptText(data.body)) || '';
    } else {
      title = data.title || title;
      body = data.body || '';
    }
    await self.registration.showNotification(title, {
      body,
      icon: 'icon.svg',
      badge: 'icon.svg',
      vibrate: [200, 100, 200, 100, 200],
      requireInteraction: true
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('./index.html');
    })
  );
});
