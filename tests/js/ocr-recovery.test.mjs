import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ocr = require("../../webapp/js/ocr.js");
const Labeling = require("../../webapp/js/labeling.js");

const pavoBroken = [
  "NN NdAdN N NN Ns Ns 300 /Ta",
  "FEEDING AD rgewicht / Body weig ko/daOE",
  "Pferd iaht ight ; Mageres eigh rweilg",
  "onstituintes analiticos / Analyticke sloZky",
].join("\n");

// Extracted from the actual user's image using a 2x focused crop. No
// assumptions from a known product catalogue enter the OCR result.
const pavoComposition = [
  "Samenstelling / Komposition / Composition / Sammensatning / Composition / Composicion",
  "NL Luzerne, Rijstevoermeel, Lijnzaad, Biergist, Monocalciumfosfaat, Magnesiumoxide",
  "DE Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid",
  "EN Alfalfa, Rice bran, Linseed, Brewer's yeast, Monocalcium phosphate, Magnesium oxide",
].join("\n");

test("dense landscape photo: bounded overlapping high-resolution crops", () => {
  const crops = Ocr.recoveryRegions(1536, 864);
  assert.equal(crops.length, 2);
  assert.deepEqual(crops[0], { x: 115, y: 95, right: 1429, bottom: 450, scale: 2 });
  assert.ok(crops.every(r => r.right > r.x && r.bottom > r.y));
  assert.ok(crops.every(r => (r.right - r.x) * r.scale <= 2801));
});

test("dense portrait photo: first crop targets the narrow analytical table", () => {
  const crops = Ocr.recoveryRegions(864, 1536);
  assert.equal(crops.length, 3);
  assert.deepEqual(crops[0], { x: 43, y: 384, right: 648, bottom: 1045, scale: 2.5 });
  assert.deepEqual(Ocr.recoveryRegions(0, 100), []);
});

test("damaged original OCR triggers a focused retry, complete sections do not", () => {
  assert.equal(Ocr.shouldRecoverText(pavoBroken), true);
  const full = "Zusammensetzung: Luzerne, Leinsaat, Bierhefe\n"
    + "Analytische Bestandteile: Rohprotein 16,5 %, Rohfett 9,1 %\n"
    + "Fütterungsempfehlung: 500 g pro Tag. ".repeat(12);
  assert.equal(Ocr.shouldRecoverText(full), false);
});

test("Pavo: recovered DE ingredient line is available to the existing composition parser", () => {
  const extra = Ocr.recoveredEvidence(pavoBroken, pavoComposition);
  assert.match(extra, /^Samenstellung.+\nDE Luzerne, Reiskleie, Leinsaat, Bierhefe/m);
  assert.match(Labeling.compositionCropHint(extra), /Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid/);
  assert.equal(Ocr.recoveredEvidence(pavoBroken + "\n" + extra, pavoComposition), "");
});

test("Pavo: true Czech analytical lines survive without invented German translations", () => {
  const candidate = "Constituintes analiticos / Analyticke sloZky\n"
    + "Hruby protein 16,5%\nHruby tuk 9,1%\nHruby popel 10,3%\nFosfor 0,40%\n";
  const extra = Ocr.recoveredEvidence(pavoBroken, candidate);
  assert.match(extra, /Hruby protein 16,5%/);
  assert.match(extra, /Fosfor 0,40%/);
  assert.doesNotMatch(extra, /Rohprotein|Phosphor/);
});

test("German two-column analytical example: rows with matching source heading", () => {
  // Derived layout case: two-column pet feed composition and analytics,
  // reflecting typical producer listings, without importing proprietary labels.
  const candidate = "Analytische Bestandteile:\n"
    + "Rohprotein 9,70 %\nRohfaser 21,60 %\nCalcium 0,58 %\n";
  const extra = Ocr.recoveredEvidence("Nahrung für Kaninchen", candidate);
  assert.match(extra, /Rohprotein 9,70 %/);
  assert.match(extra, /Rohfaser 21,60 %/);
});

test("single-language ingredients are copied only when a sufficiently long original list exists", () => {
  const candidate = "Zusammensetzung: Wiesengräser, Karotte, Hagebutte, Bierhefe\n";
  assert.match(Ocr.recoveredEvidence("", candidate), /Zusammensetzung:/);
  assert.equal(Ocr.recoveredEvidence("", "Zusammensetzung: Zutat"), "");
});

test("generic loose words and conflicting lot or expiry numbers are never auto-added", () => {
  const text = "Luzerne, Reiskleie, Leinsaat\nMHD 01/2031\nChargennummer: 1234";
  assert.equal(Ocr.recoveredEvidence("MHD 01/2029", text), "");
  assert.equal(Ocr.recoveredEvidence("", "DE Luzerne, Reiskleie, Leinsaat"), "");
});
