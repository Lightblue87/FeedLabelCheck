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
