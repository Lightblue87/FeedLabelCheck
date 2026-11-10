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
