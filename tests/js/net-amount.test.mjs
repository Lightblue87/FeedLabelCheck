// Nettomenge: Fehlerfälle aus dem Prüfbericht vom 11.11.2026 (False Positives) und die Gegenproben, die weiter
// gelten müssen. Eine Menge zählt nur mit Packungsbezug; isolierte Mengen bleiben höchstens ein Hinweis.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ocr = require("../../webapp/js/ocr.js");
const Labeling = require("../../webapp/js/labeling.js");

const RULE = { id: "art15_003", severity: "critical", patterns: [
  { patternValue: "Nettomasse", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.8 },
] };
const FEED_TYPE = { id: "complete_feed", nameDe: "Alleinfuttermittel" };
const HEAD = "Alleinfuttermittel für ausgewachsene Katzen\nZusammensetzung: Fleisch und tierische Nebenerzeugnisse\n";
const card = text => Labeling.check(HEAD + text, FEED_TYPE, [RULE]).ruleResults[0];

test("Nettomenge: eindeutige Angaben mit Packungsbezug bleiben „Gefunden“", () => {
  for (const [text, evidence] of [
    ["Inhalt: 3 kg", /3 kg/], ["Nettomasse: 400 g", /400 g/], ["Netto 25 kg e", /25 kg/], ["Inhalt:\n3 kg", /3 kg/],
    ["e 200 g", /200 g/], ["℮ 200 g", /200 g/], ["e100g", /100g/], ["25 kg ℮", /25 kg/],
    ["Nettomasse: 400 g\nPoids net: 400 g", /400 g/], ["Nettomasse / Poids net: 400 g", /400 g/],
    ["Nettogewicht: 2 x 57 g ℮ = 114 g", /114 g/], ["Inhalt: 10 x 400 g = 4000 g", /4000 g/],
    ["Nettomasse: 400 g Poids net: 400 g", /400 g/], ["Nettomasse: 5 kg. Kühl und trocken lagern.", /5 kg/],
  ]) {
    const result = card(text);
    assert.equal(result.status, "found", text);
    assert.match(result.matchedText, evidence, text);
  }
});

test("Nettomenge: Menge mit Bezug auf Portion, Körpergewicht, Tag oder Stoff ist keine Packungsmenge", () => {
  for (const text of ["Inhalt: 400 g pro Portion", "Inhalt: 100 g je kg Körpergewicht", "Nettomasse: 400 g täglich",
                      "Inhalt: 2 g Calcium", "Inhalt: 250 g pro Tag", "Inhalt: 50 g Rohprotein", "Inhalt: 30 g je Tier",
                      "Inhalt: 400 g\npro Portion"]) {
    assert.equal(Labeling.declaredNetAmount(HEAD + text), null, text);
    // Auch kein Hinweis: Die Zeile zählt für die Nettomenge nicht als Überschrift.
    assert.equal(card(text).status, "missing", `${text} -> ${card(text).matchedText}`);
  }
  // Steht daneben eine echte Angabe, bleibt sie „Gefunden“.
  assert.equal(card("Inhalt: 400 g pro Portion\nNettomasse: 2 kg").status, "found");
  assert.match(card("Inhalt: 400 g pro Portion\nNettomasse: 2 kg").matchedText, /2 kg/);
});

test("Nettomenge: eine eigene Angabe in der Folgezeile entwertet die Packungsmenge nicht", () => {
  for (const text of ["Nettomasse: 400 g\nRohprotein 11 %", "Nettomasse: 400 g\nCalcium: 1 %", "Inhalt: 3 kg\nVitamin A 10.000 IE",
                      "Nettomasse: 400 g\nPortionen pro Tag: 2", "Nettomasse: 400 g\nTaurin 600 mg/kg"]) {
    assert.match(Labeling.declaredNetAmount(HEAD + text) || "", /400 g|3 kg/, text);
    assert.equal(card(text).status, "found", text);
  }
  // Der Bezug selbst in der Folgezeile bleibt ein Bezug.
  for (const text of ["Inhalt: 400 g\npro Portion", "Inhalt: 100 g\nje kg Körpergewicht", "Nettomasse: 400 g\ntäglich"]) {
    assert.equal(Labeling.declaredNetAmount(HEAD + text), null, text);
  }
});

test("Nettomenge: widersprüchliche Angaben bleiben „Unklar“", () => {
  const result = card("Nettomasse: 400 g\nPoids net: 800 g");
  assert.equal(result.status, "unclear");
});

test("Nettomenge: Nullmenge und Bruchstück sind kein Hinweis", () => {
  // Zeilenbruchstück „0g“ aus einem dichten mehrsprachigen Etikett (öffentliche Stichprobe)
  for (const text of ["skal tilpasses\n0g\n@ Täy", "0 g", "0,0 kg"]) {
    const result = card(text);
    assert.equal(result.status, "missing", text);
    assert.equal(result.matchedText || "", "", text);
  }
});

test("Nettomenge: allein stehende Menge in oder neben einer Fütterungstabelle ist kein Hinweis", () => {
  for (const text of [
    "Fütterungsempfehlung:\nGewicht der Katze | Maximale Tagesration\n3 kg\n200 g",
    "Katze 4 kg\n245 g\n5 kg | 280 g",
    "Körpergewicht\n600 kg\nTagesration\n2,4 kg",
    "Dosierung:\n15 g\ntäglich über das Futter geben",
    "Empfohlene Futtermenge pro Tag\n300 g",
    "400 g\npro Portion",
    "3 kg\n4 kg\n5 kg",
  ]) {
    const result = card(text);
    assert.equal(result.status, "missing", `${text} -> ${result.matchedText}`);
  }
});

test("Nettomenge: eine einzelne allein stehende Menge ohne Tabellenbezug bleibt ein zu prüfender Kandidat", () => {
  for (const text of ["5kg", "400 g", "500g", "Kühl und trocken lagern.\n5 kg\n4 039159 011021"]) {
    const result = card(text);
    assert.equal(result.status, "probablyFound", text);
    assert.equal(Labeling.declaredNetAmount(HEAD + text), null, text);
  }
  // Zwei verschiedene allein stehende Mengen: keine wird bevorzugt.
  assert.equal(card("5 kg\nKühl lagern.\nHersteller: Beispiel GmbH\nMusterweg 1\n400 g").status, "missing");
});

test("needsPackageAmount: die Nachlesung an der Überschrift läuft auch, wenn irgendwo eine Menge allein steht", () => {
  assert.equal(Labeling.needsPackageAmount("Nettomasse:\nFütterungsempfehlung\n400 g"), true);
  assert.equal(Labeling.needsPackageAmount("400 g"), false);
  assert.equal(Labeling.needsPackageAmount("Nettomasse: 400 g"), false);
});

// ── Räumliche Zuordnung ──
const box = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
const line = (text, bbox, confidence = 90) => ({ text, bbox, height: bbox.y1 - bbox.y0, confidence });
const HEADING = box(100, 500, 300, 524); // „Nettomasse:“, 24 hoch

test("nearNetHeading: rechts daneben oder direkt darunter, nicht weiter weg", () => {
  assert.equal(Labeling.nearNetHeading(HEADING, box(320, 480, 520, 560)), true, "große Menge rechts in derselben Zeile");
  assert.equal(Labeling.nearNetHeading(HEADING, box(110, 535, 260, 600)), true, "direkt darunter");
  assert.equal(Labeling.nearNetHeading(HEADING, box(900, 500, 1000, 524)), false, "gleiche Zeile, weit rechts");
  assert.equal(Labeling.nearNetHeading(HEADING, box(110, 800, 260, 860)), false, "weit darunter");
  assert.equal(Labeling.nearNetHeading(HEADING, box(110, 300, 260, 360)), false, "darüber");
  assert.equal(Labeling.nearNetHeading(HEADING, box(700, 540, 850, 600)), false, "darunter, aber seitlich versetzt");
  assert.equal(Labeling.nearNetHeading(null, box(320, 480, 520, 560)), false);
});

test("packageAmountHint: ohne räumlichen Bezug zur Überschrift kein Kandidat", () => {
  const primary = "Nettomasse:\nFütterungsempfehlung";
  // Menge irgendwo im zweiten Durchlauf (nur Text, keine Position): kein Kandidat
  assert.equal(Labeling.packageAmountHint(primary, "500 g"), "");
  assert.equal(Labeling.packageAmountHint("Katze 4 kg", "245 g"), "");
  // Mit Position: nur die Menge an der Überschrift zählt.
  const far = line("500 g", box(700, 900, 820, 930));
  const near = line("400 g", box(320, 495, 440, 530));
  assert.equal(Labeling.packageAmountHint(primary, [far], HEADING), "");
  assert.equal(Labeling.packageAmountHint(primary, [far, near], HEADING), "OCR-Kandidat Packungsmenge: 400 g");
  // Mehrfachpackung: die rechnerisch passende Gesamtmenge braucht keine Position (wie bisher).
  assert.equal(Labeling.packageAmountHint("(10 x 1,5 kg)", "15 kg\n52 kg"), "OCR-Kandidat Packungsmenge: 15 kg");
  assert.equal(Labeling.packageAmountHint("(10 x 1,5 kg)", "52 kg"), "");
});

test("largeAmountCandidate: mit Überschrift zählt nur die Menge an der Überschrift", () => {
  const body = 20;
  const amount = line("3kg", box(120, 540, 300, 604), 91);
  const bodyWeight = line("100 kg", box(700, 300, 900, 350), 95); // „je 100 kg Körpergewicht“, groß gelesen, woanders
  const found = Labeling.largeAmountCandidate("", [[amount, bodyWeight]], body, HEADING);
  assert.equal(found.amount, "3 kg");
  assert.equal(found.confirmed, true);
  assert.equal(Labeling.largeAmountCandidate("", [[bodyWeight]], body, HEADING), null);
  // Unsicher und nur einmal gelesen: nicht bestätigt.
  assert.equal(Labeling.largeAmountCandidate("", [[line("3kg", box(120, 540, 300, 604), 30)]], body, HEADING).confirmed, false);
});

// ── Vorhandene Lesungen nutzen ──
const word = (text, x0, y0, x1, y1, confidence = 92) => ({ text, confidence, bbox: { x0, y0, x1, y1 } });
const whole = (source, lines) => ({ x: 0, y: 0, right: 1300, bottom: 1700, scale: 1, col: 0, row: 0, cols: 1, rows: 1, source, lines });
const texts = lines => lines.map(words => words.map(w => w.text).join(" "));

test("mergeTiles: eine sicher gelesene Mengenzeile aus der zweiten Lesung bleibt erhalten", () => {
  const lead = [[word("Kühl,", 100, 100, 160, 120), word("trocken", 170, 100, 250, 120), word("lagern.", 260, 100, 340, 120)]];
  const second = [
    [word("Kühl,", 100, 100, 160, 120), word("trocken", 170, 100, 250, 120), word("lagern.", 260, 100, 340, 120)],
    [word("5kg", 800, 300, 920, 366, 88)],
  ];
  assert.deepEqual(texts(Ocr.mergeTiles([whole("block", lead), whole("auto", second)])), ["Kühl, trocken lagern.", "5kg"]);
  // Unsicher gelesen oder kein Mengenwort: wie bisher verworfen.
  for (const single of [word("5kg", 800, 300, 920, 366, 60), word("Green", 800, 300, 920, 366, 95), word("0g", 800, 300, 860, 330, 95)]) {
    assert.deepEqual(texts(Ocr.mergeTiles([whole("block", lead), whole("auto", [lead[0].map(w => ({ ...w })), [single]])])),
      ["Kühl, trocken lagern."], single.text);
  }
});

test("largeAmountCandidate: groß gedruckte Menge aus der vorhandenen Lesung als Kandidat", () => {
  const lines = [
    [word("Kühl,", 100, 100, 160, 120), word("trocken", 170, 100, 250, 120), word("lagern.", 260, 100, 340, 120)],
    [word("5kg", 800, 300, 920, 366, 88)],
  ];
  const summaries = Ocr.lineSummaries(lines);
  const candidate = Labeling.largeAmountCandidate("Kühl, trocken lagern.", [summaries], Ocr.bodyHeight(lines));
  assert.equal(candidate.amount, "5 kg");
  assert.equal(candidate.confirmed, true);
  // In Fließtextgröße ist dieselbe Zeile kein Kandidat aus der Schriftgröße.
  const small = [lines[0], [word("5kg", 800, 300, 850, 322, 88)]];
  assert.equal(Labeling.largeAmountCandidate("Kühl, trocken lagern.", [Ocr.lineSummaries(small)], Ocr.bodyHeight(small)), null);
});

test("readingAmountHint: Kandidat aus der vorhandenen Lesung nur mit Überschrift oder großer Schrift ohne Tabellenbezug", () => {
  const bodyLine = y => [word("Kühl,", 100, y, 160, y + 20), word("trocken", 170, y, 250, y + 20), word("lagern.", 260, y, 340, y + 20)];
  // Groß gedruckt, allein, kein Fütterungsbezug im Text
  const big = [bodyLine(100), bodyLine(130), [word("5kg", 800, 300, 920, 366, 88)]];
  assert.equal(Labeling.readingAmountHint("Kühl, trocken lagern.\nKühl, trocken lagern.\n5kg", Ocr.lineSummaries(big), Ocr.bodyHeight(big)),
    "OCR-Kandidat Packungsmenge: 5 kg");
  // Dieselbe Zeile unter einer Fütterungsangabe: kein Kandidat
  assert.equal(Labeling.readingAmountHint("Tagesration je 100 kg Körpergewicht\n5kg", Ocr.lineSummaries(big), Ocr.bodyHeight(big)), "");
  // Unsicher gelesen: kein Kandidat
  const unsure = [bodyLine(100), bodyLine(130), [word("5kg", 800, 300, 920, 366, 55)]];
  assert.equal(Labeling.readingAmountHint("Kühl, trocken lagern.\n5kg", Ocr.lineSummaries(unsure), Ocr.bodyHeight(unsure)), "");
  // An der Überschrift genügt etwas größere Schrift; die Menge darf im Text unter einer Tabellenzeile stehen.
  const atHeading = [bodyLine(100), bodyLine(130), [word("400g", 320, 498, 420, 526, 90)]];
  assert.equal(Labeling.readingAmountHint("Nettomasse:\nca. 2 Stück\n400g", Ocr.lineSummaries(atHeading), Ocr.bodyHeight(atHeading), HEADING),
    "OCR-Kandidat Packungsmenge: 400 g");
  // Menge groß gedruckt, steht aber schon im Fließtext als Rationsangabe
  assert.equal(Labeling.readingAmountHint("Pferd 600 kg: 2,4 kg je Tag\nKühl lagern.\n600 kg",
    Ocr.lineSummaries([bodyLine(100), bodyLine(130), [word("600", 800, 300, 900, 360, 90), word("kg", 910, 300, 960, 360, 90)]]), 20), "");
});

test("Nettomenge: der Kandidat aus der Zusatzprüfung bleibt „Wahrscheinlich“ und wird nie „Gefunden“", () => {
  const result = card("Kühl und trocken lagern.\nOCR-Kandidat Packungsmenge: 5 kg");
  assert.equal(result.status, "probablyFound");
  assert.equal(Labeling.declaredNetAmount(HEAD + "OCR-Kandidat Packungsmenge: 5 kg"), null);
});

test("largeAmountCandidate: Menge einmal gelesen, Einheit an derselben Stelle in einem anderen Durchgang sicher", () => {
  const body = 20;
  const place = box(120, 540, 300, 604);
  const amountOnce = line(") 3kg", place, 30);
  // Derselbe Durchgang, fremde Stelle oder unsichere Einheit stützen nicht.
  assert.equal(Labeling.largeAmountCandidate("", [[amountOnce]], body, HEADING).confirmed, false);
  assert.equal(Labeling.largeAmountCandidate("", [[amountOnce, line("kg", place, 95)]], body, HEADING).confirmed, false);
  assert.equal(Labeling.largeAmountCandidate("", [[amountOnce], [line("kg", box(120, 540, 300, 604), 50)]], body, HEADING).confirmed, false);
  assert.equal(Labeling.largeAmountCandidate("", [[amountOnce], [line("g", place, 95)]], body, HEADING).confirmed, false);
  assert.equal(Labeling.largeAmountCandidate("", [[amountOnce], [line("kg", box(200, 548, 300, 604), 93)]], body, HEADING).confirmed, true);
  assert.equal(Labeling.largeAmountCandidate("", [[amountOnce], [line("kg", box(200, 548, 300, 604), 93)]], body, HEADING).amount, "3 kg");
});
