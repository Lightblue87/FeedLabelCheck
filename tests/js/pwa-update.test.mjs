/*
 * Unit-Tests für webapp/js/pwa-update.js (Entscheidungslogik) und die Invarianten von webapp/sw.js
 * (Node-Testrunner: `node --test tests/js`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PwaUpdate = require("../../webapp/js/pwa-update.js");
const WEBAPP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "webapp");
const swSource = fs.readFileSync(path.join(WEBAPP, "sw.js"), "utf8");

test("Prüfung wird gedrosselt, die erste und eine erzwungene Prüfung nicht", () => {
  assert.equal(PwaUpdate.dueForCheck(1000, null), true);
  assert.equal(PwaUpdate.dueForCheck(1000 + PwaUpdate.MIN_GAP_MS - 1, 1000), false);
  assert.equal(PwaUpdate.dueForCheck(1000 + PwaUpdate.MIN_GAP_MS, 1000), true);
  assert.equal(PwaUpdate.dueForCheck(10 * 60 * 1000, 0, 30 * 60 * 1000), false);
  assert.equal(PwaUpdate.dueForCheck(30 * 60 * 1000, 0, 30 * 60 * 1000), true);
});

test("version.json: nur gültige Build-IDs zählen", () => {
  assert.equal(PwaUpdate.parseVersion({ build: "0123456789AB", time: "x" }), "0123456789ab");
  for (const bad of [null, {}, { build: "" }, { build: "dev" }, { build: "xyz" }, { build: 12345678 }, { build: "123" }]) {
    assert.equal(PwaUpdate.parseVersion(bad), null, JSON.stringify(bad));
  }
});

test("Versionsvergleich: veraltet nur bei zwei bekannten, verschiedenen Ständen", () => {
  assert.equal(PwaUpdate.versionState("aaaaaaa1", "aaaaaaa1"), "current");
  assert.equal(PwaUpdate.versionState("aaaaaaa1", "bbbbbbb2"), "newer");
  assert.equal(PwaUpdate.versionState("dev", "bbbbbbb2"), "unknown");
  assert.equal(PwaUpdate.versionState(null, "bbbbbbb2"), "unknown");
  assert.equal(PwaUpdate.versionState("aaaaaaa1", null), "unknown");
});

test("Reload wartet, solange eine OCR läuft, aber nicht unbegrenzt", () => {
  assert.equal(PwaUpdate.reloadDelay(false, 0), 0);
  assert.ok(PwaUpdate.reloadDelay(true, 0) > 0);
  assert.ok(PwaUpdate.reloadDelay(true, PwaUpdate.MAX_IDLE_WAIT_MS - 1) > 0);
  assert.equal(PwaUpdate.reloadDelay(true, PwaUpdate.MAX_IDLE_WAIT_MS), 0);
});

test("sw.js: Build-ID-Zeile hat die Form, die der Deployment-Schritt ersetzt", () => {
  const workflow = fs.readFileSync(path.join(WEBAPP, "..", ".github", "workflows", "deploy-pages.yml"), "utf8");
  assert.match(swSource, /^const BUILD_ID = "dev";$/m);
  assert.match(workflow, /Stamp build id/);
  // Der sed-Ausdruck des Workflows muss genau diese Zeile treffen.
  assert.ok(workflow.includes('s/^const BUILD_ID = \\"dev\\";/'));
  assert.match(workflow, /version\.json/);
});

test("sw.js: Shell- und Vendor-Dateien existieren, sind getrennt und vollständig", () => {
  const list = name => [...swSource.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const shell = list("SHELL_ASSETS");
  const vendor = list("VENDOR_ASSETS");
  for (const asset of [...shell, ...vendor]) {
    if (asset === "./") continue;
    assert.ok(fs.existsSync(path.join(WEBAPP, asset)), `${asset} fehlt`);
  }
  assert.ok(vendor.every(asset => asset.startsWith("vendor/")), "Vendor-Liste nur mit vendor/");
  assert.ok(shell.every(asset => !asset.startsWith("vendor/")), "Shell-Liste ohne vendor/");
  assert.ok(shell.includes("js/pwa-update.js"));
  // Jede ausgelieferte Vendor-Datei wird vorab gecacht (sonst fehlt sie offline).
  const onDisk = [];
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full); else onDisk.push(path.relative(WEBAPP, full).split(path.sep).join("/"));
  });
  walk(path.join(WEBAPP, "vendor"));
  const missing = onDisk.filter(f => /\.(js|wasm|gz)$/.test(f) && !vendor.includes(f));
  assert.deepEqual(missing.filter(f => !/LICENSE|README/i.test(f)), [], "nicht vorab gecachte Vendor-Dateien");
});

test("sw.js: Bereinigung betrifft nur eigene Caches, version.json wird nie gecacht", () => {
  assert.match(swSource, /keys\s*\n?\s*\.filter\(k => k\.startsWith\(CACHE_PREFIX\)/);
  assert.match(swSource, /endsWith\("\/version\.json"\)\) return;/);
  assert.match(swSource, /const CACHE_PREFIX = "flc-";/);
});

// ── Verhalten (Codex-Funde zu #50) ──
const vm = require("node:vm");

function runInstall(existingCaches) {
  // existingCaches: { name: { asset: Antwort } }; liefert Netzabrufe und die Inhalte des Vendor-Caches.
  const store = new Map(Object.entries(existingCaches).map(([name, files]) => [name, new Map(Object.entries(files))]));
  const fetched = [];
  const open = async name => {
    if (!store.has(name)) store.set(name, new Map());
    const files = store.get(name);
    return {
      match: async key => files.get(String(key.url || key)),
      put: async (key, res) => { files.set(String(key.url || key), res); },
      add: async req => { fetched.push(req.url || String(req)); files.set(req.url || String(req), { body: "neu", clone() { return this; } }); },
      addAll: async reqs => { for (const r of reqs) files.set(r.url || String(r), { body: "neu", clone() { return this; } }); },
    };
  };
  const listeners = {};
  const sandbox = {
    self: { addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting: async () => {}, location: { href: "https://x.test/sw.js" }, clients: {} },
    caches: { open, keys: async () => [...store.keys()], match: async () => { throw new Error("globales caches.match darf nicht genutzt werden"); }, delete: async () => true },
    Request: class { constructor(url) { this.url = url; } },
    URL,
  };
  vm.runInNewContext(swSource, sandbox);
  let done;
  listeners.install({ waitUntil: p => { done = p; } });
  return done.then(() => ({ store, fetched }));
}

test("Vendor-Migration kopiert nur aus dem früheren Shell-Cache", async () => {
  const old = { body: "alt-shell", clone() { return this; } };
  const { store, fetched } = await runInstall({ "flc-v20-shell": { "vendor/sql.js/sql-wasm.js": old } });
  assert.equal(store.get("flc-vendor-v1").get("vendor/sql.js/sql-wasm.js"), old, "aus altem Shell-Cache kopiert");
  assert.ok(!fetched.includes("vendor/sql.js/sql-wasm.js"));
  assert.ok(fetched.includes("vendor/tesseract/lang/deu.traineddata.gz"), "nicht vorhandene Dateien werden geladen");
});

test("Vendor-Versionswechsel lädt neu, statt den alten Vendor-Cache zu kopieren", async () => {
  const old = { body: "alt-vendor", clone() { return this; } };
  const { store, fetched } = await runInstall({ "flc-vendor-v0": { "vendor/sql.js/sql-wasm.js": old } });
  const copied = store.get("flc-vendor-v1").get("vendor/sql.js/sql-wasm.js");
  assert.notEqual(copied, old);
  assert.ok(fetched.includes("vendor/sql.js/sql-wasm.js"));
});

function loadPwaUpdate({ fetchImpl, update }) {
  const timers = [];
  const sandbox = {
    navigator: {
      serviceWorker: {
        controller: null,
        addEventListener() {},
        register: async () => ({ update }),
      },
    },
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { reload() {} },
    fetch: fetchImpl,
    AbortController,
    MessageChannel,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    Date, Promise, Object, JSON, Number, String, Set, Error,
  };
  vm.runInNewContext(`${fs.readFileSync(path.join(WEBAPP, "js", "pwa-update.js"), "utf8")}\nthis.PwaUpdate = PwaUpdate;`, sandbox);
  return { PwaUpdate: sandbox.PwaUpdate, timers };
}

test("Worker-Update startet auch bei hängendem Abruf von version.json, der Abruf ist begrenzt", async () => {
  let updates = 0;
  let aborted = false;
  const { PwaUpdate: P, timers } = loadPwaUpdate({
    update: async () => { updates += 1; },
    fetchImpl: (url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("abort")); });
    }),
  });
  P.start();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(updates, 1, "registration.update() ohne Warten auf version.json");
  const limit = timers.find(t => t.ms === P.FETCH_TIMEOUT_MS);
  assert.ok(limit, "Zeitlimit für den Abruf gesetzt");
  limit.fn();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.ok(aborted);
  assert.equal(P.info().result, "offline", "nach dem Abbruch ist die Prüfung beendet");
});
