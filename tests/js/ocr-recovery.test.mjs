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
  assert.ok(crops.every(r => (r.right - r.x) * r.scale * (r.bottom - r.y) * r.scale <= 12e6 * 1.01));
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
  assert.match(extra, /^Samenstelling.+\nDE Luzerne, Reiskleie, Leinsaat, Bierhefe/m);
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


test("two multilingual side-by-side columns are assigned separate OCR crops", () => {
  const mixed = "Zusammensetzung: Wiesenheu, Luzerne, Karotte, Bierhefe Composition: alfalfa, carrot\n"
    + "Analytische Bestandteile: Analytical constituents:\n"
    + "Rohprotein 9,70 % Crude protein 9.70 %";
  assert.equal(Ocr.shouldRecoverText(mixed), true);
  const crops = Ocr.recoveryRegions(1560, 900, mixed);
  assert.equal(crops.length, 3);
  assert.ok(crops[0].right < crops[1].right);
  assert.ok(crops[0].x < crops[1].x);
  assert.ok(crops[0].right > crops[1].x, "overlap keeps border letters visible");
  assert.match(Ocr.recoveredEvidence("", "Zusammensetzung: Wiesenheu, Luzerne, Karotte, Bierhefe"), /Zusammensetzung/);
});

test("Fotos in Handygröße: Ausschnitte werden spürbar vergrößert, die Pixelfläche bleibt begrenzt", () => {
  for (const [w, h] of [[4032, 3024], [3024, 4032]]) {
    const crops = Ocr.recoveryRegions(w, h);
    assert.ok(crops.length > 0);
    for (const r of crops) {
      assert.ok(r.scale >= 1.5, `${w}x${h}: Vergrößerung ${r.scale.toFixed(2)}`);
      assert.ok((r.right - r.x) * r.scale * (r.bottom - r.y) * r.scale <= 12e6 * 1.01);
    }
  }
});

test("Zutatenzeile ohne Überschrift im Ausschnitt nutzt die bereits gelesene Überschrift", () => {
  const primary = "Zusammensetzung / Composition / Samenstelling\nFEEDING AD rgewicht";
  const line = "DE Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid";
  const extra = Ocr.recoveredEvidence(primary, line);
  assert.equal(extra, "Zusammensetzung / Composition / Samenstelling\n" + line);
  // Ohne gelesene Überschrift wird nichts erfunden.
  assert.equal(Ocr.recoveredEvidence("FEEDING AD rgewicht", line), "");
});

test("Nachgelesene Analysewerte bleiben dem Abschnitt zugeordnet, auch wenn die Überschrift schon im Haupttext steht", () => {
  const feedTypes = [{ id: "complete_feed", nameDe: "Alleinfuttermittel", keywordsDe: ["Alleinfuttermittel"] }];
  const diet = "Diät-Alleinfuttermittel für ausgewachsene Katzen. Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.\n";
  const primary = diet + "Analytische Bestandteile:\n???";
  const candidate = "Analytische Bestandteile:\nRohprotein 9,70 %\nPhosphor 0,40 %";
  const extra = Ocr.recoveredEvidence(primary, candidate);
  assert.match(extra, /^Analytische Bestandteile:/);
  // So wie readLabelPhoto() den Block anhängt.
  const merged = primary + "\n\n" + extra;
  const field = id => Labeling.check(merged, feedTypes[0], []).ruleResults.find(r => r.rule.id === id);
  assert.equal(field("art18_renal_phosphor").status, "found");
  assert.equal(field("art18_renal_phosphor").matchedText, "Phosphor 0,40 %");
});

test("Nachgelesene Analysewerte behalten ihre Bezugsbasis (Trockenmasse), die 12-%-Rechnung bleibt gesperrt", () => {
  const feedTypes = [{ id: "complete_feed", nameDe: "Alleinfuttermittel", keywordsDe: ["Alleinfuttermittel"] }];
  const diet = "Diät-Alleinfuttermittel für ausgewachsene Katzen. Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.\n";
  const primary = diet + "Analytische Bestandteile: Feuchte 80 %\n???";
  const candidate = "Analytische Bestandteile: Feuchte 80 %\nWerte bezogen auf Trockenmasse\nRohprotein 9,70 %\nPhosphor 0,40 %";
  const extra = Ocr.recoveredEvidence(primary, candidate);
  assert.match(extra, /bezogen auf Trockenmasse/);
  const merged = primary + "\n\n" + extra;
  const field = id => Labeling.check(merged, feedTypes[0], []).ruleResults.find(r => r.rule.id === id);
  assert.equal(field("art18_renal_12pct_phosphorus").status, "unclear");
});

// ── Fütterungstabelle (Pavo WeightLift, Rückseite) ──
const feedingBroken = [
  "FEEDING AD rgewicht / Body weig ko/daOE",
  "tion: örpe",
  "orden. Lichaamsgewicht / Körp / Laarrhorse kg/dag/T39",
  "Pferd iaht ight",
  "; Mageres eigh rweilg",
  "| paagil Untergewicht / /pderwn ht / Severe unde",
].join("\n");
const feedingCrop = [
  "FEEDING ADVICE PAVO WeightLift",
  "Lichaamsgewicht / Körpergewicht / Body weight 300 kg 600 kg",
  "Slank paard / Mageres Pferd / Lean horse 0,5 kg/dag/Tag/day 1,0 kg/dag/Tag/day",
  "Ondergewicht / Untergewicht / Underweight 0,75 kg/dag/Tag/day 1,5 kg/dag/Tag/day",
  "Ernstig ondergewicht / Starkes Untergewicht / Severe underweight 1,2 kg/dag/Tag/day 2,4 kg/dag/Tag/day",
].join("\n");

test("Fütterungstabelle: zerlesene Tabelle löst die Nachlese aus, eine einzelne Empfehlung nicht", () => {
  assert.equal(Ocr.needsFeedingRecovery(feedingBroken), true);
  assert.equal(Ocr.needsFeedingRecovery("Fütterungsempfehlung: 500 g pro Tag"), false);
  assert.equal(Ocr.needsFeedingRecovery(feedingCrop), false, "gelesene Tabelle braucht keine Nachlese");
});

test("Fütterungstabelle: eigener Ausschnitt zuerst, höchstens drei Ausschnitte", () => {
  for (const [w, h] of [[2576, 1450], [1450, 2576]]) {
    const regions = Ocr.recoveryRegions(w, h, feedingBroken);
    assert.ok(regions.length >= 1 && regions.length <= 3);
    assert.ok(regions[0].y > 0.4 * h, `${w}x${h}: erster Ausschnitt liegt im unteren Bildteil`);
  }
});

test("Fütterungstabelle: die deutschen Zeilen mit Mengen werden übernommen", () => {
  assert.deepEqual(Ocr.germanView(feedingCrop).split("\n").slice(1), [
    "Körpergewicht 300 kg 600 kg",
    "Mageres Pferd 0,5 kg/Tag 1,0 kg/Tag",
    "Untergewicht 0,75 kg/Tag 1,5 kg/Tag",
    "Starkes Untergewicht 1,2 kg/Tag 2,4 kg/Tag",
  ]);
  const extra = Ocr.recoveredEvidence(feedingBroken, feedingCrop);
  assert.match(extra, /^FEEDING ADVICE PAVO WeightLift\nKörpergewicht 300 kg 600 kg\nMageres Pferd 0,5 kg\/Tag 1,0 kg\/Tag/);
  assert.match(extra, /Starkes Untergewicht 1,2 kg\/Tag 2,4 kg\/Tag$/);
  // Danach ist die Tabelle gelesen, der Ausschnitt wird nicht erneut übernommen.
  assert.equal(Ocr.recoveredEvidence(feedingBroken + "\n\n" + extra, feedingCrop), "");
  assert.equal(Ocr.needsFeedingRecovery(feedingBroken + "\n\n" + extra), false);
});

test("Fütterungstabelle: ohne gelesene Überschrift oder mit zu wenigen Zeilen wird nichts übernommen", () => {
  const rows = feedingCrop.split("\n").slice(1);
  assert.equal(Ocr.recoveredEvidence("Nur Fragmente", rows.join("\n")), "");
  assert.equal(Ocr.recoveredEvidence(feedingBroken, ["FEEDING ADVICE", rows[1], rows[2]].join("\n")), "");
});

test("Mengen am Zeilenende erhalten das deutsche Teilwort der Einheit, einsprachige Zeilen bleiben", () => {
  assert.equal(Ocr.germanView("Tag / Nacht 0,5 kg/Tag"), "Tag / Nacht 0,5 kg/Tag");
  assert.equal(Ocr.germanView("Futtermenge 0,5 kg/dag/Tag/day"), "Futtermenge 0,5 kg/dag/Tag/day");
});
