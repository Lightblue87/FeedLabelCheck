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
    assert.equal(Labeling.overallStatus([row("found"), row(state)]), "unklar", state);
  }
  assert.equal(Labeling.overallStatus([row("found"), row("notCheckable", "warning")]), "unklar");
});

test("informative Verdünnungskarte beeinflusst Pflichtstatus nicht", () => {
  assert.equal(Labeling.overallStatus([row("found"), row("notCheckable", "info")]), "keineAuffaelligkeit");
  assert.equal(Labeling.overallStatus([row("missing"), row("notCheckable", "info")]), "nichtPruefbar");
});

test("nur nach gefundenen Pflichtangaben ist die Textprüfung unauffällig", () => {
  assert.equal(Labeling.overallStatus([row("found"), row("found", "warning")]), "keineAuffaelligkeit");
});

test("elf OCR-Nichttreffer sind keine elf bestätigten Etikettenverstöße", () => {
  assert.equal(Labeling.overallStatus(Array.from({ length: 11 }, () => row("missing"))), "nichtPruefbar");
});

test("Pavo WeightLift: stark gestörter OCR-Text ohne eindeutige Futtermittelart bleibt offen", () => {
  const text = [
    "NN NdAdN N NN Ns Ns 300 /Ta NS NS N",
    "FEEDING AD rgewicht / Body weig ko/daOE",
    "Pferd iaht ight ; Mageres eigh rweilg",
    "articulierement aux aux cer&ales ou",
    "onstituintes analiticos / Analyticke sloZky",
    "Hruby protein 16,5% Hrubetuk 2 2,8%",
  ].join("\n");
  const rule = {
    id: "art15_001", severity: "critical", patterns: [
      { patternType: "keyword", patternValue: "Ergänzungsfuttermittel", patternLanguage: "de",
        confidenceWeight: 1, isNegativePattern: false },
    ],
  };
  const result = Labeling.check(text, { id: "complementary_feed" }, [rule]);
  assert.equal(result.ruleResults[0].status, "missing");
  assert.equal(result.overallStatus, "nichtPruefbar");
  assert.match(result.ruleResults[0].note, /kein Nachweis eines Etikettenfehlers/);
});
