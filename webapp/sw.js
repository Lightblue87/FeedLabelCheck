/*
 * sw.js – Service Worker für die FeedLabelCheck-PWA.
 *
 * Strategie:
 *   - App-Shell (HTML/CSS/JS, Icons, Fallback-Daten) wird bei der
 *     Installation vorab gecacht → App startet komplett offline.
 *   - Drittanbieter-Bibliotheken (sql.js, tesseract.js inkl. WASM/Sprachdaten)
 *     liegen lokal unter vendor/ und werden ebenfalls vorab gecacht.
 *   - Daten-Updates (raw.githubusercontent.com) laufen bewusst am Cache
 *     vorbei – die Versionierung übernimmt data-update.js über IndexedDB.
 */
"use strict";

const CACHE_VERSION = "flc-v5";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;

const SHELL_ASSETS = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "js/data-update.js",
  "js/eval.js",
  "js/labeling.js",
  "js/ocr.js",
  "js/autocomplete.js",
  "js/app.js",
  "vendor/sql.js/sql-wasm.js",
  "vendor/sql.js/sql-wasm.wasm",
  "vendor/tesseract/tesseract.min.js",
  "vendor/tesseract/worker.min.js",
  "vendor/tesseract/core/tesseract-core.wasm.js",
  "vendor/tesseract/core/tesseract-core.wasm",
  "vendor/tesseract/core/tesseract-core-simd.wasm.js",
  "vendor/tesseract/core/tesseract-core-simd.wasm",
  "vendor/tesseract/core/tesseract-core-lstm.wasm.js",
  "vendor/tesseract/core/tesseract-core-lstm.wasm",
  "vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js",
  "vendor/tesseract/core/tesseract-core-simd-lstm.wasm",
  "vendor/tesseract/lang/deu.traineddata.gz",
  "data/zusatzstoffe.json",
  "data/labeling.sqlite",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // "no-cache": beim Vorab-Cachen am HTTP-Cache vorbei revalidieren,
      // sonst kann eine neue SW-Version alte Dateien einsammeln
      // (GitHub Pages liefert max-age=600).
      .then(cache => cache.addAll(SHELL_ASSETS.map(u => new Request(u, { cache: "no-cache" }))))
      .then(() => self.skipWaiting())
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
