/*
 * Unit-Tests für die Filterlogik des Autocomplete-Dropdowns
 * (webapp/js/autocomplete.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Autocomplete = require("../../webapp/js/autocomplete.js");

const OPTIONS = ["3b605", "3b606", "3a672a", "E 672", "Zinkoxid",
                 "Zinksulfat, Monohydrat", "Kupfer(II)-oxid", "Natriumselenit"];

test("leere Eingabe liefert die ersten Optionen", () => {
  const out = Autocomplete.filterOptions(OPTIONS, "");
  assert.deepEqual(out, OPTIONS.slice(0, Autocomplete.MAX_ITEMS));
});

test("Treffer am Anfang kommen vor Teilstring-Treffern", () => {
  const out = Autocomplete.filterOptions(OPTIONS, "zink");
  assert.deepEqual(out, ["Zinkoxid", "Zinksulfat, Monohydrat"]);
});

test("Teilstring-Treffer werden gefunden (Groß-/Kleinschreibung egal)", () => {
  const out = Autocomplete.filterOptions(OPTIONS, "OXID");
  assert.deepEqual(out, ["Zinkoxid", "Kupfer(II)-oxid"]);
});

test("Kennnummern filtern nach Präfix", () => {
  const out = Autocomplete.filterOptions(OPTIONS, "3b60");
  assert.deepEqual(out, ["3b605", "3b606"]);
});

test("Ergebnis ist auf max begrenzt", () => {
  const many = Array.from({ length: 100 }, (_, i) => `3b${600 + i}`);
  assert.equal(Autocomplete.filterOptions(many, "3b", 40).length, 40);
  assert.equal(Autocomplete.filterOptions(many, "", 40).length, 40);
});

test("keine Treffer ergibt leere Liste", () => {
  assert.deepEqual(Autocomplete.filterOptions(OPTIONS, "xyz123"), []);
});
