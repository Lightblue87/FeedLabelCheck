// Groß gedruckte Packungsmenge: Auswahl des Kandidaten aus mehreren Lesedurchgängen. Alle Eingaben sind konstruiert.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ocr = require("../../webapp/js/ocr.js");
const Labeling = require("../../webapp/js/labeling.js");

const line = (text, height, confidence = 90, x = 100) => ({ text, height, confidence, bbox: { x0: x, y0: 100, x1: x + 200, y1: 100 + height } });
const BODY = 20;

test("largeAmountCandidate: Menge in großer Schrift, in zwei Durchgängen gleich gelesen", () => {
  const candidate = Labeling.largeAmountCandidate("Ergänzungsfuttermittel für Pferde", [[line("5kg", 66, 40)], [line("5 kg", 68, 55)]], BODY);
  assert.equal(candidate.amount, "5 kg");
  assert.equal(candidate.confirmed, true);
  assert.equal(Labeling.largeAmountHint("5 kg"), "OCR-Kandidat Packungsmenge: 5 kg");
});

test("largeAmountCandidate: ein einzelner Durchgang genügt nur bei sicherer Lesung", () => {
  assert.equal(Labeling.largeAmountCandidate("", [[line("3kg", 64, 91)]], BODY).confirmed, true);
  assert.equal(Labeling.largeAmountCandidate("", [[line("100g", 83, 0)]], BODY).confirmed, false);
  // Dieselbe Menge zweimal im selben Durchgang zählt als ein Durchgang.
  assert.equal(Labeling.largeAmountCandidate("", [[line("100g", 83, 10), line("100 g", 80, 20)]], BODY).confirmed, false);
});

test("largeAmountCandidate: verlesenes ℮-Zeichen vor oder hinter der Menge", () => {
  for (const text of ["℮ 100 g", "e100g", "„C100g", "€ 200g", "500g@©", "500g℮"]) {
    assert.ok(Labeling.largeAmountCandidate("", [[line(text, 60)]], BODY), text);
  }
});

test("largeAmountCandidate: kein Kandidat aus Fließtextgröße, Fremdtext oder bereits gelesenen Mengen", () => {
  // Gleiche Größe wie der Fließtext (Fütterungstabelle)
  assert.equal(Labeling.largeAmountCandidate("", [[line("3kg", 26), line("200g", 25)]], BODY), null);
  // Zeile enthält mehr als die Menge
  assert.equal(Labeling.largeAmountCandidate("", [[line("ca. 3kg Katze", 60), line("1009|", 60), line("Rind Vital", 60)]], BODY), null);
  // Die Menge steht schon im Prüftext (Rationsangabe): keine neue Information
  assert.equal(Labeling.largeAmountCandidate("Pferd 600 kg Körpergewicht: 2,4 kg/Tag", [[line("600 kg", 50)], [line("600kg", 50)]], BODY), null);
  assert.equal(Labeling.largeAmountCandidate("", [[line("0 g", 60)]], BODY), null);
  assert.equal(Labeling.largeAmountCandidate("", [], BODY), null);
});

test("largeAmountCandidate: mehrere große Mengen nur, wenn eine klar die größte ist", () => {
  const ambiguous = Labeling.largeAmountCandidate("", [[line("3kg", 60), line("200g", 58, 90, 400)], [line("3kg", 60), line("200g", 58, 90, 400)]], BODY);
  assert.equal(ambiguous, null);
  const clear = Labeling.largeAmountCandidate("", [[line("3kg", 34), line("100g", 83, 90, 400)], [line("100 g", 82, 90, 400)]], BODY);
  assert.equal(clear.amount, "100 g");
  assert.equal(clear.confirmed, true);
});

test("largeAmountCandidate: zwei Lesarten an derselben Stelle – die häufigere zählt, bei Gleichstand keine", () => {
  // „g“ zusätzlich als „9“ gelesen: „5009 g“ statt „500 g“
  const majority = Labeling.largeAmountCandidate("", [[line("500g@", 56, 30)], [line("500g©", 55, 40)], [line("5009g@", 44, 58)]], BODY);
  assert.equal(majority.amount, "500 g");
  assert.equal(majority.confirmed, true);
  assert.equal(Labeling.largeAmountCandidate("", [[line("500g", 56)], [line("5009g", 56)]], BODY), null);
});

test("lacksNetAmount: nur ohne Mengenangabe und ohne vorhandenen Hinweis", () => {
  assert.equal(Labeling.lacksNetAmount("Alleinfuttermittel für Katzen\nZusammensetzung: Fleisch"), true);
  assert.equal(Labeling.lacksNetAmount("Alleinfuttermittel\nNettomasse: 400 g"), false);
  // Eine allein stehende Menge ist nur ein Hinweis und ersetzt die Prüfung an der Überschrift nicht.
  assert.equal(Labeling.lacksNetAmount("Alleinfuttermittel\n5 kg"), true);
  assert.equal(Labeling.lacksNetAmount("Alleinfuttermittel\nOCR-Kandidat Packungsmenge: 5 kg"), false);
});

test("Nettomenge: der Hinweis aus der Zusatzprüfung bleibt „Wahrscheinlich“", () => {
  const rule = { id: "art15_003", severity: "critical", patterns: [{ patternValue: "Nettomasse", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.8 }] };
  const feedType = { id: "complementary_feed", nameDe: "Ergänzungsfuttermittel" };
  const result = Labeling.check("Ergänzungsfuttermittel für Pferde\nZusammensetzung: Wiesengräser, Leinkuchen\nOCR-Kandidat Packungsmenge: 5 kg", feedType, [rule]).ruleResults[0];
  assert.equal(result.status, "probablyFound");
  assert.match(result.matchedText, /5 kg/);
});

test("lineSummaries und bodyHeight", () => {
  const word = (text, x0, y0, x1, y1, confidence = 90) => ({ text, confidence, bbox: { x0, y0, x1, y1 } });
  const lines = [[word("5kg", 100, 200, 160, 233, 80)], [word("Hersteller:", 10, 10, 60, 20), word("Beispiel", 70, 10, 110, 21, 70)]];
  const summaries = Ocr.lineSummaries(lines, 0.5);
  assert.deepEqual(summaries[0], { text: "5kg", height: 66, confidence: 80, bbox: { x0: 200, y0: 400, x1: 320, y1: 466 } });
  assert.equal(summaries[1].text, "Hersteller: Beispiel");
  assert.equal(summaries[1].confidence, 70);
  assert.equal(Ocr.bodyHeight(lines), 11);
  assert.equal(Ocr.bodyHeight([]), 0);
});
