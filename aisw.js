/* ═══════════════════════════════════════════════════════════════
   AI TOOLS HUB — Service Worker  (sw.js)
   ─────────────────────────────────────────────────────────────
   Strategy overview
   ┌─────────────────────────────┬──────────────────────────────┐
   │ Resource type               │ Strategy                     │
   ├─────────────────────────────┼──────────────────────────────┤
   │ App shell (HTML/CSS/fonts)  │ Cache-first, update in bg    │
   │ CDN libs (Bootstrap etc.)   │ Cache-first (long TTL)       │
   │ Apps Script API calls       │ Network-first, cache fallback│
   │ Google Fonts                │ Cache-first, stale-while-rv  │
   │ Everything else             │ Network-first                │
   └─────────────────────────────┴──────────────────────────────┘
═══════════════════════════════════════════════════════════════ */

const APP_VERSION   = 'v1.0.0';
const SHELL_CACHE   = 'aih-shell-'   + APP_VERSION;
const CDN_CACHE     = 'aih-cdn-'     + APP_VERSION;
const API_CACHE     = 'aih-api-'     + APP_VERSION;
const FONT_CACHE    = 'aih-fonts-'   + APP_VERSION;

/* Files to pre-cache on install (app shell) */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

/* CDN resources to cache on first use */
const CDN_ORIGINS = [
  'cdn.jsdelivr.net',
  'unpkg.com'
];

/* Font origins */
const FONT_ORIGINS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

/* Apps Script base (API calls) */
const API_ORIGIN = 'script.google.com';

/* ── Max entries & TTL for each cache ── */
const LIMITS = {
  api  : { entries: 50,  ttlMs: 5  * 60 * 1000 },   //  5 min
  cdn  : { entries: 80,  ttlMs: 7  * 24 * 60 * 60 * 1000 }, // 7 days
  font : { entries: 30,  ttlMs: 30 * 24 * 60 * 60 * 1000 }  // 30 days
};

/* ════════════════════════════════════════
   INSTALL — pre-cache app shell
════════════════════════════════════════ */
self.addEventListener('install', function(event) {
  console.log('[SW] Installing', APP_VERSION);
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function(cache) {
        return cache.addAll(SHELL_ASSETS);
      })
      .then(function() {
        // Activate immediately — don't wait for old SW to die
        return self.skipWaiting();
      })
      .catch(function(err) {
        // If a shell asset fails to fetch (e.g. dev env without icons),
        // don't block installation — just log it
        console.warn('[SW] Pre-cache partial failure (non-fatal):', err);
        return self.skipWaiting();
      })
  );
});

/* ════════════════════════════════════════
   ACTIVATE — clean up old caches
════════════════════════════════════════ */
self.addEventListener('activate', function(event) {
  console.log('[SW] Activating', APP_VERSION);
  var currentCaches = [SHELL_CACHE, CDN_CACHE, API_CACHE, FONT_CACHE];
  event.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(
          keys
            .filter(function(key) { return !currentCaches.includes(key); })
            .map(function(key) {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
        );
      })
      .then(function() {
        // Take control of all open clients immediately
        return self.clients.claim();
      })
  );
});

/* ════════════════════════════════════════
   FETCH — routing logic
════════════════════════════════════════ */
self.addEventListener('fetch', function(event) {
  var req = event.request;
  var url = new URL(req.url);

  /* ── Skip non-GET, chrome-extension, data: URIs ── */
  if (req.method !== 'GET') return;
  if (!req.url.startsWith('http')) return;

  /* ── WebAuthn / credentials API — never intercept ── */
  if (url.pathname.includes('webauthn') || url.pathname.includes('credential')) return;

  /* ── Apps Script API calls → Network-first, short-lived cache ── */
  if (url.hostname === API_ORIGIN || url.hostname.endsWith('.googleapis.com') && url.pathname.includes('/macros/')) {
    event.respondWith(networkFirstWithCache(req, API_CACHE, LIMITS.api));
    return;
  }

  /* ── Google Fonts → Cache-first (long TTL) ── */
  if (FONT_ORIGINS.includes(url.hostname)) {
    event.respondWith(cacheFirstWithNetwork(req, FONT_CACHE, LIMITS.font));
    return;
  }

  /* ── CDN resources → Cache-first (very long TTL) ── */
  if (CDN_ORIGINS.includes(url.hostname)) {
    event.respondWith(cacheFirstWithNetwork(req, CDN_CACHE, LIMITS.cdn));
    return;
  }

  /* ── App shell (same origin HTML/assets) → Cache-first, bg update ── */
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  /* ── Everything else → Network-first, no cache ── */
  event.respondWith(fetch(req).catch(function() { return offlineFallback(req); }));
});

/* ════════════════════════════════════════
   STRATEGY HELPERS
════════════════════════════════════════ */

/**
 * Network-first: try network, fall back to cache.
 * Saves successful network responses back to cache.
 * Respects TTL — stale cached entries are treated as misses.
 */
async function networkFirstWithCache(req, cacheName, limits) {
  var cache = await caches.open(cacheName);
  try {
    var networkRes = await fetch(req);
    if (networkRes.ok) {
      var resClone = networkRes.clone();
      // Attach timestamp metadata via a wrapper header trick:
      // Store as a custom Response with a timestamp body wrapper isn't possible
      // directly, so we use cache metadata stored in a separate key.
      cache.put(req, resClone);
      await trimCache(cache, limits.entries);
      await setTimestamp(cacheName, req.url);
    }
    return networkRes;
  } catch (_) {
    // Network failed — try cache (honour TTL)
    var cached = await cache.match(req);
    if (cached && !isExpired(cacheName, req.url, limits.ttlMs)) {
      return cached;
    }
    // Expired or no cache
    if (cached) return cached; // serve stale if truly offline
    return offlineFallback(req);
  }
}

/**
 * Cache-first: serve from cache if present & fresh.
 * Fetches from network otherwise and caches the result.
 */
async function cacheFirstWithNetwork(req, cacheName, limits) {
  var cache = await caches.open(cacheName);
  var cached = await cache.match(req);
  if (cached && !isExpired(cacheName, req.url, limits.ttlMs)) {
    return cached;
  }
  try {
    var networkRes = await fetch(req);
    if (networkRes.ok) {
      cache.put(req, networkRes.clone());
      await trimCache(cache, limits.entries);
      await setTimestamp(cacheName, req.url);
    }
    return networkRes;
  } catch (_) {
    // Serve stale if network fails, even if expired
    if (cached) return cached;
    return offlineFallback(req);
  }
}

/**
 * Stale-while-revalidate: serve cache immediately, update in background.
 * Best for app shell — instant load + stays fresh.
 */
async function staleWhileRevalidate(req, cacheName) {
  var cache  = await caches.open(cacheName);
  var cached = await cache.match(req);

  var fetchPromise = fetch(req).then(function(networkRes) {
    if (networkRes.ok) cache.put(req, networkRes.clone());
    return networkRes;
  }).catch(function() { return null; });

  return cached || await fetchPromise || offlineFallback(req);
}

/* ════════════════════════════════════════
   OFFLINE FALLBACK
════════════════════════════════════════ */
async function offlineFallback(req) {
  /* Try serving cached index.html for navigation requests */
  if (req.mode === 'navigate') {
    var cache  = await caches.open(SHELL_CACHE);
    var cached = await cache.match('/index.html') || await cache.match('/');
    if (cached) return cached;
  }

  /* For API requests, return a structured JSON error */
  var url = new URL(req.url);
  if (url.hostname === API_ORIGIN || url.searchParams.has('action')) {
    return new Response(
      JSON.stringify({ success: false, error: 'offline', message: 'You are offline. Please check your connection.' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  /* Generic offline page */
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#07080c">
<title>Offline — AI Tools Hub</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:'Outfit',system-ui,sans-serif;
    background:#07080c;color:#eeeef5;
    min-height:100vh;display:flex;flex-direction:column;
    align-items:center;justify-content:center;
    padding:24px;text-align:center;
  }
  .ico{font-size:56px;margin-bottom:20px;animation:pulse 2s ease infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  h1{font-size:22px;font-weight:800;margin-bottom:8px;
     background:linear-gradient(135deg,#e8a430,#f5c842);
     -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  p{font-size:14px;color:#6b6d80;line-height:1.6;max-width:300px;margin:0 auto 24px}
  button{
    padding:14px 28px;background:linear-gradient(135deg,#e8a430,#f5c842);
    border:none;border-radius:12px;color:#0a0a0a;
    font-size:15px;font-weight:700;cursor:pointer;
  }
  button:active{opacity:.85}
</style>
</head>
<body>
  <div class="ico">📡</div>
  <h1>You're Offline</h1>
  <p>AI Tools Hub needs an internet connection to load your tools. Please check your network and try again.</p>
  <button onclick="window.location.reload()">Try Again</button>
</body>
</html>`,
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/* ════════════════════════════════════════
   CACHE UTILITIES
════════════════════════════════════════ */

/* Trim cache to max entries (oldest first) */
async function trimCache(cache, maxEntries) {
  var keys = await cache.keys();
  if (keys.length > maxEntries) {
    var toDelete = keys.slice(0, keys.length - maxEntries);
    await Promise.all(toDelete.map(function(k) { return cache.delete(k); }));
  }
}

/* ── Timestamp store (IndexedDB-free, uses a special cache entry) ── */
var TS_CACHE = 'aih-timestamps';

async function setTimestamp(cacheName, url) {
  try {
    var store = await caches.open(TS_CACHE);
    var key   = cacheName + '::' + url;
    var res   = new Response(String(Date.now()), {
      headers: { 'Content-Type': 'text/plain' }
    });
    await store.put(new Request(key), res);
  } catch (_) {}
}

async function getTimestamp(cacheName, url) {
  try {
    var store  = await caches.open(TS_CACHE);
    var key    = cacheName + '::' + url;
    var cached = await store.match(new Request(key));
    if (!cached) return 0;
    var txt = await cached.text();
    return parseInt(txt, 10) || 0;
  } catch (_) { return 0; }
}

function isExpired(cacheName, url, ttlMs) {
  /* Synchronous check won't work — we use a separate async guard;
     this function is called after awaiting getTimestamp in the flow below.
     For simplicity we store the timestamp in a module-level Map during
     the SW's lifetime so the check can be synchronous after first load. */
  var key = cacheName + '::' + url;
  var ts  = _tsMap.get(key);
  if (!ts) return false;  // no record → treat as fresh (will be fetched)
  return (Date.now() - ts) > ttlMs;
}

var _tsMap = new Map();

/* Warm up the in-memory timestamp map from the cache store */
(async function warmTimestamps() {
  try {
    var store = await caches.open(TS_CACHE);
    var keys  = await store.keys();
    for (var i = 0; i < keys.length; i++) {
      var r   = await store.match(keys[i]);
      var txt = await r.text();
      _tsMap.set(keys[i].url, parseInt(txt, 10));
    }
  } catch (_) {}
})();

/* Override setTimestamp to also update _tsMap */
var _origSetTs = setTimestamp;
setTimestamp = async function(cacheName, url) {
  var key = cacheName + '::' + url;
  _tsMap.set(key, Date.now());
  return _origSetTs(cacheName, url);
};

/* ════════════════════════════════════════
   BACKGROUND SYNC (for offline launches)
════════════════════════════════════════ */
self.addEventListener('sync', function(event) {
  if (event.tag === 'sync-tool-clicks') {
    event.waitUntil(syncPendingClicks());
  }
});

async function syncPendingClicks() {
  /* Read pending clicks from cache (stored by main thread when offline) */
  var store  = await caches.open('aih-pending-clicks');
  var keys   = await store.keys();
  for (var i = 0; i < keys.length; i++) {
    try {
      var r    = await store.match(keys[i]);
      var data = await r.json();
      var res  = await fetch(data.url, {
        method : 'GET',
        mode   : 'cors'
      });
      if (res.ok) await store.delete(keys[i]);
    } catch (_) { /* keep for next sync */ }
  }
}

/* ════════════════════════════════════════
   PUSH NOTIFICATIONS (ready to use)
════════════════════════════════════════ */
self.addEventListener('push', function(event) {
  if (!event.data) return;
  var data = event.data.json();
  var opts = {
    body   : data.body  || 'New update from AI Tools Hub',
    icon   : '/icons/icon-192.png',
    badge  : '/icons/icon-72.png',
    tag    : data.tag   || 'aih-notification',
    renotify: true,
    data   : { url: data.url || '/' },
    actions: [
      { action: 'open',    title: 'Open App' },
      { action: 'dismiss', title: 'Dismiss'  }
    ]
  };
  event.waitUntil(
    self.registration.showNotification(data.title || '⚡ AI Tools Hub', opts)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  if (event.action === 'dismiss') return;
  var targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clients) {
        for (var i = 0; i < clients.length; i++) {
          if (clients[i].url === targetUrl && 'focus' in clients[i]) {
            return clients[i].focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      })
  );
});

/* ════════════════════════════════════════
   MESSAGE HANDLER (from main thread)
════════════════════════════════════════ */
self.addEventListener('message', function(event) {
  var data = event.data;
  if (!data) return;

  /* Force update check */
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  /* Clear all caches (e.g. after logout) */
  if (data.type === 'CLEAR_CACHES') {
    caches.keys().then(function(keys) {
      Promise.all(keys.map(function(k) { return caches.delete(k); }))
        .then(function() {
          if (event.source) event.source.postMessage({ type: 'CACHES_CLEARED' });
        });
    });
    return;
  }

  /* Prefetch a list of URLs */
  if (data.type === 'PREFETCH' && Array.isArray(data.urls)) {
    caches.open(SHELL_CACHE).then(function(cache) {
      data.urls.forEach(function(url) {
        fetch(url).then(function(r) { if (r.ok) cache.put(url, r); }).catch(function(){});
      });
    });
    return;
  }
});

console.log('[SW] sw.js loaded —', APP_VERSION);