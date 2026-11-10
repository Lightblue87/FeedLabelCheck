/*
 * pwa-update.js – App-Updates der PWA (Service Worker) erkennen und übernehmen.
 *
 * Aufgaben:
 *   - Service Worker registrieren und regelmäßig nach einer neuen Version suchen: beim Start, bei Rückkehr in die
 *     App (iOS-PWAs kommen meist aus dem Speicher zurück), bei erneutem Netz und in festem Abstand.
 *   - Den laufenden Stand (Build-ID des aktiven Service Workers) mit der veröffentlichten Version (version.json)
 *     vergleichen. Wird eine neue Version nicht übernommen, meldet die Seite „verfügbar“ statt still zu bleiben.
 *   - Nach der Übernahme neu laden, aber nicht mitten in einer OCR.
 *   - Notausgang: App-Dateien (eigener Service Worker und eigene Caches) löschen und neu laden. Fachdaten
 *     (IndexedDB) und Prüfverlauf bleiben erhalten.
 */
"use strict";

const PwaUpdate = (() => {
  const MIN_GAP_MS = 60 * 1000;         // Mindestabstand zwischen zwei Prüfungen
  const INTERVAL_MS = 30 * 60 * 1000;   // regelmäßige Prüfung bei sichtbarer App
  const STUCK_MS = 45 * 1000;           // so lange wartet die Seite auf die Übernahme einer neuen Version
  const FETCH_TIMEOUT_MS = 10 * 1000;   // Obergrenze für den Abruf von version.json
  const IDLE_POLL_MS = 2000;
  const MAX_IDLE_WAIT_MS = 5 * 60 * 1000;
  const CACHE_PREFIX = "flc-";

  // ── Reine Entscheidungen (ohne Browser testbar) ──
  const dueForCheck = (now, last, gap = MIN_GAP_MS) => last == null || now - last >= gap;

  function parseVersion(json) {
    const build = json && typeof json.build === "string" ? json.build.trim() : "";
    return /^[0-9a-f]{7,40}$/i.test(build) ? build.toLowerCase() : null;
  }

  // „dev“ (lokal, nicht ausgeliefert) und unbekannte Stände werden nie als veraltet gemeldet.
  function versionState(running, remote) {
    if (!running || !remote || running === "dev") return "unknown";
    return running === remote ? "current" : "newer";
  }

  // Reload erst, wenn nichts Flüchtiges läuft; nach der Höchstwartezeit trotzdem (der Entwurf ist gespeichert).
  const reloadDelay = (busy, waitedMs) => busy && waitedMs < MAX_IDLE_WAIT_MS ? IDLE_POLL_MS : 0;

  if (typeof navigator === "undefined" || typeof document === "undefined") {
    return { dueForCheck, parseVersion, versionState, reloadDelay, MIN_GAP_MS, STUCK_MS, MAX_IDLE_WAIT_MS };
  }

  // ── Browser ──
  let registration = null;
  let hadController = false;
  let controllerChanges = 0;
  let reloadScheduled = false;
  let isBusy = () => false;
  let lastCheck = null;
  let running = null;
  let checking = null;
  const state = { running: null, remote: null, checkedAt: null, result: "unknown" };
  const listeners = new Set();
  const emit = () => listeners.forEach(fn => { try { fn({ ...state }); } catch { /* Anzeige darf das Update nicht stören */ } });

  function askBuild() {
    const worker = navigator.serviceWorker.controller;
    if (!worker) return Promise.resolve(null);
    return new Promise(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 3000);
      channel.port1.onmessage = event => {
        clearTimeout(timer);
        resolve(event.data && event.data.type === "build" ? event.data.id : null);
      };
      worker.postMessage("build?", [channel.port2]);
    });
  }

  // undefined: nicht erreichbar; null: erreichbar, aber ohne gültige Version (lokal, nicht ausgeliefert).
  // Die Laufzeit ist einschließlich des Einlesens der Antwort begrenzt: eine hängende Verbindung darf weder die
  // Prüfung (checking) noch die späteren Prüfungen blockieren.
  async function fetchRemoteBuild() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) return null;
      return parseVersion(await response.json());
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  const waitForSwitch = async (since, ms) => {
    const end = Date.now() + ms;
    while (controllerChanges === since && Date.now() < end) await new Promise(r => setTimeout(r, 500));
    return controllerChanges !== since;
  };

  function reloadWhenIdle() {
    if (reloadScheduled) return;
    reloadScheduled = true;
    const started = Date.now();
    const tick = () => {
      const delay = reloadDelay(isBusy(), Date.now() - started);
      if (delay > 0) setTimeout(tick, delay);
      else location.reload();
    };
    tick();
  }

  function check(reason = "auto", { force = false } = {}) {
    if (!registration) return Promise.resolve({ ...state });
    if (checking) return checking;
    if (!force && !dueForCheck(Date.now(), lastCheck)) return Promise.resolve({ ...state });
    lastCheck = Date.now();
    checking = (async () => {
      try {
        const since = controllerChanges;
        // Das Worker-Update läuft unabhängig vom Abruf der Versionsdatei.
        registration.update().catch(() => { /* offline: der laufende Stand bleibt */ });
        const [remote, build] = await Promise.all([fetchRemoteBuild(), askBuild()]);
        if (build) running = build;
        state.running = running;
        if (remote === undefined) {
          state.result = "offline";
        } else {
          state.remote = remote;
          const verdict = versionState(running, remote);
          if (verdict === "newer") {
            state.result = "updating";
            emit();
            state.result = (await waitForSwitch(since, STUCK_MS)) ? "updating" : "available";
          } else {
            state.result = verdict;
          }
        }
      } finally {
        state.checkedAt = Date.now();
        checking = null;
        emit();
      }
      return { ...state };
    })();
    return checking;
  }

  function start({ isBusy: busy } = {}) {
    if (!("serviceWorker" in navigator)) return;
    if (busy) isBusy = busy;
    hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // Der erste Wechsel (Erst-Installation übernimmt die Seite) braucht keinen Reload, aber den Stand kennen.
      if (!hadController) { hadController = true; check("erste Installation", { force: true }); return; }
      controllerChanges += 1;
      reloadWhenIdle();
    });
    navigator.serviceWorker.register("sw.js").then(reg => {
      registration = reg;
      check("start", { force: true });
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check("sichtbar"); });
      window.addEventListener("pageshow", event => { if (event.persisted) check("pageshow"); });
      window.addEventListener("online", () => check("online"));
      setInterval(() => { if (document.visibilityState === "visible") check("intervall"); }, INTERVAL_MS);
    }).catch(() => { /* z. B. file:// oder unsicherer Kontext – die App läuft auch ohne Service Worker */ });
  }

  // Notausgang: nur den eigenen Service Worker und die eigenen Caches entfernen, nie andere Projekte der Origin.
  async function reset() {
    if (registration) await registration.unregister().catch(() => {});
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX)).map(k => caches.delete(k)));
    }
    location.reload();
  }

  const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };

  return {
    dueForCheck, parseVersion, versionState, reloadDelay, MIN_GAP_MS, STUCK_MS, MAX_IDLE_WAIT_MS, FETCH_TIMEOUT_MS,
    start, check, reset, onChange, info: () => ({ ...state }),
  };
})();

// Für Unit-Tests unter Node (im Browser ohne Wirkung).
if (typeof module !== "undefined" && module.exports) module.exports = PwaUpdate;
