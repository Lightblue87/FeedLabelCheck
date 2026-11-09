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

const LABEL_EVIDENCE_RULES = [
  ["art17_001_complementary", "Tierart:", 0.7],
  ["art17_003_complementary", "Zusammensetzung", 0.7],
  ["art15_002", "AG ", 1],
  ["art17_002_complementary", "Mindestens haltbar bis", 0.7],
  ["art15_004", "Chargen", 0.7],
].map(([id, patternValue, confidenceWeight]) => ({
  id, severity: "critical",
  patterns: (id === "art15_002" ? [patternValue, " KG", "Platz ", "Weg "] : [patternValue])
    .map(patternValue => ({ patternValue, confidenceWeight, patternLanguage: "de", patternType: "keyword" })),
}));

function checkLabelEvidence(text) {
  return Labeling.check(text, FEED_TYPES[1], LABEL_EVIDENCE_RULES).ruleResults;
}

test("Etikett für Wildvögel erkennt Tierkategorie und Zutaten mit konkretem Beleg", () => {
  const results = checkLabelEvidence(
    "Ergänzungsfuttermittel für alle Wildvögel.\nZusammensetzung: Getreide, Saaten, Nüsse. "
    + "Mindestens haltbar bis/Chargen-Nr.: s.\nAufdruck. Convient toute Vannäg Ayx jncectes. Am Futterplatz achten. Nettomasse 1 kg.",
  );
  assert.equal(results[0].status, "found");
  assert.equal(results[0].matchedText, "für alle Wildvögel");
  assert.equal(results[1].status, "found");
  assert.match(results[1].matchedText, /Getreide, Saaten/);
  assert.equal(results[2].status, "missing");
  for (const result of results.slice(3)) {
    assert.equal(result.status, "probablyFound");
    assert.match(result.note, /Aufdruck separat fotografieren/);
  }
});

test("bloße Überschrift und Werbetext bestätigen keine Zutaten oder Tierkategorie", () => {
  const results = checkLabelEvidence(
    "Ganzjahresfütterung. Heimische Wildvögel besuchen den Futterplatz. "
    + "Zusammensetzung: siehe Rückseite, Zusatzstoffe: keine Angabe.",
  );
  assert.equal(results[0].status, "missing");
  assert.equal(results[1].status, "probablyFound");
});


test("Firmenkürzel und Straßenanschrift bleiben als konkrete Angaben erkennbar", () => {
  for (const address of ["Beispielfirma AG, Berlin", "Beispielbetrieb, Marktplatz 2, Berlin"]) {
    const results = checkLabelEvidence(`Ergänzungsfuttermittel für alle Wildvögel. ${address}`);
    assert.equal(results[2].status, "found");
  }
});

test("PO-Code ist nur ein Hinweis auf die Losnummer und braucht Bestätigung", () => {
  const results = checkLabelEvidence("Ergänzungsfuttermittel für alle Wildvögel. Nettomasse 1 kg. PO 481516");
  const lot = results[4];
  assert.equal(lot.status, "probablyFound");
  assert.equal(lot.matchedText, "PO 481516");
  assert.match(lot.note, /Partie-\/Losnummer ist/);
});

test("vollständig gelesener PO-Code wird auch bei einem Aufdruckverweis angezeigt", () => {
  const results = checkLabelEvidence(
    "Ergänzungsfuttermittel für alle Wildvögel. Mindestens haltbar bis/Chargen-Nr.: s. Aufdruck. PO 481516");
  const lot = results[4];
  assert.equal(lot.status, "probablyFound");
  assert.equal(lot.matchedText, "PO 481516");
  assert.doesNotMatch(lot.note, /Aufdruck separat fotografieren/);
  assert.match(lot.note, /Partie-\/Losnummer ist/);
});

test("ähnliche Zeichenfolgen ohne Ziffer oder als Wortteil gelten nicht als PO-Code", () => {
  for (const noise of ["PO Box", "POSTFACH 12", "Kompost 123", "PO", "po 4711"]) {
    const results = checkLabelEvidence(`Ergänzungsfuttermittel für alle Wildvögel. ${noise}`);
    assert.equal(results[4].status, "missing", noise);
  }
});

function checkNumericLabelRule(id, text, patternValue, patternType = "regex", confidenceWeight = 1) {
  const rule = { id, severity: "critical", patterns: [{
    patternValue, patternType, patternLanguage: "de", confidenceWeight,
  }] };
  return Labeling.check(text, FEED_TYPES[0], [rule]).ruleResults[0];
}

const legacyWeightPattern = String.raw`\b\d+[,.]?\d*\s*(kg|g|t|ml|l)\b`;

test("Nettomenge nutzt die deklarierte Menge statt Bezugs- und Fütterungswerten", () => {
  const ration = "Alleinfuttermittel für Hunde. Energie pro 100 g.\nKörpergewicht 8 kg 20 kg 52 kg";
  assert.equal(checkNumericLabelRule("art15_003", ration, legacyWeightPattern).status, "missing");
  assert.equal(checkNumericLabelRule("art15_003", `${ration}\n800 g`, legacyWeightPattern).status, "probablyFound");
  for (const net of ["Nettomasse: 800 g", "℮800g", "Net weight: 800 g"]) {
    const result = checkNumericLabelRule("art15_003", `${ration}\n${net}`, legacyWeightPattern);
    assert.equal(result.status, "found");
    assert.match(result.matchedText, /800\s*g/);
  }
});

test("zweiter OCR-Lauf liefert nur eindeutige Mengenhinweise und prüft Mehrfachpackungen", () => {
  assert.equal(Labeling.needsPackageAmount("Energie pro 100 g"), false);
  assert.equal(Labeling.needsPackageAmount("Nettomasse: 7 kg"), false);
  assert.equal(Labeling.needsPackageAmount("Inhalt (Nettomasse):"), true);
  assert.equal(Labeling.packageAmountHint("Inhalt (Nettomasse):", "7 kg\n12 kg"), "");
  assert.equal(Labeling.packageAmountHint("(10 x 1,5 kg)", "15 kg\n52 kg"), "OCR-Kandidat Packungsmenge: 15 kg");
  const result = checkNumericLabelRule("art15_003", "Ergänzungsfuttermittel für Pferde (10 x 1,5 kg)\nOCR-Kandidat Packungsmenge: 15 kg", legacyWeightPattern);
  assert.equal(result.status, "probablyFound");
  assert.match(result.matchedText, /15 kg/);
});

test("Feuchtegehalt wird mit dem gelesenen Prozentwert in beiden Leserichtungen belegt", () => {
  for (const pair of ["Feuchtegehalt 77 %", "77 % Feuchtigkeit"]) {
    const result = checkNumericLabelRule("art15_005", `Alleinfuttermittel für ausgewachsene Hunde. ${pair}.`, "Feuchte", "keyword");
    assert.equal(result.status, "found");
    assert.equal(result.matchedText, pair);
  }
});

test("Analytik erkennt Tabellenwerte und verwirft zeilenübergreifende Zufallstreffer", () => {
  const loose = String.raw`\b(?:Moisture|Rohfaser)\s+\d+[,.]?\d*\s*%?\b`;
  const check = text => checkNumericLabelRule("art17_004_complete", `Alleinfuttermittel für Katzen. ${text}`, loose);
  assert.equal(check("Moisture\n3 ACCIAIO CARTA").status, "missing");
  assert.equal(check("20,00 | % | Rohfaser").matchedText, "20,00 | % | Rohfaser");
  assert.equal(check("Rohprotein: 24 %").status, "found");
});

test("Zusammensetzung mit Produktname oder Prozentwerten bleibt als Beleg erkennbar", () => {
  const check = text => checkNumericLabelRule("art17_003_complete", `Alleinfuttermittel für Hunde. ${text}`, "Zusammensetzung", "keyword", 0.7);
  for (const text of ["Zusammensetzung Beispielprodukt:\n28 % Beispielmehl, 20 % Beispielsaat", "Zusammensetzung / Composition: Beispielzutat 25 %"]) {
    assert.equal(check(text).status, "found");
  }
  assert.equal(check("Zusammensetzung: siehe Rückseite. Analytische Bestandteile: Protein 24 %").status, "probablyFound");
});


test("Groß geschriebenes KG bei einer Mengenangabe belegt keinen Betrieb", () => {
  const check = text => checkNumericLabelRule("art15_002", `Ergänzungsfuttermittel für Pferde.\n${text}`, " KG", "keyword");
  assert.equal(check("(10 x 1,5 KG)").status, "missing");
  assert.equal(check("Musterfutter GmbH & Co. KG").status, "found");
  const supplier = check("Musterfutter NV\nBeispielstraat 41\nNL 5823 AC Musterort\n(10 x 1,5 KG)");
  assert.equal(supplier.status, "found");
  assert.match(supplier.matchedText, /Musterfutter NV/);
});

test("die ganze erkannte Zutatenliste erscheint bis zur nächsten Überschrift", () => {
  const firstLine = "Getreide, Saaten, Nüsse, Insekten (Beispielinsekten 2,9 %, Mehlwürmer 1 %, Seidenraupen 1 %),";
  const secondLine = "pflanzliche Nebenerzeugnisse, getrocknete Apfelstücke, Holunderfrüchte, Sonnenblumenöl, pflanzliche Fette, Kurkuma.";
  const text = `Ergänzungsfuttermittel für Wildvögel.\nZusammensetzung: ${firstLine}\n${secondLine} Fütterungsempfehlung: täglich füttern.\n[FR] Composition: céréales, fruits.`;
  const result = checkLabelEvidence(text)[1];
  assert.equal(result.status, "found");
  assert.equal(result.matchedText, `Zusammensetzung: ${firstLine} ${secondLine}`);
});

const legacyLotPattern = String.raw`\b(?:Chargen|Lot)\s+\d+\b`;

test("eine einzelne OCR-Ziffer ist kein bestätigter Chargencode", () => {
  const text = "Ergänzungsfuttermittel für Wildvögel. Mindestens haltbar bis/Chargen 4. Siehe Aufdruck.";
  assert.equal(checkNumericLabelRule("art15_004", text, legacyLotPattern).status, "missing");
  const result = checkLabelEvidence(`${text}\nPO 157 923`)[4];
  assert.equal(result.status, "probablyFound");
  assert.equal(result.matchedText, "PO 157 923");
});

test("explizite Losnummern behalten Buchstaben, Bindestriche und getrennte Nummerngruppen", () => {
  for (const lot of ["Charge: A2024-09-01", "Chargen-Nr.: BAF 1015 090925", "LOT 123 456 AB", "L 31459"]) {
    const result = checkNumericLabelRule("art15_004", `Ergänzungsfuttermittel für Wildvögel.\n${lot}`, legacyLotPattern);
    assert.equal(result.status, "found", lot);
    assert.equal(result.matchedText, lot);
  }
  const redirect = "Ergänzungsfuttermittel für Wildvögel. Chargen-Nr.: siehe 04 auf der Verpackung.";
  assert.equal(checkNumericLabelRule("art15_004", redirect, legacyLotPattern).status, "missing");
});

test("Zusatz-OCR wird bei einem Aufdruckverweis genutzt und verlangt übereinstimmende PO-Codes", () => {
  assert.equal(Labeling.needsImprintLot("Mindestens haltbar bis/Chargen-Nr.: s. Aufdruck."), true);
  assert.equal(Labeling.needsImprintLot("Mindestens haltbar bis/Chargen-Nr.: s. Aufdruck.\nPO 157923"), false);
  assert.equal(Labeling.needsImprintLot("Ergänzungsfuttermittel für Wildvögel."), false);
  assert.equal(Labeling.matchingImprintLot("A PO 157923", "PO 157923"), "PO 157923");
  assert.equal(Labeling.matchingImprintLot("PO 157923", "PO 157924"), null);
  assert.equal(Labeling.matchingImprintLot("PO 157923\nPO 157924", "PO 157923"), null);
});

// ── Laufzeit: pathologische Texte dürfen die Oberfläche nicht einfrieren ──
function timed(fn) { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; }

test("viele Zusammensetzungs-Überschriften brauchen keine quadratische Laufzeit", () => {
  const text = "Ergänzungsfuttermittel für Wildvögel.\n" + "Zusammensetzung: a\n".repeat(10000);
  assert.ok(timed(() => checkLabelEvidence(text)) < 1500);
});

test("viele KG hinter Zahlen brauchen keine quadratische Laufzeit und bleiben ohne Betrieb-Beleg", () => {
  const text = "Ergänzungsfuttermittel für Pferde.\n" + "1 KG ".repeat(20000);
  let result;
  assert.ok(timed(() => { result = checkNumericLabelRule("art15_002", text, " KG", "keyword"); }) < 1500);
  assert.equal(result.status, "missing");
});

test("KG nach Zahl mit Leerzeichen/Tab wird weiter als Menge, davor als Rechtsform erkannt", () => {
  const check = text => checkNumericLabelRule("art15_002", `Ergänzungsfuttermittel für Pferde.\n${text}`, " KG", "keyword");
  assert.equal(check("(10 x 1,5 \tKG)").status, "missing");
  assert.equal(check("Beispiel GmbH & Co. KG").status, "found");
  assert.equal(check("1,5 KG und danach Beispiel GmbH & Co. KG").status, "found");
});

test("bisher erkannte Losnummer-Schreibweisen bleiben erkennbar (Bindestrich, Zeilenumbruch, L hinter Datum)", () => {
  for (const [lot, expected] of [
    ["MHD 20.12.2026 L 123456", /L 123456/],
    ["MHD 12/2027 L AB123456", /L AB123456/],
    ["Charge - A12345", /Charge - A12345/],
    ["Charge – A12345", /Charge – A12345/],
    ["Charge\nA12345", /Charge\s+A12345/],
    ["Los-Nr.\n20240915", /20240915/],
  ]) {
    const result = checkNumericLabelRule("art15_004", `Ergänzungsfuttermittel für Pferde.\n${lot}`, legacyLotPattern);
    assert.equal(result.status, "found", JSON.stringify(lot));
    assert.match(result.matchedText, expected, JSON.stringify(lot));
  }
});

test("ein loses L ohne Datum davor und Mengenangaben mit L belegen keine Losnummer", () => {
  for (const noise of ["Inhalt 10 L 50 Stück", "Rezeptur 2 L 4", "20.12.2026 L 5", "Packung 5 L 12 kg"]) {
    const result = checkNumericLabelRule("art15_004", `Ergänzungsfuttermittel für Pferde.\n${noise}`, legacyLotPattern);
    assert.notEqual(result.status, "found", noise);
  }
});

test("ausdrückliche Mengenüberschriften (Inhalt, Nettoinhalt, Füllmenge …) belegen die Nettomenge", () => {
  for (const [declared, amount] of [
    ["Inhalt: 1 Liter", /1 Liter/], ["Inhalt: 800 g", /800 g/], ["Inhalt 5 kg", /5 kg/],
    ["Nettoinhalt: 20 kg", /20 kg/], ["Füllmenge: 500 ml", /500 ml/], ["Packungsinhalt: 3 kg", /3 kg/],
    ["Nettovolumen 2 l", /2 l/], ["Net quantity: 2 kg", /2 kg/], ["Inhalt:\n1 kg", /1 kg/],
  ]) {
    const result = checkNumericLabelRule("art15_003", `Ergänzungsfuttermittel für Pferde.\n${declared}`, legacyWeightPattern);
    assert.equal(result.status, "found", JSON.stringify(declared));
    assert.match(result.matchedText, amount, JSON.stringify(declared));
  }
});

test("mehrdeutige Überschriften und Tabellenwerte belegen weiterhin keine Nettomenge", () => {
  for (const noise of ["Gewicht: 10 kg", "Körpergewicht 8 kg 20 kg 52 kg", "Energie pro 100 g", "Fütterung: 200 g täglich",
                       "Inhaltsstoffe: 5 kg Protein", "Inhalt je Beutel: 85 g"]) {
    const result = checkNumericLabelRule("art15_003", `Alleinfuttermittel für Hunde.\n${noise}`, legacyWeightPattern);
    assert.notEqual(result.status, "found", noise);
  }
});

test("eine ℮-markierte Packungsmenge gilt auch nach anderen Mengenzeilen", () => {
  for (const tail of ["Körpergewicht:\n10 kg\n℮800g", "5 kg\n10 kg\n800 g ℮", "20 kg\ne 1,5 kg"]) {
    const result = checkNumericLabelRule("art15_003", `Alleinfuttermittel für Hunde.\n${tail}`, legacyWeightPattern);
    assert.equal(result.status, "found", JSON.stringify(tail));
    assert.match(result.matchedText, /[℮e]/, JSON.stringify(tail));
    assert.doesNotMatch(result.matchedText, /^(?:5|10|20) kg$/, JSON.stringify(tail));
  }
});

test("Mengenüberschrift ohne Menge löst den Zusatz-OCR-Lauf aus, mit Menge nicht", () => {
  assert.equal(Labeling.needsPackageAmount("Inhalt:"), true);
  assert.equal(Labeling.needsPackageAmount("Inhalt: 5 kg"), false);
  assert.equal(Labeling.needsPackageAmount("Inhaltsstoffe: Protein"), false);
});

test("ein Nachbarfeld nach einer Losnummer-Überschrift ohne Wert wird nicht als Losnummer bestätigt", () => {
  for (const next of ["MHD 20.12.2026", "NETTO 800 g", "EXP 12.12.2027", "Mindestens haltbar bis 12/2027",
                      "Nettomasse 10 kg", "Hersteller: Muster GmbH", "Best before 12/2027"]) {
    for (const head of ["Chargen-Nr.:", "Losnummer:", "Lot:", "Charge:"]) {
      const text = `Ergänzungsfuttermittel für Wildvögel.\n${head}\n${next}`;
      const direct = checkNumericLabelRule("art15_004", text, legacyLotPattern);
      assert.notEqual(direct.status, "found", JSON.stringify(text));
      const withKeyword = checkLabelEvidence(text)[4];
      assert.notEqual(withKeyword.status, "found", JSON.stringify(text));
    }
  }
});

test("echte Codes, die wie ein Feldname beginnen oder ihn enthalten, bleiben Losnummern", () => {
  for (const lot of ["Charge: NET12345", "Lot: EXP20271", "Charge: MHD7788", "Chargen-Nr.: A12345", "Charge:\nA12345"]) {
    const result = checkNumericLabelRule("art15_004", `Ergänzungsfuttermittel für Wildvögel.\n${lot}`, legacyLotPattern);
    assert.equal(result.status, "found", lot);
  }
});

test("eine Zusammensetzungs-Überschrift ohne Zutaten bestätigt keine Zutatenliste aus einem Nachbarfeld", () => {
  const check = text => checkNumericLabelRule("art17_003_complete", `Alleinfuttermittel für Hunde. ${text}`, "Zusammensetzung", "keyword", 0.7);
  for (const text of ["Zusammensetzung:\n\nHersteller: Muster GmbH, Berlin", "Zusammensetzung:\nVertrieb: Futter OHG, Hamburg",
                      "Zusammensetzung:\nNettomasse: 10 kg, Chargen-Nr.: A12345", "Zusammensetzung:\nChargen-Nr.: A12345, MHD: 12/2027",
                      "Zusammensetzung:\nFütterung: 2 % des Körpergewichts täglich.", "Zusammensetzung:\nFütterungsanleitung: 2 % täglich.",
                      "Zusammensetzung:\nFeeding guide: 2 % of body weight daily."]) {
    assert.notEqual(check(text).status, "found", JSON.stringify(text));
  }
  // echte Liste, danach Nachbarfeld: nur die Liste zählt
  const real = check("Zusammensetzung: Getreide, Saaten, Nüsse.\nHersteller: Muster GmbH, Berlin");
  assert.equal(real.status, "found");
  assert.match(real.matchedText, /Getreide, Saaten, Nüsse/);
  assert.doesNotMatch(real.matchedText, /Hersteller|Muster/);
});

const LIVESTOCK_TYPES = [
  ...FEED_TYPES.map(type => type.id === "complete_feed"
    ? { ...type, keywordsDe: [...type.keywordsDe, "complete nutrition", "100% complete nutrition"] }
    : type),
  { id: "milk_replacer", nameDe: "Milchaustauscher", keywordsDe: ["Milchaustauscher", "Tränke"] },
];

test("ausgeschriebener Milchaustauscher für Aufzuchtkälber hat Vorrang vor der allgemeinen Alleinfutter-Angabe", () => {
  const text = "Milchaustauschfuttermittel für Aufzuchtkälber. Analytische Bestandteile: 21,5 % Rohprotein. Alleinfuttermittel darf nur entsprechend der Anleitung verfüttert werden.";
  assert.equal(Labeling.detectFeedType(text, LIVESTOCK_TYPES)?.feedType.id, "milk_replacer");
  for (const [id, expected] of [["art15_001", "Milchaustauschfuttermittel"], ["art17_001_milk", "für Aufzuchtkälber"]]) {
    const evidence = checkNumericLabelRule(id, text, "unpassender Mustertext", "keyword");
    assert.equal(evidence.status, "found");
    assert.equal(evidence.matchedText, expected);
  }
});

test("Werbetext und Tränke-Hinweise belegen allein keine Futtermittelart", () => {
  for (const text of ["Convenient, complete nutrition for newborn calves.", "Mit Wasser mischen und als alleinige Tränke verfüttern."]) {
    assert.equal(Labeling.detectFeedType(text, LIVESTOCK_TYPES), null);
  }
});

test("OCR-Variante der Ergänzungsfutter-Deklaration und verstümmelter Vergleich", () => {
  assert.equal(Labeling.detectFeedType("ERGÄNZUNGFUTTERMITTEL FÜR PFERDE", LIVESTOCK_TYPES)?.feedType.id, "complementary_feed");
  const text = "Dieses Ergänzungsfuttermittel darf wegen der … Alleinfuttermittel höheren, Gehaltes an Zusatzstoffen nur begrenzt als Tränke verfüttert werden.";
  assert.equal(Labeling.detectFeedType(text, LIVESTOCK_TYPES)?.feedType.id, "complementary_feed");
});

test("Zusammensetzung mit Schrägstrichen endet vor dem Hersteller und Legehennen haben einen eigenen Beleg", () => {
  const text = "Ergänzungsfuttermittel für Legehennen.\nZusammensetzung:\nGetreide / Mais / Erbsen /\nSonnenblumenöl / Hafer.\nMusterfutter GmbH & Co. KG\nBeispielstraße 5\nHinweise: kühl lagern.";
  const comp = checkNumericLabelRule("art17_003_complementary", text, "Zusammensetzung", "keyword", 0.7);
  assert.equal(comp.status, "found");
  assert.equal(comp.matchedText, "Zusammensetzung: Getreide / Mais / Erbsen / Sonnenblumenöl / Hafer.");
  const species = checkNumericLabelRule("art17_001_complementary", text, "Tierart:", "keyword", 0.7);
  assert.equal(species.matchedText, "für Legehennen");
});

test("mit Semikolon getrennte Zutaten enden vor den Inhaltsstoffen, Einsatzhinweise vor der Fütterungsanleitung", () => {
  for (const next of ["Inhaltsstoffe: 6,1 % Rohprotein", "Einsatzempfehlung: 50 g pro Liter Wasser", "Hinweise: kühl lagern"]) {
    const text = `Ergänzungsfuttermittel für Kälber.\nZusammensetzung: Traubenzucker; Molkenpulver;\nLaktose.\n${next}`;
    const result = checkNumericLabelRule("art17_003_complementary", text, "Zusammensetzung", "keyword", 0.7);
    assert.equal(result.status, "found");
    assert.equal(result.matchedText, "Zusammensetzung: Traubenzucker; Molkenpulver; Laktose.");
  }
});


test("OCR-Leerzeichen innerhalb einer Futtermittelart bleiben im Beleg sichtbar", () => {
  const text = "Ergänzungsf uttermittel für Legehennen. Zusammensetzung: Getreide / Mais.";
  assert.equal(Labeling.detectFeedType(text, LIVESTOCK_TYPES)?.feedType.id, "complementary_feed");
  assert.equal(checkNumericLabelRule("art15_001", text, "Ergänzungsfuttermittel", "keyword").matchedText, "Ergänzungsf uttermittel");
});

test("englischer Hinweis auf eine spätere Milchfütterung belegt die Futtermittelart nicht", () => {
  const check = text => checkNumericLabelRule("art15_001", text, "milk replacer", "keyword");
  assert.equal(check("Feed the colostrum product first, then begin feeding calf\nmilk replacer at the next feeding.").status, "missing");
  assert.equal(check("Calf milk replacer for calves\nFollow the directions on this label.").status, "found");
});

test("schwacher OCR-Text erlaubt eine Drehung, eine bessere Drehung braucht deutlich mehr sichere Wörter", () => {
  const word = ["Futtermittel", 85];
  const makeResult = (count, confidence) => ({
    ...fakeResult([Array.from({ length: count }, () => word)]), confidence,
  });
  const sideways = makeResult(1, 28);
  assert.equal(Ocr.needsOrientationCheck(sideways), true);
  assert.equal(Ocr.needsOrientationCheck(makeResult(25, 35)), false);
  assert.equal(Ocr.needsOrientationCheck(makeResult(5, 62)), false);
  assert.equal(Ocr.isBetterOrientation(makeResult(13, 45), sideways), true);
  // kurzer Etikettenausschnitt: relative Verbesserung genügt, aber nur mit brauchbarem Text
  assert.equal(Ocr.isBetterOrientation(makeResult(10, 70), makeResult(0, 30)), true);
  assert.equal(Ocr.isBetterOrientation(makeResult(6, 70), makeResult(0, 30)), true);
  assert.equal(Ocr.isBetterOrientation(makeResult(5, 70), makeResult(0, 30)), false);
  assert.equal(Ocr.isBetterOrientation(makeResult(10, 70), makeResult(4, 40)), false);
  assert.equal(Ocr.isBetterOrientation(makeResult(16, 70), makeResult(4, 40)), true);
});

test("eigenständige Zutatenüberschriften funktionieren ohne Doppelpunkt und auf Englisch", () => {
  const check = text => checkNumericLabelRule("art17_003_complementary", text, "Zusammensetzung", "keyword", 0.7);
  const mash = check("Ergänzungsfuttermittel für Pferde\nZusammensetzung\nWiesengräser, Leinkuchen,\nApfeltrester, Leinöl.\nFütterungsempfehlung: 80 g pro 100 kg.");
  assert.equal(mash.status, "found");
  assert.equal(mash.matchedText, "Zusammensetzung Wiesengräser, Leinkuchen, Apfeltrester, Leinöl.");
  const lick = check("Supplementary feed for horses\nINGREDIENTS:\nSugar, glucose syrup, herbal mixture (nettle, thyme).\nCrude protein < 0.5%, crude fiber 0.6%");
  assert.equal(lick.status, "found");
  assert.equal(lick.matchedText, "INGREDIENTS: Sugar, glucose syrup, herbal mixture (nettle, thyme).");
});

test("Mehrfachpackung belegt nur eine ausdrücklich gedruckte und stimmige Gesamtnettomenge", () => {
  const check = text => checkNumericLabelRule("art15_003", text, "Nettogewicht", "keyword", 0.7);
  const text = "Alleinfuttermittel für Katzen.\nNETTOGEWICHT / POIDS NET:\n2 x 57 g ℮ = 114 g";
  assert.equal(check(text).status, "found");
  assert.equal(check(text).matchedText, "114 g");
  assert.notEqual(check(text.replace("114 g", "119 g")).status, "found");
  assert.notEqual(check(text.replace(" = 114 g", "")).status, "found");
  assert.notEqual(check("Fütterung pro Tag: 2 x 57 g = 114 g").status, "found");
  assert.notEqual(check("Nettogewicht\n0,5 kg/Tag").status, "found");
  assert.notEqual(check("Nettogewicht: 2 x 1.000 g = 2 g").status, "found");
});

test("MHD mit Monat und Jahr per Punkt gilt nur mit einem zugehörigen Feldnamen", () => {
  const check = text => checkNumericLabelRule("art17_002_complementary", text, "MHD", "keyword", 0.7);
  assert.equal(check("Ergänzungsfuttermittel für Pferde.\nMHD:08.2028").matchedText, "MHD:08.2028");
  assert.notEqual(check("Ergänzungsfuttermittel für Hunde.\n09.2027 C06A\n12:33").status, "found");
  assert.notEqual(check("Ergänzungsfuttermittel für Pferde.\nMHD: 99.2028").status, "found");
});

test("mehrsprachige Zusammensetzung trennt die deutsche Zutatenzeile von weiteren Sprachen", () => {
  const text = "Ergänzungsfuttermittel für Pferde.\nSamenstelling / Komposition / Composition\nNL Luzerne, Rijstebloem\nDE Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid\nEN Alfalfa, Rice bran, Linseed";
  const result = checkNumericLabelRule("art17_003_complementary", text, "Zusammensetzung", "keyword", 0.7);
  assert.equal(result.status, "found");
  assert.match(result.matchedText, /Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid$/);
  assert.doesNotMatch(result.matchedText, /Rijstebloem|Alfalfa/);
});

test("abweichende Feuchtewerte auf mehrsprachigen Ansichten bleiben unklar", () => {
  const check = text => checkNumericLabelRule("art15_005", text, "Feuchtigkeit", "keyword", 0.7);
  const result = check("Alleinfuttermittel für Katzen. Feuchtigkeit: 63,0%.\nConstituants analytiques: Humidit6; 83,0% Proteine");
  assert.equal(result.status, "unclear");
  assert.match(result.matchedText, /63,0%.*83,0%/);
  assert.equal(check("Alleinfuttermittel für Katzen. Feuchtigkeit: 83,0%.\nHumidité: 83 %").status, "found");
});

test("Mineralfutter ist auch mit polnischer Deklaration erkennbar", () => {
  const text = "BESTERMINE BIOCOMPLEX WRC\nMieszanka paszowa mineralna dla krów mlecznych\nStosowanie 1,00 % w mieszance paszowej pełnoporcjowej";
  assert.equal(Labeling.detectFeedType(text, FEED_TYPES)?.feedType.id, "mineral_feed");
  const result = checkNumericLabelRule("art15_001", text, "Mineralfuttermittel", "keyword", 0.7);
  assert.equal(result.status, "found");
  assert.equal(result.matchedText, "Mieszanka paszowa mineralna");
});

test("Nährwert und Zutaten tragen ohne Adresskontext keinen Firmenbeleg", () => {
  const legacy = String.raw`\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+\b`;
  for (const id of ["art15_002", "art17_005_complete"]) {
    const check = text => checkNumericLabelRule(id, text, legacy);
    assert.equal(check("Zusatzstoffe je kg: Vitamin A 17000 IE/kg, 18568 Klinoptylolit, 40 mg.").status, "missing");
    assert.equal(check("Artikelnummer: 18723\nAnimal feed for cattle. Anwendung: täglich.").status, "missing");
    assert.equal(check("Alleinfuttermittel für Fische. Kontakt: Fischweg 12, 49808 Lingen.").status, "found");
    assert.match(check("Alleinfuttermittel für Wasserschildkröten. F 68000 Colmar.").matchedText, /F 68000 Colmar/);
  }
  assert.equal(checkNumericLabelRule("art15_002", "COMPOSITION: EACH KG CONTAINS VITAMIN A.", " KG", "keyword", 1).status, "missing");
});

test("Alleinfutter und Zielgruppe auf dem Schildkrötenetikett sind eigenständige Belege", () => {
  const text = "Alleinfutter für Wasserschildkröten und Echsen – Gebrauchsanweisung: täglich sparsam füttern.";
  assert.equal(checkNumericLabelRule("art15_001", text, "Alleinfuttermittel", "keyword", 0.7).matchedText, "Alleinfutter für");
  assert.equal(checkNumericLabelRule("art17_001_complete", text, "Tierart", "keyword", 0.7).matchedText, "für Wasserschildkröten und Echsen");
});

test("Verweise auf Stempel und Behälterboden bleiben Hinweise zur Nachaufnahme", () => {
  for (const [stamp, location] of [
    ["Chargennr.: siehe Stempel", "Stempel"],
    ["Mindestens haltbar bis, Charge: Siehe Behälterboden", "Behälterboden"],
  ]) {
    const text = `Ergänzungsfuttermittel für Pferde. ${stamp}.`;
    const result = checkNumericLabelRule("art15_004", text, "Charge", "keyword", 0.7);
    assert.equal(result.status, "probablyFound");
    assert.ok(result.note.includes(`${location} separat fotografieren`));
    assert.equal(Labeling.needsImprintLot(text), false);
  }
});

test("Diätdeklarationen erhalten ihre Grundart und bleiben bei widersprüchlicher Deklaration offen", () => {
  const complete = "DIÄTALLEINFUTTERMITTEL FÜR KATZEN";
  const complementary = "Diät-Ergänzungs-\nfuttermittel für Hunde";
  assert.equal(Labeling.detectFeedType(complete, FEED_TYPES)?.feedType.id, "complete_feed");
  assert.equal(Labeling.detectFeedType(complementary, FEED_TYPES)?.feedType.id, "complementary_feed");
  assert.equal(Labeling.detectFeedType("Complete dietetic pet food for adult cats", FEED_TYPES)?.feedType.id, "complete_feed");
  assert.equal(Labeling.detectFeedType(`${complete}\n${complementary}`, FEED_TYPES), null);
});

test("Nierendiät behält allgemeine Kennzeichnungsregeln und zeigt zusätzliche belegte Angaben", () => {
  const text = "Diät-Alleinfuttermittel für ausgewachsene Katzen. Zur Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.\n"
    + "Fütterungsempfehlung: Es wird, empfohlen vor der Verwendung oder vor Verlängerung der Fütterungsdauer den Rat eines\n"
    + "Tierarztes einzuholen. Empfohlene Dauer der Fütterung: Zunächst bis zu 6 Monaten.";
  const result = Labeling.check(text, FEED_TYPES[0], []);
  const field = id => result.ruleResults.find(r => r.rule.id === id);
  assert.equal(result.dietary, true);
  assert.equal(field("art18_purpose").status, "found");
  assert.match(field("art18_duration").matchedText, /6 Monaten/);
  assert.match(field("art18_advice").matchedText, /Rat eines Tierarztes einzuholen/);
  assert.equal(field("art18_review").status, "unclear");
  assert.equal(result.overallStatus, "unklar");
  const acuteAndChronic = text.replace("bei chronischer", "bei akuter und chronischer");
  assert.match(Labeling.check(acuteAndChronic, FEED_TYPES[0], []).ruleResults[0].matchedText, /akuter und chronischer/);
  assert.equal(checkNumericLabelRule("art15_001", text, "Alleinfuttermittel", "keyword", 0.7).matchedText, "Diät-Alleinfuttermittel");
});

test("Gastro-Etikett kann mehrere Zwecke zeigen und ein MHD belegt keine Fütterungsdauer", () => {
  const text = "Diät-Alleinfuttermittel für Hunde. Zum Ausgleich unzureichender Verdauung und zur Linderung von Resorptionsstörungen des Darms. "
    + "MHD: 03/2027. Tierärztlich entwickelt.";
  const result = Labeling.check(text, FEED_TYPES[0], []);
  const field = id => result.ruleResults.find(r => r.rule.id === id);
  assert.match(field("art18_purpose").matchedText, /unzureichender Verdauung \/ Linderung von Resorptionsstörungen/);
  assert.equal(field("art18_duration").status, "unclear");
  assert.equal(field("art18_advice").status, "unclear");
  const timed = Labeling.check(text + " Empfohlene Fütterungsdauer: drei bis zwölf Wochen.", FEED_TYPES[0], []);
  assert.match(timed.ruleResults.find(r => r.rule.id === "art18_duration").matchedText, /drei bis zwölf Wochen/);
});

test("Produktnamen und Nierenwerbung lösen keine Diätfutter-Prüfung aus", () => {
  const text = "Alleinfuttermittel für Katzen. Veterinary Diet – Renal. Unterstützt die Nierenfunktion.";
  assert.equal(Labeling.detectFeedType(text, FEED_TYPES)?.feedType.id, "complete_feed");
  assert.equal(Labeling.check(text, FEED_TYPES[0], []).dietary, false);
});

test("Belegausschnitt zeigt die ganze Zeile und kürzt nur an Wortgrenzen", () => {
  const check = (text, keyword = "AG") => Labeling.check(`Ergänzungsfuttermittel für Pferde.\n${text}`, { id: "complementary_feed" },
    [{ id: "x_test", severity: "critical", patterns: [{ patternValue: keyword, patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.9 }] }]).ruleResults[0].matchedText;
  assert.equal(check("Zusammensetzung: Getreide\nHersteller: Beispielfirma AG, Berlin\nAnalytische Bestandteile: Rohprotein 12 %"), "Hersteller: Beispielfirma AG, Berlin");
  assert.equal(check("Hersteller\nAG\nBerlin\nLinde"), "Hersteller AG Berlin");
  const long = check(`${"alpha ".repeat(40)}Beispielfirma AG, Hauptstraße 1 ${"omega ".repeat(40)}`);
  assert.match(long, /^….*Beispielfirma AG, Hauptstraße 1.*…$/);
  assert.doesNotMatch(long.replace(/^…|…$/g, ""), /(?:^|\s)(?:lpha|mega|alph|omeg)(?:\s|$)/);
  assert.ok(long.length < 140);
  assert.equal(check("Mars PF France - CS 20001 - 45550 Saint-Denis-de-l'Hôtel", " KG"), null);
});

test("Mineralfutter-Überschrift gewinnt gegen den vorgeschriebenen Hinweis „Dieses Ergänzungsfutter darf …“", () => {
  const note = "Dieses Ergänzungsfutter darf wegen der gegenüber Alleinfuttermitteln höheren Gehalte an Vitaminen nur an Rinder verfüttert werden.";
  const detect = text => Labeling.detectFeedType(text, FEED_TYPES)?.feedType.id ?? null;
  assert.equal(detect(`Mineralfuttermittel für Rinder\n${note}`), "mineral_feed");
  assert.equal(detect(`Salesta\nMineralfutter für Rinder N & Co\nZusatzstoffe je kg: 8 g\n${note}`), "mineral_feed");
  // nur als Überschrift, nicht als Erwähnung im Fließtext
  assert.equal(detect("Ergänzungsfuttermittel für Pferde. Kann mit Mineralfutter für Pferde kombiniert werden."), "complementary_feed");
  assert.equal(detect(`Ergänzungsfuttermittel für Pferde\n${note}`), "complementary_feed");
});

test("Der Vergleich „gegenüber Alleinfuttermitteln“ belegt keine Futtermittelart", () => {
  const rule = { id: "art15_001", severity: "critical", patterns: [{ patternValue: "Alleinfuttermittel", patternType: "keyword", patternLanguage: "de", confidenceWeight: 1 }] };
  const check = text => Labeling.check(`Futter für Rinder. ${text}`, FEED_TYPES[2], [rule]).ruleResults[0];
  assert.equal(check("Dieses Futter darf wegen der gegenüber Alleinfuttermitteln höheren Gehalte nur an Rinder verfüttert werden.").status, "missing");
  const real = check("Alleinfuttermittel für Rinder. Gegenüber Alleinfuttermitteln anderer Hersteller …");
  assert.equal(real.status, "found");
  assert.match(real.matchedText, /Alleinfuttermittel für Rinder/);
});

test("Zusatzstoffe: Überschrift mit Mengenangabe im eigenen Abschnitt ist ein Beleg", () => {
  const rule = { id: "art15_006", severity: "warning", patterns: [{ patternValue: "Zusatzstoffe", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] };
  const check = text => Labeling.check(`Ergänzungsfuttermittel für Pferde.\n${text}`, FEED_TYPES[1], [rule]).ruleResults[0];
  const real = check("Zusatzstoffe je kg: Vitamin A 12.000 I.E., Vitamin E 50 mg");
  assert.equal(real.status, "found");
  assert.match(real.matchedText, /Zusatzstoffe je kg.*12\.000 I\.E\./);
  assert.equal(check("Ernährungsphysiologische Zusatzstoffe (je kg):\nVitamin D3 3.200 I.E.").status, "found");
  assert.equal(check("Zusatzstoffe je kg:\n15.000 I.E. Vitamin A\n50 mg Vitamin E").status, "found");
  for (const text of ["Zusatzstoffe:\nFütterungsempfehlung: 100 g täglich", "Zusatzstoffe: keine", "Zusatzstoffe je kg:\n\nVitamin A 100 mg",
                      "Zusatzstoffe: Fütterung 100 g", "Ohne Zusatzstoffe. Rohprotein 12 %", "Zusatzstoffe:\nNettogewicht: 400 g",
                      "Zusatzstoffe:\nNettomasse 25 kg", "Zusatzstoffe:\nInhalt: 1,5 kg", "Zusatzstoffe:\nCharge: 12 g", "Zusatzstoffe:\nNet weight: 400 g",
                      "Zusatzstoffe: pro 100 g", "Zusatzstoffe: je 100 g\nVitamin A", "Zusatzstoffe je kg: 100 g", "Zusatzstoffe:\nTagesration 100 g"]) {
    assert.notEqual(check(text).status, "found", text);
  }
});

test("Herstelleranschrift mit gängigen Straßenformen bleibt ein Firmenbeleg", () => {
  const legacy = String.raw`\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+\b`;
  for (const id of ["art15_002", "art17_005_complete"]) {
    const check = text => checkNumericLabelRule(id, `Alleinfuttermittel für Legehennen.\n${text}`, legacy);
    for (const address of ["Hersteller: Geflügelfutter eG, Am Markt 3, 31000 Hildesheim", "Salinenallee 4, 74000 Heilbronn",
                           "Vertrieb: Futterhof OHG, Dorfring 2, 50000 Köln", "Im Gewerbepark 7, 90000 Nürnberg",
                           "Hersteller: Muster, 12345 Musterstadt", "Mars PF France - CS 20001 - 45550 Saint-Denis-de-l'Hôtel",
                           "Postfach 1234, 49000 Osnabrück", "Mars PF France - C$ 20001 - 45550 Saint-Denis-de-VHötel"]) {
      assert.equal(check(address).status, "found", address);
    }
    // weiterhin kein Firmenbeleg ohne Adresskontext
    assert.equal(check("Zusatzstoffe je kg: 18568 Klinoptylolit, 17000 IE").status, "missing");
    assert.equal(check("Hersteller:\nZusammensetzung: 12345 Hafer").status, "missing");
  }
});

test("Hinweis zur freien Wasseraufnahme erkennt gängige Formulierungen", () => {
  const text = water => `Diät-Alleinfuttermittel für ausgewachsene Katzen. Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.\n${water}`;
  const status = water => Labeling.check(text(water), FEED_TYPES[0], []).ruleResults.find(r => r.rule.id === "art18_renal_water").status;
  for (const water of ["Frisches Wasser steht stets zur freien Verfügung.", "Frisches Trinkwasser sollte jederzeit zur Verfügung stehen.",
                       "Wasser sollte stets frisch zur freien Verfügung stehen.", "Wasser zur freien Aufnahme anbieten."]) {
    assert.equal(status(water), "found", water);
  }
  for (const water of ["Mit Wasser mischen.", "Das Wasser aus der Dose abgießen und zur Verfügung stellen.", "Nicht in Wasser einweichen."]) {
    assert.notEqual(status(water), "found", water);
  }
});

test("Nierendiät zeigt Proteinquellen, zugeordnete Mineralstoffgehalte und Wasserhinweis", () => {
  const text = "Diät-Alleinfuttermittel für ausgewachsene Katzen. Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.\n"
    + "Zusammensetzung: Huhn, Reis. Proteinquellen; 7% Huhn, 12% Leber\n"
    + "Analytische Bestandteile: Calcium 0,18 %, Phosphor 0,12%, Kalium 0,25%, Natrium 0,15 %.\n"
    + "Bitte Wasser zur freien Aufnahme anbieten.";
  const result = Labeling.check(text, FEED_TYPES[0], []);
  const field = id => result.ruleResults.find(r => r.rule.id === `art18_renal_${id}`);
  assert.match(field("protein").matchedText, /7% Huhn, 12% Leber$/);
  assert.equal(field("calcium").matchedText, "Calcium 0,18 %");
  assert.equal(field("phosphor").matchedText, "Phosphor 0,12%");
  assert.equal(field("kalium").matchedText, "Kalium 0,25%");
  assert.equal(field("natrium").matchedText, "Natrium 0,15 %");
  assert.equal(field("water").status, "found");
  assert.equal(result.overallStatus, "unklar");
});

test("Nierendiät übernimmt keine Gehalte aus Werbung oder aus einer Nachbarspalte", () => {
  const label = "Diät-Alleinfuttermittel für Hunde. Zur Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.";
  const result = Labeling.check(label + " Neu: Phosphor 20 % reduziert. Proteinquellen: siehe Rückseite.\n"
    + "Analytische Bestandteile: Calcium 0,35%, Phosphor, 0,25% Kalium, Natrium 0,15%.\n"
    + "Zusatzstoffe: Phosphor 1 g/kg. Es wird empfohlen, vor der Verwendung den Rat eines Tierarztes einzuholen.", FEED_TYPES[0], []);
  const field = id => result.ruleResults.find(r => r.rule.id === id);
  assert.equal(field("art18_renal_phosphor").status, "unclear");
  assert.equal(field("art18_renal_kalium").matchedText, "0,25% Kalium");
  assert.equal(field("art18_renal_protein").status, "unclear");
  assert.equal(field("art18_advice").status, "unclear");
  assert.match(field("art18_advice").matchedText, /Tierarztes/);
  const after = Labeling.check(label + " Vor Verlängerung der Fütterung den Rat eines Tierarztes einzuholen.", FEED_TYPES[0], []);
  assert.equal(after.ruleResults.find(r => r.rule.id === "art18_advice").status, "unclear");
});

test("Mineralstoffwerte aus mehreren Ansichten werden verglichen und Widersprüche bleiben offen", () => {
  const text = "Complete dietetic pet food for adult cats. Support of renal function in case of chronic renal insufficiency.\n"
    + "Analytical constituents: Phosphorus 0.12%, Potassium 0.25%.\n\nAnalytische Bestandteile: Phosphor 1,2 g/kg, Kalium 0,29%.";
  const result = Labeling.check(text, FEED_TYPES[0], []);
  const field = id => result.ruleResults.find(r => r.rule.id === `art18_renal_${id}`);
  assert.equal(field("phosphor").status, "found");
  assert.equal(field("kalium").status, "unclear");
  assert.match(field("kalium").matchedText, /0.25%.*0,29%/);
  assert.match(field("kalium").note, /Widersprüchliche/);
});

test("Der Hinweis auf leichtverdauliche Ernährung gehört zum ausdrücklich deklarierten Verdauungszweck", () => {
  const text = "Diät-Alleinfuttermittel für Katzen. Zum Ausgleich unzureichender Verdauung. Leichtverdauliche Ernährung.";
  const result = Labeling.check(text, FEED_TYPES[0], []);
  const check = result.ruleResults.find(r => r.rule.id === "art18_digestible_diet");
  assert.equal(check.status, "found");
  assert.match(check.rule.legalBasis, /Eintrag 19/);
  assert.ok(!result.ruleResults.some(r => r.rule.id.startsWith("art18_renal_")));
});

test("Diät-Nachsuche braucht einen konkreten Zweck und eine separat lesbare Deklaration", () => {
  assert.equal(Labeling.needsDietDeclaration("Zur Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz"), true);
  assert.equal(Labeling.needsDietDeclaration("Renal, unterstützt die Nieren"), false);
  assert.equal(Labeling.needsDietDeclaration("Diät-Alleinfuttermittel für Katzen. Zur Unterstützung der Nierenfunktion."), false);
  assert.equal(Labeling.dietDeclarationHint("Zusatzprüfung: DIÄT-ALLEINFUTTERMITTEL FÜR AUSGEWACHSENE KATZEN. Beschreibung."),
    "DIÄT-ALLEINFUTTERMITTEL FÜR AUSGEWACHSENE KATZEN");
  assert.equal(Labeling.dietDeclarationHint("Renal. Zur Unterstützung der Nierenfunktion bei Katzen"), "");
  const renal = "Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz";
  assert.equal(Labeling.dietPurposeHint(`${renal} und zur Verringerung von Oxalsteinbildung.`, renal),
    "Verringerung von Oxalsteinbildung");
});

test("OCR-Ausschnitt verwendet die Wörter der passenden Phrase und ignoriert Randtext", () => {
  const bounds = x0 => ({ x0, x1: x0 + 8, y0: 20, y1: 30 });
  const data = { blocks: [{ paragraphs: [{ lines: [{ words: ["Rand", "Nettogewicht", "500g"].map((text, i) => ({
    text, confidence: 90, bbox: bounds(i * 10),
  })) }] }] }] };
  assert.deepEqual(Ocr.findTextRegion(data, Labeling.matchNetHeading), { first: bounds(10), last: bounds(10) });
  assert.equal(Ocr.findTextRegion(data, Labeling.matchDietPurposeAnchor), null);
});

test("ein getrennt gedruckter Calciumgehalt bleibt eine zweifach gelesene Zusatzangabe", () => {
  const broken = "Diät-Alleinfuttermittel für Katzen. Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.\n"
    + "Analytische Bestandteile: Rohasche 1,8%, Calci-\n‚um 0,189, Phosphor 0,12%, Kalium 0,25%.";
  assert.equal(Labeling.needsSplitCalcium(broken), true);
  assert.equal(Labeling.needsSplitCalcium(broken.replace("Calci-\n‚um 0,189,", "Calcium 0,18%,")), false);
  const hint = Labeling.matchingSplitCalcium("ım 0,18%, Phosphor 0,12%", "m 0,18%, Phosphor 0,12%");
  assert.equal(hint, "OCR-Nachprüfung Calcium: 0,18 %");
  assert.equal(Labeling.matchingSplitCalcium("m 0,18%, Phosphor 0,12%", "m 0,16%, Phosphor 0,12%"), "");
  assert.equal(Labeling.matchingSplitCalcium("m 0,18%, Phosphor 0,12%", "m 0,18%, Phosphor 0,17%"), "");
  const result = Labeling.check(broken + "\n\n" + hint, FEED_TYPES[0], []);
  const calcium = result.ruleResults.find(r => r.rule.id === "art18_renal_calcium");
  assert.equal(calcium.status, "probablyFound");
  assert.match(calcium.note, /Originaletikett/);
});

test("Phosphor und Rohprotein werden aus einem beschrifteten Abschnitt auf 12 % Feuchte umgerechnet", () => {
  const text = "Diät-Alleinfuttermittel für Katzen. Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.\n"
    + "Analytische Bestandteile: Phosphor 0,12%, Rohproteln 6%, Feuchtegehalt 80%.";
  const result = Labeling.check(text, FEED_TYPES[0], []);
  const calc = id => result.ruleResults.find(r => r.rule.id === `art18_renal_12pct_${id}`);
  assert.equal(calc("phosphorus").status, "probablyFound");
  assert.match(calc("phosphorus").matchedText, /^5,28 g\/kg/);
  assert.match(calc("protein").matchedText, /^264 g\/kg/);
  assert.equal(result.overallStatus, "unklar");
  // eine vorangestellte Prozentzahl einer Nachbarangabe ist keine zweite Feuchteangabe
  const adjacent = Labeling.check(text.replace("Rohproteln 6%,", "Rohasche 7 %"), FEED_TYPES[0], []);
  assert.match(adjacent.ruleResults.find(r => r.rule.id === "art18_renal_12pct_phosphorus").matchedText, /^5,28 g\/kg/);
  const at12 = Labeling.check(text.replace("80%", "12%"), FEED_TYPES[0], []);
  assert.match(at12.ruleResults.find(r => r.rule.id === "art18_renal_12pct_phosphorus").matchedText, /^1,2 g\/kg/);
});

test("leere Quellenüberschrift liest nicht in die nächste Diätangabe hinein", () => {
  const label = "Diät-Alleinfuttermittel für Katzen. Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.\n";
  for (const next of ["Empfohlene Fütterungsdauer: bis zu 6 Monate.", "Fütterungsdauer: bis zu 6 Monate.", "Frisches Wasser steht stets zur freien Verfügung.",
                      "Vor Verwendung oder Verlängerung den Rat eines Tierarztes einholen.", "Hersteller: Muster GmbH, Berlin"]) {
    const result = Labeling.check(`${label}Proteinquellen:\n${next}`, FEED_TYPES[0], []);
    assert.notEqual(result.ruleResults.find(r => r.rule.id === "art18_renal_protein").status, "found", next);
  }
  const real = Labeling.check(`${label}Proteinquellen: Huhn, Leber.\nEmpfohlene Fütterungsdauer: bis zu 6 Monate.`, FEED_TYPES[0], []);
  const field = real.ruleResults.find(r => r.rule.id === "art18_renal_protein");
  assert.equal(field.status, "found");
  assert.match(field.matchedText, /Huhn, Leber/);
  assert.doesNotMatch(field.matchedText, /Fütterungsdauer/);
});

test("Feuchteumrechnung bleibt bei widersprüchlicher oder nicht zuordenbarer Basis offen", () => {
  const label = "Diät-Alleinfuttermittel für Hunde. Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.\n";
  for (const body of [
    "Analytische Bestandteile: Phosphor 0,12%.",
    "Analytische Bestandteile: Phosphor 0,12%, Feuchte 100%.",
    "Analytische Bestandteile: Phosphor 0,12%, Feuchte 80%. Bezogen auf Trockenmasse.",
    "Analytische Bestandteile: Phosphor 0,12%, Feuchte 80%. Basis: 12 % Feuchte.",
    "Analytische Bestandteile: Phosphor 0,12%.\n\nAnalytical constituents: Moisture 80%.",
    "Analytische Bestandteile: Phosphor 0,12%, Feuchte 80%.\n\nAnalytical constituents: Moisture 83%.",
    "Analytische Bestandteile: Phosphor 1.200 mg/kg, Feuchte 80%.",
    "Analytische Bestandteile: Phosphor 1200 mg/kg TM, Feuchte 80%.",
    "Analytische Bestandteile: Phosphor 0,12%; 0,25% phosphorus; Feuchte 80%.",
    "Analytische Bestandteile: Phosphor 0,12%; Feuchte 80%; 83% moisture.",
  ]) {
    const result = Labeling.check(label + body, FEED_TYPES[0], []);
    assert.equal(result.ruleResults.find(r => r.rule.id === "art18_renal_12pct_phosphorus").status, "unclear", body);
  }
});

test("Ein Calciumhinweis stimmt mit derselben Menge in einer anderen Einheit überein", () => {
  const label = "Diät-Alleinfuttermittel für Hunde. Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.\n";
  const status = value => Labeling.check(label + `Analytische Bestandteile: Calcium ${value}.\n\nOCR-Nachprüfung Calcium: 0,18 %`,
    FEED_TYPES[0], []).ruleResults.find(r => r.rule.id === "art18_renal_calcium").status;
  assert.equal(status("1,8 g/kg"), "found");
  assert.equal(status("0,16 %"), "unclear");
});

test("Struvitrezidive lösen ihre eigenen Angaben und die Magnesiumrechnung aus", () => {
  const text = "Diät-Alleinfuttermittel für ausgewachsene Katzen. Zur Verringerung von Struvitsteinrezidiven.\n"
    + "Es wird empfohlen, vor der Verwendung oder Verlängerung der Fütterungsdauer den Rat eines Tierarztes einzuholen. "
    + "Metastabilisierende Eigenschaften in Bezug auf Struvit. Wasser zur freien Aufnahme anbieten.\n"
    + "Analytische Bestandteile: Feuchtegehalt 80%, Calcium\n0,15%, Phosphor 0,12%, Magnesium 0,02%, "
    + "Kalium 0,15%, Natrium 0,09%, Chlorid 0,15%, Schwefel 0,2%.";
  const result = Labeling.check(text, FEED_TYPES[0], []);
  const field = id => result.ruleResults.find(r => r.rule.id === `art18_struvite_${id}`);
  assert.equal(field("dissolution_effect"), undefined);
  assert.equal(field("recurrence_effect").status, "found");
  assert.match(field("recurrence_effect").rule.legalBasis, /Eintrag 18/);
  assert.equal(field("calcium").matchedText, "Calcium 0,15%");
  assert.equal(field("chlorid").status, "found");
  assert.equal(field("schwefel").status, "found");
  assert.equal(field("water").status, "found");
  assert.match(field("12pct_magnesium").matchedText, /^0,88 g\/kg/);
  assert.equal(result.ruleResults.find(r => r.rule.id === "art18_advice").status, "found");
});

test("Metastabilisierende Eigenschaften allein belegen die Auflösung nicht", () => {
  const label = "Diät-Alleinfuttermittel für Hunde. Zur Auflösung von Struvitsteinen. ";
  const check = wording => Labeling.check(label + wording, FEED_TYPES[0], []).ruleResults
    .find(r => r.rule.id === "art18_struvite_dissolution_effect");
  assert.equal(check("Metastabilisierende Eigenschaften in Bezug auf Struvit.").status, "unclear");
  assert.equal(check("Ohne harnsäuernde Eigenschaften.").status, "unclear");
  const acidifying = check("Harnsäuernde Eigenschaften.");
  assert.equal(acidifying.status, "found");
  assert.match(acidifying.rule.legalBasis, /Eintrag 17/);
});

test("Urinary-Werbung auf einem Ergänzungsfutter belegt keinen Struvit-Ernährungszweck", () => {
  const label = "Ergänzungsfuttermittel für Katzen. Urinary-Snack, Magnesium reduziert.";
  const result = Labeling.check(label, FEED_TYPES[1], []);
  assert.equal(result.dietary, false);
  assert.ok(!result.ruleResults.some(r => r.rule.id.startsWith("art18_struvite_")));
});

test("mehrere Fütterungsdauern werden angezeigt und bleiben der manuellen Zuordnung vorbehalten", () => {
  const text = "Diät-Alleinfuttermittel für Katzen. Auflösung von Struvitsteinen und Verringerung von Struvitsteinrezidiven. "
    + "Fütterungsdauer: fünf bis zwölf Wochen. Bei Rückfällen zunächst bis zu sechs Monaten.";
  const result = Labeling.check(text, FEED_TYPES[0], []);
  const duration = result.ruleResults.find(r => r.rule.id === "art18_duration");
  assert.equal(duration.status, "probablyFound");
  assert.match(duration.matchedText, /fünf bis zwölf Wochen.*zunächst bis zu sechs Monaten/);
  assert.match(duration.note, /Zuordnung/);
});

test("zweisprachige Nettoüberschrift umfasst die gesamte Packungsformel", () => {
  const text = "NETTOGEWICHT / POIDS NET: /\n2x57g © = 114 g";
  assert.equal(Labeling.matchNetHeading(text)[0], "NETTOGEWICHT / POIDS NET");
  assert.equal(Labeling.declaredNetAmount(text), "114 g");
  assert.equal(Labeling.declaredNetAmount(text.replace("2x57g", "2x579g")), null);
  assert.equal(Labeling.declaredNetAmount(text.replace(" = 114 g", "")), null);
});

test("eine zweite Feuchtelesung zeigt abweichende Werte, bis der OCR-Text korrigiert ist", () => {
  const first = "Alleinfuttermittel für Katzen. Feuchtigkeit: 63,0 %";
  const hint = Labeling.moistureCropHint(first, "Feuchtigkeit: 83,0 %,P", "Feuchtigkeit: 83,0%,");
  assert.equal(hint, "OCR-Nachprüfung Feuchtewert: 83,0 %");
  assert.equal(Labeling.moistureCropHint(first, "Feuchtigkeit: 83,0 %", "Feuchtigkeit: 80%"), "");
  assert.equal(Labeling.moistureCropHint(first, "Feuchtigkeit: 63,0 %", "Feuchtigkeit: 63%"), "");
  const check = text => checkNumericLabelRule("art15_005", text, "Feuchtigkeit", "keyword", 0.7);
  const conflict = check(`${first}\n\n${hint}`);
  assert.equal(conflict.status, "unclear");
  assert.match(conflict.matchedText, /63,0.*OCR-Nachprüfung Feuchtewert: 83,0/);
  assert.equal(check(`${first.replace("63,0", "83")}\n\n${hint}`).status, "found");
  assert.equal(check(`Alleinfuttermittel für Katzen.\n\n${hint}`).status, "probablyFound");
});

test("Sensitive-Diät trennt Eiweiß- und Kohlenhydratquellen und erhält die bedingte Folgedauer", () => {
  const text = "Diät-Alleinfuttermittel für ausgewachsene Katzen. Zur Minderung von Ausgangerzeugnis- und Nährstoffintoleranzerscheinungen.\n"
    + "Es wird empfohlen, vor der Verwendung oder Verlängerung der Fütterungsdauer den Rat eines Tierarztes einzuholen. "
    + "Fütterungsdauer: 3-8 Wochen, wenn Anzeichen von Intoleranzen verschwinden, kann dieses Futtermittel zunächst bis zu einem Jahr verwendet werden.\n"
    + "Ausgewählte Eiweißquellen: Huhn, Pute. Ausgewählte Kohlenhydratauellen:\n1,9% Kartoffelstärke, Reis. "
    + "Analytische Bestandteile: Feuchtegehalt 81%.";
  const result = Labeling.check(text, FEED_TYPES[0], []);
  const field = id => result.ruleResults.find(r => r.rule.id === `art18_${id}`);
  assert.equal(field("purpose").status, "found");
  assert.match(field("duration").matchedText, /3-8 Wochen.*wenn Anzeichen.*einem Jahr/);
  assert.equal(field("advice").status, "found");
  assert.equal(field("intolerance_protein").matchedText, "Ausgewählte Eiweißquellen: Huhn, Pute.");
  assert.match(field("intolerance_carbohydrates").matchedText, /Kartoffelstärke, Reis\.$/);
  assert.match(field("intolerance_carbohydrates").rule.legalBasis, /Eintrag 13/);
});

test("Sensitive-Werbetext und bloße Verweise sind keine deklarierten Quellen", () => {
  const marketing = "Diät-Alleinfuttermittel für Katzen. Sensitive, gut verträglich. Enthält ausgewählte Eiweißquellen.";
  const noPurpose = Labeling.check(marketing, FEED_TYPES[0], []);
  assert.ok(!noPurpose.ruleResults.some(r => r.rule.id.startsWith("art18_intolerance_")));
  const result = Labeling.check(marketing + " Reduction of ingredient and nutrient intolerances. Ausgewählte Eiweißquellen: siehe Etikett. "
    + "It is recommended that a veterinarian's opinion be sought before use and before extending the period of use.",
  FEED_TYPES[0], []);
  assert.equal(result.ruleResults.find(r => r.rule.id === "art18_intolerance_protein").status, "unclear");
  assert.equal(result.ruleResults.find(r => r.rule.id === "art18_advice").status, "found");
});

test("Zutatennachsuche braucht eine Fütterungstabelle mit Gewichtsbezug und übernimmt nur konkrete Zutaten", () => {
  const table = "FEEDING ADVICE PAVO WeightLift\nLichaamsgewicht / Körpergewicht / Body weight";
  assert.equal(Labeling.needsCompositionCrop(table), true);
  assert.equal(Labeling.needsCompositionCrop("Fütterungsempfehlung: täglich Futter anbieten."), false);
  assert.equal(Labeling.needsCompositionCrop(table + "\nZusammensetzung: Luzerne, Reis."), false);
  const multilingual = "Samenstelling / Komposition / Composition\nNL Luzerne, rijst\nDE Luzerne, Reiskleie, Leinsaat\nEN Alfalfa, rice";
  const recovered = Labeling.compositionCropHint(multilingual);
  assert.match(recovered, /DE Luzerne, Reiskleie, Leinsaat$/);
  assert.doesNotMatch(recovered, /rijst|Alfalfa/);
  assert.equal(Labeling.compositionCropHint("Zusammensetzung: siehe Rückseite"), "");
});

test("widersprüchliche Chargen aus mehreren Ansichten bleiben unklar", () => {
  const rule = text => checkNumericLabelRule("art15_004", `Ergänzungsfuttermittel für Pferde.\n${text}`, "Charge", "keyword", 0.7);
  const result = rule("Charge: 01102000040327\n\nChargennummer: 01102000040321");
  assert.equal(result.status, "unclear");
  assert.match(result.matchedText, /01102000040327.*01102000040321/);
  assert.equal(rule("Charge: 01102000040327\n\nChargennummer: 01102000040327").status, "found");
  assert.equal(rule("Charge: 001234\n\nCharge: 1234").status, "unclear");
  assert.equal(rule("Lot Number: 05925").matchedText, "Lot Number: 05925");
});

test("Verweise auf unterschiedliche Stellen werden je nach Feld getrennt zugeordnet", () => {
  const text = "Ergänzungsfuttermittel für Pferde.\nMHD: siehe Stempel.\nLot no.: see container base.";
  const expiry = checkNumericLabelRule("art17_002_complementary", text, "MHD", "keyword", 0.7);
  const lot = checkNumericLabelRule("art15_004", text, "Charge", "keyword", 0.7);
  assert.equal(expiry.status, "probablyFound");
  assert.match(expiry.note, /Stempel separat fotografieren/);
  assert.equal(lot.status, "probablyFound");
  assert.match(lot.note, /Behälterboden separat fotografieren/);
  assert.equal(lot.matchedText, "Lot no.: see container base");
});

test("MHD behält den Originaltext und kombiniert kompatible Tages- und Monatsangaben", () => {
  const check = text => checkNumericLabelRule("art17_002_complementary",
    `Ergänzungsfuttermittel für Pferde.\n${text}`, "MHD", "keyword", 0.7);
  assert.equal(check("MHD: 03/2027").matchedText, "MHD: 03/2027");
  assert.equal(check("MHD: 09.2026\n\nMindestens haltbar bis\n04.09.2026").matchedText, "Mindestens haltbar bis\n04.09.2026");
  assert.equal(check("MHD: 29.02.2028").status, "found");
  assert.equal(check("MHD: 04.09.26\n\nBest before 2026-09-04").status, "found");
  assert.equal(check("MHD: 04.09.2026\n\nMHD 05.09.2026").status, "unclear");
  assert.equal(check("MHD: 04.09.2026\n\nMHD 10/2026").status, "unclear");
});

test("unmögliche Kalenderdaten und unbeschriftete Stempel werden nicht bestätigt", () => {
  const check = text => checkNumericLabelRule("art17_002_complementary",
    `Ergänzungsfuttermittel für Pferde.\n${text}`, "MHD", "keyword", 0.7);
  for (const text of ["MHD: 29.02.2027", "MHD: 31.04.2027", "MHD 99.2027", "MHD 00/2027"]) {
    assert.equal(check(text).status, "unclear", text);
    assert.match(check(text).note, /Kalenderdatum/);
  }
  assert.equal(check("09.2027 C06A\n12:33").status, "missing");
});

test("Nettomengen vergleichen dieselbe Dimension und halten Gewicht und Volumen getrennt", () => {
  const check = text => checkNumericLabelRule("art15_003", `Alleinfuttermittel für Zierfische.\n${text}`, "Nettogewicht", "keyword", 0.7);
  assert.equal(check("Nettogewicht: 1 kg\n\nNet weight: 1000 g").status, "found");
  const conflict = check("Nettogewicht: 1 kg\n\nNet weight: 1100 g");
  assert.equal(conflict.status, "unclear");
  assert.match(conflict.matchedText, /1 kg.*1100 g/);
  assert.equal(check("64g/250ml℮").matchedText, "64 g / 250 ml");
  assert.notEqual(check("64g/250g℮").status, "found");
  assert.notEqual(check("Nettogewicht: 57 g x 2").status, "found");
});

test("eine separat gedruckte metrische Nettomenge ist aus dem englischen Doppelaufdruck lesbar", () => {
  assert.equal(Labeling.declaredNetAmount("Net Weight 50 Ib (22.67 kg) Or As Invoiced"), "22.67 kg");
  assert.equal(Labeling.declaredNetAmount("Net Weight 50 lb (22.67 l)"), null);
  assert.equal(Labeling.declaredNetAmount("Net Weight 50 lb (32.67 kg)"), null);
  assert.equal(Labeling.declaredNetAmount("50 lb (22.67 kg)"), null);
});

test("ausgeschlossene Ernährungszwecke lösen keine zweckbezogene Prüfung aus", () => {
  const text = "Diät-Alleinfuttermittel für Hunde. Nicht zur\nAuflösung von Struvitsteinen. "
    + "Zur Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz.";
  const result = Labeling.check(text, FEED_TYPES[0], []);
  const purpose = result.ruleResults.find(r => r.rule.id === "art18_purpose");
  assert.match(purpose.matchedText, /Nierenfunktion/);
  assert.doesNotMatch(purpose.matchedText, /Struvit/);
  assert.ok(!result.ruleResults.some(r => r.rule.id.startsWith("art18_struvite_")));
  assert.equal(Labeling.needsDietDeclaration("Nicht zur Unterstützung der Nierenfunktion bei chronischer Niereninsuffizienz."), false);
});

test("die französische Typzeile aus einer Nachbarspalte gehört nicht zur deutschen Zutatenliste", () => {
  const text = "Alleinfuttermittel für Katzen. Zusammensetzung: Fleisch und tierische Nebenerzeugnisse Aliment complet pour chats (32 % davon 18 % Huhn), Zucker, Mineralstoffe. Zusatzstoffe: Taurin.";
  const result = checkNumericLabelRule("art17_003_complete", text, "Zusammensetzung", "keyword", 0.7);
  assert.equal(result.matchedText, "Zusammensetzung: Fleisch und tierische Nebenerzeugnisse (32 % davon 18 % Huhn), Zucker, Mineralstoffe.");
});

test("Diabetes und Aufbaukur erhalten ihren ausdrücklich deklarierten Ernährungszweck", () => {
  const field = (text, id) => Labeling.check(text, FEED_TYPES[0], []).ruleResults.find(r => r.rule.id === id);
  const base = "Diät-Alleinfuttermittel für ausgewachsene Katzen. ";
  const diabetes = field(base + "Zur Regulierung der Glucoseversorgung (Diabetes mellitus).", "art18_purpose");
  assert.equal(diabetes.status, "found");
  assert.match(diabetes.matchedText, /Glucoseversorgung \(Diabetes mellitus\)/);
  assert.equal(field(base + "Diabetes steht im Produktnamen.", "art18_purpose").status, "unclear");
  const recovery = base + "Zur ernährungsphysiologischen Wiederherstellung, Rekonvaleszenz. Empfohlene Dauer der Fütterung: Bis zur voll\nStändigen Genesung.";
  assert.equal(field(recovery, "art18_purpose").status, "found");
  assert.equal(field(recovery, "art18_duration").matchedText, "Bis zur vollständigen Genesung");
  assert.equal(field(recovery, "art18_review").status, "unclear");
});

test("Feuchte über 100 Prozent bleibt sichtbar und erhält einen konkreten Korrekturhinweis", () => {
  const text = "Diät-Alleinfuttermittel für Katzen. Feuchtegehalt 80%. Humidite 809%.";
  const result = checkNumericLabelRule("art15_005", text, "Feuchtigkeit", "keyword", 0.7);
  assert.equal(result.status, "unclear");
  assert.match(result.matchedText, /80%.*809%/);
  assert.match(result.note, /über 100 %/);
});
