// ─── UniWallet Service Worker ────────────────────────────
// Purpose: Cache the static app shell so the dashboard loads offline.
// Data caching is handled entirely by Firestore's offline persistence.
// Strategy: Cache-first for shell assets, network-first for everything else.

const CACHE_NAME = "uniwallet-shell-v1";

// Static app shell — these files are pre-cached on install.
// Update CACHE_NAME version when any of these files change.
const SHELL_ASSETS = [
  "/dashboard.html",
  "/index.html",
  "/style.css",
  "/app.js",
  "/dashboard.js",
  "/firebase-config.js",
  "/logo.png.png",
  "/manifest.json",
];

// ─── Install: pre-cache the app shell ───────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        console.log("[SW] Pre-caching app shell");
        return cache.addAll(SHELL_ASSETS);
      })
      .then(() => self.skipWaiting()) // Activate immediately
  );
});

// ─── Activate: clean up old caches ──────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => {
              console.log("[SW] Removing old cache:", key);
              return caches.delete(key);
            })
        )
      )
      .then(() => self.clients.claim()) // Take control of all pages immediately
  );
});

// ─── Fetch: cache-first for shell, network-first for rest ─
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only intercept GET requests
  if (event.request.method !== "GET") return;

  // For same-origin requests: cache-first (our app shell)
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          // Return cached version, but also update cache in background
          const fetchPromise = fetch(event.request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200) {
                const responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(event.request, responseClone);
                });
              }
              return networkResponse;
            })
            .catch(() => {}); // Silently fail if offline
          
          // Return cache immediately (stale-while-revalidate)
          return cachedResponse;
        }
        // Not in cache — try network
        return fetch(event.request);
      })
    );
    return;
  }

  // For cross-origin requests (CDN: Firebase SDK, fonts, Chart.js, etc.):
  // Network-first with cache fallback. This ensures CDN resources are
  // available offline after the first successful load.
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Cache successful cross-origin responses for offline use
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Network failed — try cache
        return caches.match(event.request);
      })
  );
});
