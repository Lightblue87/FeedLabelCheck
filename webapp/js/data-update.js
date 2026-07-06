/*
 * data-update.js – Automatischer Daten-Update-Mechanismus.
 *
 * Ablauf (Gegenstück zum iOS-DataDownloadService):
 *   1. Start immer mit lokalem Stand: IndexedDB, sonst mitgelieferte Dateien
 *      aus data/ (Offline-fähig, kein Warten auf das Netz).
 *   2. Im Hintergrund manifest-v2.json aus dem FeedLabelCheck-Data-Repo laden
 *      (cache: no-store, Timeout) und SHA256 mit dem lokalen Stand vergleichen.
 *   3. Nur geänderte Dateien herunterladen, gegen Größe + SHA256 aus dem
 *      Manifest verifizieren (Web Crypto API) und erst dann in IndexedDB
 *      speichern.
 *   4. Schlägt der Manifest-Abruf fehl (offline), läuft die App unverändert
 *      mit dem letzten lokalen Stand weiter.
 */
"use strict";

const DataUpdate = (() => {

  const RAW_BASE = "https://raw.githubusercontent.com/Lightblue87/FeedLabelCheck-Data/main/";
  const MANIFEST_URL = RAW_BASE + "manifest-v2.json";
  const DB_NAME = "feedlabelcheck";
  const STORE = "files";
  const FILES = ["zusatzstoffe.json", "labeling.sqlite"];
  const FETCH_TIMEOUT_MS = 10000;

  // ── IndexedDB-Helfer ──────────────────────────────────────────
  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openIdb();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction(STORE).objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function idbPut(key, value) {
    const db = await openIdb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  // ── Krypto/Netz-Helfer ────────────────────────────────────────
  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function fetchWithTimeout(url, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { ...options, signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} für ${url}`);
      return resp;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Lokalen Stand laden ───────────────────────────────────────
  /**
   * Lädt beide Datendateien: bevorzugt aus IndexedDB (letztes Update),
   * sonst die mitgelieferten Dateien aus data/.
   *
   * @returns {Promise<{buffers: Object<string,ArrayBuffer>,
   *                    hashes: Object<string,string>,
   *                    source: string, lastUpdate: string|null}>}
   */
  async function loadLocal() {
    const buffers = {};
    const hashes = {};
    let anyFromIdb = false;
    let lastUpdate = null;

    for (const name of FILES) {
      let entry = null;
      try { entry = await idbGet(name); } catch (e) { /* IDB nicht verfügbar → Bundle */ }
      if (entry && entry.buffer) {
        buffers[name] = entry.buffer;
        hashes[name] = entry.sha256;
        anyFromIdb = true;
        if (entry.storedAt && (!lastUpdate || entry.storedAt > lastUpdate)) {
          lastUpdate = entry.storedAt;
        }
      } else {
        const buf = await (await fetch(`data/${name}`)).arrayBuffer();
        buffers[name] = buf;
        hashes[name] = await sha256Hex(buf);
      }
    }

    return {
      buffers, hashes,
      source: anyFromIdb ? "IndexedDB (letztes Update)" : "mitgelieferte Daten",
      lastUpdate,
    };
  }

  // ── Update-Prüfung ────────────────────────────────────────────
  /**
   * Holt das Manifest, vergleicht die Prüfsummen mit *localHashes* und lädt
   * geänderte Dateien (verifiziert) nach IndexedDB.
   *
   * @returns {Promise<{updated: string[], generatedAt: string|null}>}
   * @throws bei fehlender Internetverbindung / Manifest-Fehler
   */
  async function checkForUpdates(localHashes) {
    const manifest = await (await fetchWithTimeout(MANIFEST_URL, { cache: "no-store" })).json();

    const remoteEntries = [];
    if (manifest.files?.json?.sha256) {
      remoteEntries.push({
        key: "zusatzstoffe.json",
        name: manifest.files.json.name || "zusatzstoffe.json",
        sha256: manifest.files.json.sha256.toLowerCase(),
        bytes: manifest.files.json.bytes,
      });
    }
    if (manifest.labeling_db?.sha256) {
      remoteEntries.push({
        key: "labeling.sqlite",
        name: manifest.labeling_db.file || "labeling.sqlite",
        sha256: manifest.labeling_db.sha256.toLowerCase(),
        bytes: manifest.labeling_db.bytes,
      });
    }

    const updated = [];
    for (const entry of remoteEntries) {
      if ((localHashes[entry.key] || "").toLowerCase() === entry.sha256) continue;

      const buf = await (await fetchWithTimeout(RAW_BASE + entry.name, { cache: "no-store" })).arrayBuffer();
      if (Number.isInteger(entry.bytes) && buf.byteLength !== entry.bytes) {
        throw new Error(`${entry.name}: Größe stimmt nicht (erwartet ${entry.bytes}, erhalten ${buf.byteLength}).`);
      }
      const digest = await sha256Hex(buf);
      if (digest !== entry.sha256) {
        throw new Error(`${entry.name}: SHA256-Prüfsumme stimmt nicht mit dem Manifest überein.`);
      }

      await idbPut(entry.key, {
        buffer: buf,
        sha256: digest,
        storedAt: new Date().toISOString(),
        manifestGeneratedAt: manifest.generated_at || null,
      });
      updated.push(entry.key);
    }

    return { updated, generatedAt: manifest.generated_at || null };
  }

  return { loadLocal, checkForUpdates, RAW_BASE };
})();
