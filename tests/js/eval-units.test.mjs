/*
 * Unit-Tests für die Einheiten-Behandlung der Grenzwertprüfung
 * (webapp/js/eval.js: convertToLimitUnit, unitOptions, evaluateSingleValue).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LavesEval = require("../../webapp/js/eval.js");

const rec = (over = {}) => ({
  e_number: "3b603", substance: "Test", species: "Alle Tierarten",
  unit: "mg/kg", unitAssumed: false, min_value: null, max_value: 10,
  notes: null, source_ref: null, status: null, ...over,
});

test("gleiche Einheit: unverändert bewertet", () => {
  const ok = LavesEval.evaluateSingleValue(10, rec(), "mg/kg");
  assert.equal(ok.ok, true);
  const bad = LavesEval.evaluateSingleValue(10.5, rec(), "mg/kg");
  assert.equal(bad.ok, false);
});

test("10 g/kg gegen Höchstwert 10 mg/kg ist NICHT konform", () => {
  const res = LavesEval.evaluateSingleValue(10, rec(), "g/kg");
  assert.equal(res.ok, false);
  assert.ok(res.msgs[0].startsWith("Oberhalb des hinterlegten Höchstwerts"), "Urteil steht an erster Stelle");
  assert.ok(res.msgs.some(m => m.startsWith("Umrechnung: 10 g/kg = 10.000 mg/kg")));
});

test("0,01 g/kg entspricht 10 mg/kg und ist konform", () => {
  const res = LavesEval.evaluateSingleValue(0.01, rec(), "g/kg");
  assert.equal(res.ok, true);
});

test("µg/kg, ppm und % werden korrekt umgerechnet", () => {
  assert.equal(LavesEval.convertToLimitUnit(5000, "µg/kg", "mg/kg").value, 5);
  assert.equal(LavesEval.convertToLimitUnit(5000, "μg/kg", "mg/kg").value, 5); // griechisches mu
  assert.equal(LavesEval.convertToLimitUnit(7, "ppm", "mg/kg").value, 7);
  assert.equal(LavesEval.convertToLimitUnit(0.001, "%", "mg/kg").value, 10);
  assert.equal(LavesEval.convertToLimitUnit(2, "mg/kg", "g/kg").value, 0.002);
});

test("Einheiten werden normalisiert (Leerzeichen, Groß-/Kleinschreibung)", () => {
  assert.equal(LavesEval.normalizeUnit(" MG / KG "), "mg/kg");
  assert.equal(LavesEval.convertToLimitUnit(3, "MG/KG", "mg/kg").converted, false);
});

test("Masse und Nicht-Masse-Einheit: keine Bewertung", () => {
  const res = LavesEval.evaluateSingleValue(1, rec(), "KBE/kg");
  assert.equal(res.ok, null);
  assert.ok(res.msgs[0].includes("nicht vergleichbar"));
});

test("Nicht-Masse-Einheiten sind nur bei identischer Einheit vergleichbar", () => {
  const r = rec({ unit: "FTU/kg", max_value: 200 });
  assert.equal(LavesEval.evaluateSingleValue(150, r, "FTU/kg").ok, true);
  assert.equal(LavesEval.evaluateSingleValue(250, r, "FTU/kg").ok, false);
  assert.equal(LavesEval.evaluateSingleValue(150, r, "mg/kg").ok, null);
  assert.equal(LavesEval.evaluateSingleValue(150, rec({ unit: "FTU/kg", max_value: 200 }), "KBE/kg").ok, null);
});

test("fehlende Laborwert-Einheit blockiert die Bewertung", () => {
  const res = LavesEval.evaluateSingleValue(5, rec(), "");
  assert.equal(res.ok, null);
});

test("ohne Einheitenangabe bleibt das bisherige Verhalten (Einheit des Grenzwerts)", () => {
  assert.equal(LavesEval.evaluateSingleValue(5, rec()).ok, true);
  assert.equal(LavesEval.evaluateSingleValue(50, rec()).ok, false);
});

test("angenommene Datensatz-Einheit blockiert Grenzwerturteil", () => {
  const [a] = LavesEval.loadAdditives([
    { kennnummer: "3b603", name: "Test", max_mg_kg: "10" },
  ]);
  assert.equal(a.unit, "mg/kg");
  assert.equal(a.unitAssumed, true);
  const res = LavesEval.evaluateSingleValue(5, a, "mg/kg");
  assert.equal(res.ok, null);
  assert.ok(res.msgs[0].includes("nicht belegt"));

  const [b] = LavesEval.loadAdditives([
    { kennnummer: "3b603", name: "Test", max_mg_kg: "10", einheit: "mg/kg" },
  ]);
  assert.equal(b.unitAssumed, false);
});

test("Datensatz ohne Einheit und ohne Grenzwert bleibt nicht bewertbar", () => {
  const res = LavesEval.evaluateSingleValue(5, rec({ unit: null }), "mg/kg");
  assert.equal(res.ok, null);
});

test("unitOptions: Masseeinheiten zuerst, Datenwerte ohne Duplikate", () => {
  const opts = LavesEval.unitOptions(["mg/kg", "KBE/kg", "FTU/kg", "MG/KG"]);
  assert.deepEqual(opts.slice(0, 4), ["mg/kg", "g/kg", "µg/kg", "%"]);
  assert.deepEqual(opts.slice(4), ["KBE/kg", "FTU/kg"]);
});

test("Umrechnung bei nur angenommener Datensatz-Einheit ist nicht bewertbar", () => {
  const [a] = LavesEval.loadAdditives([
    { kennnummer: "4b1823i", name: "Test", min_mg_kg: "1" },
  ]);
  assert.equal(a.unitAssumed, true);
  const res = LavesEval.evaluateSingleValue(0.001, a, "g/kg");
  assert.equal(res.ok, null);
  assert.ok(res.msgs[0].includes("nicht belegt"));
  // Eine gleich benannte Eingabeeinheit macht die Datenquelle nicht verlässlich.
  assert.equal(LavesEval.evaluateSingleValue(2, a, "mg/kg").ok, null);
});

test("Werte exakt auf dem Grenzwert sind nach Umrechnung nicht durch Rundung nicht konform", () => {
  assert.equal(LavesEval.convertToLimitUnit(0.0012, "%", "mg/kg").value, 12);
  const minRec = rec({ min_value: 12, max_value: null });
  assert.equal(LavesEval.evaluateSingleValue(0.0012, minRec, "%").ok, true);
  assert.equal(LavesEval.evaluateSingleValue(0.00119, minRec, "%").ok, false);
  const maxRec = rec({ max_value: 10 });
  assert.equal(LavesEval.evaluateSingleValue(0.001, maxRec, "%").ok, true);
  assert.equal(LavesEval.evaluateSingleValue(0.01, maxRec, "g/kg").ok, true);
  assert.equal(LavesEval.evaluateSingleValue(0.0101, maxRec, "g/kg").ok, false);
  assert.equal(LavesEval.evaluateSingleValue(10, maxRec, "µg/kg").ok, true);
});
