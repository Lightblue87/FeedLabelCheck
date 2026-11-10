/*
 * sw.js – Service Worker für die FeedLabelCheck-PWA.
 *
 * Strategie:
 *   - App-Shell (HTML/CSS/JS, Icons, Fallback-Daten) wird bei der
 *     Installation vorab gecacht → App startet komplett offline. Der Cache
 *     trägt die Build-ID der Auslieferung.
 *   - Drittanbieter-Bibliotheken (sql.js, tesseract.js inkl. WASM/Sprachdaten)
 *     liegen lokal unter vendor/ und werden in einem eigenen, selten
 *     wechselnden Cache gehalten.
 *   - Daten-Updates (raw.githubusercontent.com) laufen bewusst am Cache
 *     vorbei – die Versionierung übernimmt data-update.js über IndexedDB.
 */
"use strict";

// Wird beim Deployment durch die Commit-Kennung ersetzt (.github/workflows/deploy-pages.yml). Jede Auslieferung
// ändert damit sw.js, der Browser erkennt das Update ohne manuelles Hochzählen. Lokal bleibt „dev“.
const BUILD_ID = "dev";
// Nur erhöhen, wenn sich Dateien unter vendor/ ändern: Sie werden getrennt gecacht und bei einem App-Update
// nicht erneut geladen (rund 28 MB Tesseract).
const VENDOR_VERSION = "v1";
const CACHE_PREFIX = "flc-";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${BUILD_ID}`;
const VENDOR_CACHE = `${CACHE_PREFIX}vendor-${VENDOR_VERSION}`;

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
  "js/history.js",
  "js/pwa-update.js",
  "js/app.js",
  "data/zusatzstoffe.json",
  "data/labeling.sqlite",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

const VENDOR_ASSETS = [
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
];

const isVendor = url => url.pathname.includes("/vendor/");

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // "no-cache": beim Vorab-Cachen am HTTP-Cache vorbei revalidieren
    // (GitHub Pages liefert max-age=600), sonst kann eine neue SW-Version alte Dateien einsammeln.
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL_ASSETS.map(u => new Request(u, { cache: "no-cache" })));
    // Vendor-Dateien nur laden, wenn sie im Vendor-Cache fehlen: ein App-Update lädt so nur die kleine App-Shell.
    // Scheitert der Erstdownload, scheitert die Installation (kein halber Offline-Stand).
    const vendor = await caches.open(VENDOR_CACHE);
    for (const asset of VENDOR_ASSETS) {
      if (await vendor.match(asset)) continue;
      // Beim Wechsel von der alten Cache-Aufteilung liegt die Datei noch im bisherigen Cache: kopieren statt laden.
      const existing = await caches.match(asset);
      if (existing) await vendor.put(asset, existing.clone());
      else await vendor.add(new Request(asset, { cache: "no-cache" }));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      // Nur eigene Caches (Präfix „flc-“): unter lightblue87.github.io liegen weitere Projekte.
      .then(keys => Promise.all(keys
        .filter(k => k.startsWith(CACHE_PREFIX) && k !== SHELL_CACHE && k !== VENDOR_CACHE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Die Seite fragt nach dem laufenden Stand („build?“) und kann ein wartendes Update sofort aktivieren.
self.addEventListener("message", (event) => {
  if (event.data === "build?") (event.ports[0] || event.source)?.postMessage({ type: "build", id: BUILD_ID });
  else if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Daten-Updates nie cachen – Frische garantiert data-update.js selbst.
  if (url.hostname === "raw.githubusercontent.com") return;

  if (url.origin === self.location.origin) {
    // Die Versionsdatei der Auslieferung wird nie gecacht: Die Seite vergleicht sie mit dem laufenden Stand.
    if (url.pathname.endsWith("/version.json")) return;
    // App-Shell und Vendor: cache-first mit Netz-Fallback (und Nach-Cachen).
    event.respondWith(
      caches.match(event.request).then(hit => hit || fetch(event.request).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(isVendor(url) ? VENDOR_CACHE : SHELL_CACHE).then(cache => cache.put(event.request, copy));
        }
        return resp;
      }))
    );
  }
});
