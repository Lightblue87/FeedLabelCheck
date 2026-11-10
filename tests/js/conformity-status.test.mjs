import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Labeling = require("../../webapp/js/labeling.js");

const row = (status, severity = "critical") => ({ status, rule: { severity } });

test("ohne überprüfte Pflichtregeln kein positiver Gesamtstatus", () => {
  assert.equal(Labeling.overallStatus([]), "nichtPruefbar");
  assert.equal(Labeling.overallStatus([row("notCheckable")]), "nichtPruefbar");
  assert.equal(Labeling.overallStatus([row("notCheckable", "info")]), "nichtPruefbar");
});

test("offene Pflichtregeln verhindern 'keine Auffälligkeit'", () => {
  for (const state of ["notCheckable", "probablyFound", "unclear", "missing"]) {
    const expected = state === "missing" ? "auffaellig" : "unklar";
    assert.equal(Labeling.overallStatus([row("found"), row(state)]), expected, state);
  }
  assert.equal(Labeling.overallStatus([row("found"), row("notCheckable", "warning")]), "unklar");
});

test("informative Verdünnungskarte beeinflusst Pflichtstatus nicht", () => {
  assert.equal(Labeling.overallStatus([row("found"), row("notCheckable", "info")]), "keineAuffaelligkeit");
  assert.equal(Labeling.overallStatus([row("missing"), row("notCheckable", "info")]), "auffaellig");
});

test("nur nach gefundenen Pflichtangaben ist die Textprüfung unauffällig", () => {
  assert.equal(Labeling.overallStatus([row("found"), row("found", "warning")]), "keineAuffaelligkeit");
});
