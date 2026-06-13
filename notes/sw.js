/* ══════════════════════════════════════════
   THUNDERSTUDY SERVICE WORKER
   Version: bump CACHE_NAME on every deploy
══════════════════════════════════════════ */
const CACHE_NAME    = 'thunderstudy-v19'; // ← bump this on every update
const OFFLINE_URL   = './offline.html';
const MAX_CACHE_ITEMS = 60;

/* ── Assets to cache on install (cache-first) ── */
const CACHE_FIRST = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
  './icon.svg',
  './offline.html',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800;900&family=DM+Mono:wght@400;500&family=Outfit:wght@400;500;600;700;800;900&display=swap',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];

/* ── URLs that must NEVER be intercepted (always go to network) ── */
function isPassThrough(url) {
  return (
    url.includes('googleapis.com/identitytoolkit') ||
    url.includes('firestore.googleapis.com')       ||
    url.includes('googletagmanager')               ||
    url.includes('gstatic.com/firebasejs')         ||
    url.includes('fcm.googleapis.com')
  );
}

/* ── URLs that use network-first (fresh data preferred, cache as fallback) ── */
function isNetworkFirst(url) {
  return (
    url.includes('script.google.com')                     ||
    url.includes('commercesehoga.github.io/cuet/pro.html')||
    url.includes('commercesehoga.github.io/cuet/guide')
  );
}

/* ══════════════════════════════════════════
   INSTALL — pre-cache core assets
══════════════════════════════════════════ */
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CACHE_FIRST).catch(function(err) {
        console.warn('[SW] Pre-cache partial failure (OK):', err);
      });
    })
  );
  self.skipWaiting(); // activate immediately, don't wait for old SW to die
});

/* ══════════════════════════════════════════
   ACTIVATE — clean old caches, claim clients
══════════════════════════════════════════ */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys
          .filter(function(k) { return k !== CACHE_NAME; })
          .map(function(k) {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      );
    })
  );

  self.clients.claim();

  // ── Tell all open tabs: new version is live, with version name
  self.clients.matchAll({ type: 'window' }).then(function(clients) {
    clients.forEach(function(client) {
      client.postMessage({
        type:    'TS_UPDATE_READY',
        version: CACHE_NAME   // e.g. "thunderstudy-v12"
      });
    });
  });
});

/* ══════════════════════════════════════════
   CACHE SIZE TRIM — keep cache lean
══════════════════════════════════════════ */
function trimCache(cacheName, maxItems) {
  caches.open(cacheName).then(function(cache) {
    cache.keys().then(function(keys) {
      if (keys.length > maxItems) {
        cache.delete(keys[0]).then(function() {
          trimCache(cacheName, maxItems);
        });
      }
    });
  });
}

/* ══════════════════════════════════════════
   FETCH — smart caching strategies
══════════════════════════════════════════ */
self.addEventListener('fetch', function(e) {
  const url = e.request.url;

  // 1. Always skip: Firebase auth / Firestore / analytics (never cache or intercept)
  if (isPassThrough(url)) return;

  // 2. Network-first: live API data (notices, exams, pro banner)
  //    Try network → cache result → serve; fall back to cache if offline
  if (isNetworkFirst(url)) {
    e.respondWith(
      fetch(e.request).then(function(response) {
        if (
          response && response.status === 200 &&
          e.request.method === 'GET' &&
          response.type !== 'opaque'
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      }).catch(function() {
        return caches.match(e.request);
      })
    );
    return;
  }

  // 3. Cache-first for everything else: serve from cache instantly,
  //    fetch + cache in background if not cached yet
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;

      return fetch(e.request).then(function(response) {
        if (
          e.request.method === 'GET'    &&
          response && response.status === 200 &&
          response.type !== 'opaque'
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, clone);
            trimCache(CACHE_NAME, MAX_CACHE_ITEMS); // keep cache size in check
          });
        }
        return response;
      }).catch(function() {
        // Offline fallback
        if (e.request.destination === 'document') {
          return caches.match(OFFLINE_URL) || caches.match('./index.html');
        }
      });
    })
  );
});

/* ══════════════════════════════════════════
   MESSAGE — handle commands from the app
══════════════════════════════════════════ */
self.addEventListener('message', function(e) {
  if (!e.data) return;

  // App requests SW to activate immediately (used after update prompt)
  if (e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // App requests full cache clear (e.g. from Settings → Clear Cache)
  if (e.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(function() {
      console.log('[SW] Cache cleared on request');
      if (e.source) {
        e.source.postMessage({ type: 'CACHE_CLEARED', version: CACHE_NAME });
      }
    });
  }

  // App sends specific URLs to pre-cache (e.g. on first load)
  if (e.data.type === 'CACHE_URLS' && Array.isArray(e.data.urls)) {
    caches.open(CACHE_NAME).then(function(cache) {
      cache.addAll(e.data.urls).catch(function(err) {
        console.warn('[SW] CACHE_URLS partial failure:', err);
      });
    });
  }

  // App requests current SW version
  if (e.data.type === 'GET_VERSION') {
    if (e.source) {
      e.source.postMessage({ type: 'SW_VERSION', version: CACHE_NAME });
    }
  }
});

/* ══════════════════════════════════════════
   PERIODIC BACKGROUND SYNC
   Refreshes notices/exams even when app is closed.
   Requires: navigator.permissions + periodicSync registration in app.
══════════════════════════════════════════ */
self.addEventListener('periodicsync', function(e) {
  if (e.tag === 'ts-refresh-notices') {
    e.waitUntil(
      fetch('https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec?action=getNotices')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          return caches.open(CACHE_NAME).then(function(cache) {
            cache.put(
              'ts-notices-bg-cache',
              new Response(JSON.stringify(data), {
                headers: { 'Content-Type': 'application/json' }
              })
            );
          });
        }).catch(function(err) {
          console.warn('[SW] Periodic sync failed:', err);
        })
    );
  }
});

/* ══════════════════════════════════════════
   PUSH SUBSCRIPTION CHANGE
   Handles token rotation silently
══════════════════════════════════════════ */
self.addEventListener('pushsubscriptionchange', function(e) {
  e.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true
    }).then(function(subscription) {
      console.log('[SW] Push subscription refreshed:', subscription.endpoint);
      // You could POST the new token to your server here if needed
    }).catch(function(err) {
      console.warn('[SW] Push subscription change failed:', err);
    })
  );
});

/* ══════════════════════════════════════════
   FCM — Firebase Cloud Messaging
   Background push notifications
══════════════════════════════════════════ */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyAoxORpjq2kIED1hBNAQ2MGJEWlwQ3FCJA",
  authDomain:        "thunderstudy.firebaseapp.com",
  projectId:         "thunderstudy",
  storageBucket:     "thunderstudy.firebasestorage.app",
  messagingSenderId: "83506167126",
  appId:             "1:83506167126:web:9b3e7017ba871103672af7"
});

const messaging = firebase.messaging();

// ── Background push: app is closed or in background
messaging.onBackgroundMessage(function(payload) {
  console.log('[SW] Background push received:', payload);

  const title  = (payload.notification && payload.notification.title) || 'Thunderstudy';
  const body   = (payload.notification && payload.notification.body)  || 'You have a new notice.';
  const icon   = (payload.notification && payload.notification.icon)  || './favicon.svg';
  const data   = payload.data || {};
  const tag    = 'ts-notice-' + (data.noticeId || Date.now());

  self.registration.showNotification(title, {
    body:               body,
    icon:               icon,
    badge:              './favicon.svg',
    vibrate:            [200, 100, 200, 100, 200],
    tag:                tag,
    renotify:           true,
    requireInteraction: true,   // stays visible until user acts
    data:               data,
    actions: [
      { action: 'view',    title: '📖 View' },
      { action: 'dismiss', title: '✕ Dismiss' }
    ]
  });
});

/* ══════════════════════════════════════════
   NOTIFICATION CLICK
   Handles main click + action buttons
══════════════════════════════════════════ */
self.addEventListener('notificationclick', function(e) {
  e.notification.close();

  // Dismiss action — just close, do nothing
  if (e.action === 'dismiss') return;

  // View action or main body click — open / focus the app
  const targetUrl = 'https://commercesehoga.github.io/cuet/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      // If app tab is already open, focus it
      for (var i = 0; i < clients.length; i++) {
        if (clients[i].url.includes('commercesehoga.github.io') && 'focus' in clients[i]) {
          return clients[i].focus();
        }
      }
      // Otherwise open a new tab
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

/* ══════════════════════════════════════════
   NOTIFICATION CLOSE
   Fires when user swipes away the notification
══════════════════════════════════════════ */
self.addEventListener('notificationclose', function(e) {
  console.log('[SW] Notification dismissed by user:', e.notification.tag);
  // Could log dismissal analytics here if needed
});
