/*
 * sw.js – Service Worker für die FeedLabelCheck-PWA.
 *
 * Strategie:
 *   - App-Shell (HTML/CSS/JS, Icons, Fallback-Daten) wird bei der
 *     Installation vorab gecacht → App startet komplett offline.
 *   - CDN-Bibliotheken (sql.js, tesseract.js inkl. WASM/Sprachdaten) werden
 *     beim ersten Gebrauch gecacht (cache-first) → OCR und SQLite auch offline.
 *   - Daten-Updates (raw.githubusercontent.com) laufen bewusst am Cache
 *     vorbei – die Versionierung übernimmt data-update.js über IndexedDB.
 */
"use strict";

const CACHE_VERSION = "flc-v1";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const CDN_CACHE = `${CACHE_VERSION}-cdn`;

const SHELL_ASSETS = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "js/data-update.js",
  "js/eval.js",
  "js/labeling.js",
  "js/app.js",
  "data/zusatzstoffe.json",
  "data/labeling.sqlite",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

const CDN_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Daten-Updates nie cachen – Frische garantiert data-update.js selbst.
  if (url.hostname === "raw.githubusercontent.com") return;

  // CDN-Bibliotheken: cache-first, beim ersten Gebrauch ablegen.
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(CDN_CACHE).then(async (cache) => {
        const hit = await cache.match(event.request);
        if (hit) return hit;
        const resp = await fetch(event.request);
        if (resp.ok) cache.put(event.request, resp.clone());
        return resp;
      })
    );
    return;
  }

  // App-Shell: cache-first mit Netz-Fallback (und Nach-Cachen).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(hit => hit || fetch(event.request).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(event.request, copy));
        }
        return resp;
      }))
    );
  }
});
