/*
 * Unit-Tests für webapp/js/ocr.js und die Futtermitteltyp-Erkennung
 * in webapp/js/labeling.js (Node-Testrunner: `node --test tests/js`).
 *
 * Der Beispieltext stammt aus einer echten OCR eines AGROBS-Seniormineral-
 * Etiketts (Ergänzungsfuttermittel für Pferde) mit typischen Fehlern.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ocr = require("../../webapp/js/ocr.js");
const Labeling = require("../../webapp/js/labeling.js");

// Keyword-Listen wie in data/labeling.sqlite (labeling_feed_types)
const FEED_TYPES = [
  { id: "complete_feed", nameDe: "Alleinfuttermittel",
    keywordsDe: ["Alleinfuttermittel", "Allein-Futtermittel", "Alleinfutter", "complete feed"] },
  { id: "complementary_feed", nameDe: "Ergänzungsfuttermittel",
    keywordsDe: ["Ergänzungsfuttermittel", "Ergaenzungsfuttermittel", "Ergänzungsfutter", "complementary feed"] },
  { id: "mineral_feed", nameDe: "Mineralfuttermittel",
    keywordsDe: ["Mineralfuttermittel", "Mineralfutter", "Mineral-Futtermittel"] },
  { id: "single_feed", nameDe: "Einzelfuttermittel", keywordsDe: ["Einzelfuttermittel"] },
];

// ── cleanText ─────────────────────────────────────────────────────

test("cleanText korrigiert als 33xxx gelesene 3a-Zusatzstoffcodes", () => {
  const input = "600 mg Vitamin B1 (33821), 15.000 mcg Biotin (33880), 200 mg Folsäure (33316)";
  const out = Ocr.cleanText(input);
  assert.match(out, /\(3a821\)/);
  assert.match(out, /\(3a880\)/);
  assert.match(out, /\(3a316\)/);
});

test("cleanText korrigiert als 35xxx gelesene 3b-Zusatzstoffcodes", () => {
  const out = Ocr.cleanText("700 mg Mangan als Glycin-Manganchelat-Hydrat (35506)");
  assert.match(out, /\(3b506\)/);
});

test("cleanText lässt korrekt gelesene Codes unverändert", () => {
  const input = "Vitamin A (3a672a), Vitamin B2 (3a825ii), Zink (3b605), L-Lysin (3c322)";
  assert.equal(Ocr.cleanText(input), input);
});

test("cleanText führt Silbentrennung am Zeilenende zusammen", () => {
  const out = Ocr.cleanText("Leinkuchen, Bierhe-\nfe, kohles. Algenkalk");
  assert.match(out, /Bierhefe/);
});

test("cleanText entfernt Symbol-Müllzeilen, behält kurze echte Angaben", () => {
  const out = Ocr.cleanText("; 2 /\n3 kg\n| /\nCharge: 120300");
  assert.equal(out, "3 kg\nCharge: 120300");
});

// ── textFromResult (Konfidenz-Filter) ─────────────────────────────

function fakeResult(lines) {
  // lines: Array von Zeilen, jede Zeile Array aus [wort, konfidenz]
  return {
    text: lines.map(l => l.map(w => w[0]).join(" ")).join("\n"),
    blocks: [{
      paragraphs: [{
        lines: lines.map(words => ({
          words: words.map(([text, confidence]) => ({ text, confidence })),
        })),
      }],
    }],
  };
}

test("textFromResult verwirft Rauschzeilen mit niedriger Konfidenz", () => {
  const data = fakeResult([
    [["AS", 19], ["A", 0], ["NÄRUUEN", 0]],
    [["SE", 7], ["Ergänzungsfuttermittel", 91], ["für", 96], ["Pferde", 96], ["De", 15]],
    [[";", 0], ["2", 0], ["/", 0]],
    [["Zusammensetzung:", 93], ["Wiesengräser", 92], ["und", 93], ["-kräuter", 93]],
  ]);
  assert.equal(Ocr.textFromResult(data),
    "Ergänzungsfuttermittel für Pferde\nZusammensetzung: Wiesengräser und -kräuter");
});

test("textFromResult behält Überschriften mit einem sicheren Wort", () => {
  // "Analytische" leidet unter dem Anführungszeichen (Konfidenz 36),
  // "Bestandteile:" ist sicher – die Zeile darf nicht wegfallen.
  const data = fakeResult([
    [["‘Analytische", 36], ["Bestandteile:", 97], ["AD", 6]],
    [["Fütterungsempfehlung:", 92]],
    [["N", 0]],
  ]);
  assert.equal(Ocr.textFromResult(data),
    "‘Analytische Bestandteile:\nFütterungsempfehlung:");
});

test("textFromResult behält unsicher gelesene Zusatzstoff-Codes zur Korrektur", () => {
  // Fehlgelesene Codes haben oft Konfidenz 0 – sie müssen erhalten bleiben,
  // damit cleanText sie reparieren kann.
  const data = fakeResult([
    [["Biotin", 93], ["(33880),", 0], ["1.000", 96], ["mg", 91], ["Ze", 28]],
  ]);
  assert.equal(Ocr.textFromResult(data), "Biotin (3a880), 1.000 mg");
});

test("textFromResult fällt ohne Blockdaten auf data.text zurück", () => {
  const out = Ocr.textFromResult({ text: "Alleinfuttermittel für Katzen" });
  assert.equal(out, "Alleinfuttermittel für Katzen");
});

// ── Futtermitteltyp-Erkennung ─────────────────────────────────────

const AGROBS_OCR = `AG ROBS° Seniormineral
Ergänzungsfuttermittel für Pferde
Zusammensetzung: Wiesengräser und -kräuter (warmluftgetrocknet), Monocalciumphosphat
Fütterungsempfehlung:
10—15g je 100 kg Körpergewicht und Tag
Dieses Ergänzungsfuttermittel darf wegen der
gegenüber Alleinfuttermittel höheren
Gehalte an Vitaminen und Spurenelementen
nur an Pferde bis zu 1,7 % der Tagesration
(inkl. Heu) verfüttert werden.`;

test("Pflichthinweis 'gegenüber Alleinfuttermittel' kippt die Erkennung nicht", () => {
  const det = Labeling.detectFeedType(AGROBS_OCR, FEED_TYPES);
  assert.ok(det, "Futtermitteltyp muss erkannt werden");
  assert.equal(det.feedType.id, "complementary_feed");
});

test("Echte Alleinfuttermittel werden weiterhin erkannt", () => {
  const det = Labeling.detectFeedType(
    "Miezi Katzenmenü – Alleinfuttermittel für ausgewachsene Katzen. Zusammensetzung: Fleisch",
    FEED_TYPES);
  assert.ok(det);
  assert.equal(det.feedType.id, "complete_feed");
});

test("ASCII-Schreibweise 'gegenueber' wird ebenfalls als Vergleich erkannt", () => {
  const det = Labeling.detectFeedType(
    `Ergaenzungsfuttermittel fuer Pferde
Dieses Ergaenzungsfuttermittel darf wegen der gegenueber Alleinfuttermittel
hoeheren Gehalte an Vitaminen nur begrenzt verfuettert werden.`,
    FEED_TYPES);
  assert.ok(det, "Futtermitteltyp muss erkannt werden");
  assert.equal(det.feedType.id, "complementary_feed");
});

test("Beide Typen als Produktbezeichnung bleiben mehrdeutig", () => {
  const det = Labeling.detectFeedType(
    "Alleinfuttermittel oder Ergänzungsfuttermittel je nach Fütterung", FEED_TYPES);
  assert.equal(det, null);
});

test("cleanText + Erkennung auf komplettem OCR-Rohtext", () => {
  const raw = "AS A NÄRUUEN\n; 2 /\n" + AGROBS_OCR + "\n600 mg Vitamin B1 (33821)";
  const cleaned = Ocr.cleanText(raw);
  assert.match(cleaned, /\(3a821\)/);
  const det = Labeling.detectFeedType(cleaned, FEED_TYPES);
  assert.ok(det);
  assert.equal(det.feedType.id, "complementary_feed");
});
