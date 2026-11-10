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

test("cleanText korrigiert als 32xxx gelesene Vitamincodes, Mengen bleiben", () => {
  const out = Ocr.cleanText("90.000 I.E. Vitamin D3 (32671)\n3.000 mg Vitamin E (3a700)\nEnergie (32000) kJ\nJod (3202)");
  assert.match(out, /Vitamin D3 \(3a671\)/);
  assert.match(out, /\(32000\)/);
  assert.match(out, /\(3202\)/);
});

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
  // eine ausdrückliche Ergänzungsfuttermittel-Bezeichnung bleibt maßgeblich, auch bei einer Anweisungszeile „Mineralfutter für …“
  assert.equal(detect("Ergänzungsfuttermittel für Pferde\nFütterungsempfehlung:\nMineralfutter für Pferde zusätzlich anbieten."), "complementary_feed");
  assert.equal(detect(`Ergänzungsfuttermittel für Pferde\nMineralfutter für Pferde zusätzlich anbieten.\n${note}`), "complementary_feed");
  assert.equal(detect(`Mineralfutter für Rinder\nFütterungsempfehlung: 100 g\n${note}`), "mineral_feed");
});

test("Kurzform „Mineralfutter für Rinder“ belegt die Futtermittelart nur für den passenden Typ", () => {
  const rule = { id: "art15_001", severity: "critical", patterns: [{ patternValue: "Mineralfuttermittel", patternType: "keyword", patternLanguage: "de", confidenceWeight: 1 }] };
  const check = (text, type) => Labeling.check(text, FEED_TYPES.find(f => f.id === type), [rule]).ruleResults[0];
  const label = "Carolina\nMineralfutter für Rinder\nDieses Ergänzungsfutter darf wegen der gegenüber Alleinfuttermitteln höheren Gehalte an Rinder gefüttert werden.";
  const found = check(label, "mineral_feed");
  assert.equal(found.status, "found");
  assert.equal(found.matchedText, "Mineralfutter für Rinder");
  assert.equal(check(label, "complete_feed").status, "missing");
  assert.equal(check("Ergänzungsfutter für Pferde\nZusammensetzung: Hafer", "complementary_feed").status, "found");
  // Fließtext und Anweisungen im Satz sind keine Bezeichnung
  assert.equal(check("Zusammensetzung: Hafer. Man kann Mineralfutter für Rinder zusätzlich anbieten.", "mineral_feed").status, "missing");
});

test("„mind. haltbar bis: Siehe Aufdruck“ ist ein Verweis auf den Aufdruck", () => {
  const rule = { id: "art17_002_complementary", severity: "critical", patterns: [{ patternValue: "MHD", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] };
  const result = Labeling.check("Mineralfutter für Rinder\nEinschließlich Vitamine mind.\nhaltbar bis: Siehe Aufdruck\nSechs Monate vor MHD hergestellt.", FEED_TYPES[1], [rule]).ruleResults[0];
  assert.equal(result.status, "probablyFound");
  assert.match(result.matchedText, /mind\. haltbar bis: Siehe Aufdruck/);
  assert.match(result.note, /Verweis auf Aufdruck erkannt/);
  const dated = Labeling.check("Mineralfutter\nmind. haltbar bis: 12/2027", FEED_TYPES[1], [rule]).ruleResults[0];
  assert.equal(dated.status, "found");
  assert.match(dated.matchedText, /12\/2027/);
});

test("Bezeichnungen der Futtermittelart in Kurz- und Langform werden als Typ und als Beleg erkannt", () => {
  const types = [...FEED_TYPES.map(type => type.id === "complementary_feed" ? { ...type, keywordsDe: [...type.keywordsDe, "Raufutterergänzung"] } : type),
    { id: "compound_feed", nameDe: "Mischfuttermittel", keywordsDe: ["Mischfuttermittel", "Mischfutter"] },
    { id: "milk_replacer", nameDe: "Milchaustauscher", keywordsDe: ["Milchaustauscher", "Milch-Austauscher", "Aufzuchtmilch"] }];
  const patterns = ["Alleinfuttermittel", "Ergänzungsfuttermittel", "Einzelfuttermittel", "Mischfuttermittel", "Mineralfuttermittel", "Milchaustauscher"]
    .map(patternValue => ({ patternValue, patternType: "keyword", patternLanguage: "de", confidenceWeight: 1 }));
  const rule = { id: "art15_001", severity: "critical", patterns };
  const cases = [
    ["Alleinfutter für Mastschweine", "complete_feed"], ["Allein-Futtermittel für Kälber", "complete_feed"],
    ["Ergänzungsfutter", "complementary_feed"], ["Ergänzungsfutter für Pferde", "complementary_feed"], ["Raufutterergänzung für Pferde", "complementary_feed"],
    ["Mineralfutter", "mineral_feed"], ["Mineralfutter für Rinder und Schafe", "mineral_feed"], ["Mineralfuttermittel für Schafe", "mineral_feed"],
    ["Mischfutter für Schweine", "compound_feed"], ["Mischfuttermittel für Schweine", "compound_feed"],
    ["Kälbermilchaustauscher", "milk_replacer"], ["Lämmermilchaustauscher für Lämmer", "milk_replacer"], ["Milchaustauscher für Kälber", "milk_replacer"],
  ];
  for (const [designation, expected] of cases) {
    const text = `Produktname\n${designation}\nZusammensetzung: Weizen, Mais\nAnalytische Bestandteile: Rohprotein 18 %`;
    const detected = Labeling.detectFeedType(text, types);
    assert.equal(detected?.feedType.id, expected, designation);
    const result = Labeling.check(text, detected.feedType, [rule]).ruleResults[0];
    assert.equal(result.status, "found", designation);
    assert.match(result.matchedText, new RegExp(designation.split(" ")[0].replace(/[-]/g, "\\-")), designation);
  }
  // Anweisungssätze auf einer eigenen Zeile sind keine Bezeichnung, auch wenn sie mit der Kurzform beginnen
  const mineral = types.find(f => f.id === "mineral_feed");
  for (const text of ["Fütterungsempfehlung:\nMineralfutter zur freien Aufnahme zusätzlich anbieten.", "Fütterungsempfehlung:\nMineralfutter zum Rindviehfutter geben.",
                      "Mineralfutter für Pferde zusätzlich anbieten.", "Mineralfutter für Rinder darf nur ergänzend gegeben werden.",
                      "Mineralfutter für Rinder soll täglich 100 g, sollte aber nicht allein verfüttert werden"]) {
    assert.equal(Labeling.check(`Futter\n${text}`, mineral, [rule]).ruleResults[0].status, "missing", text);
  }
  assert.equal(Labeling.detectFeedType("Ergänzungsfuttermittel für Pferde\nFütterungsempfehlung:\nMineralfutter für Pferde zusätzlich anbieten.", types)?.feedType.id, "complementary_feed");
  assert.equal(Labeling.check("Futter\nMineralfutter für Rinder, Schafe und Ziegen", mineral, [rule]).ruleResults[0].status, "found");
  // Kurzform nur als Überschrift: im Fließtext, als Produktname oder als Zutat gibt es keine Art
  for (const [text, type] of [["Zusammensetzung: Weizen. Man kann Mineralfutter anbieten.", "mineral_feed"],
                              ["Zusammensetzung: Mischfutteranteil 20 %", "compound_feed"], ["Legehennenfutter\nZuchtfutter für Sauen", "complete_feed"]]) {
    assert.equal(Labeling.check(`Futter\n${text}`, types.find(f => f.id === type), [rule]).ruleResults[0].status, "missing", text);
  }
});

// ── Spaltenreihenfolge ────────────────────────────────────────────

const boxed = (y, ...cells) => cells.map(([text, x0, x1]) => ({ text, confidence: 90, bbox: { x0, x1, y0: y, y1: y + 15 } }));
const lineText = lines => lines.map(words => words.map(word => word.text).join(" "));

test("zweispaltiges Etikett: Zeilen werden an der Spaltenlücke getrennt und spaltenweise geordnet", () => {
  const lines = [
    boxed(10, ["Carolina", 288, 560]),
    boxed(40, ["Zusammensetzung:", 47, 250], ["Analytische", 403, 520], ["Bestandteile:", 525, 690]),
    boxed(69, ["Weizengrießkleie", 47, 200], ["4%", 410, 440], ["Phosphor", 450, 520]),
    boxed(97, ["Calciumcarbonat", 47, 190], ["10%", 410, 445], ["Calcium", 455, 520]),
    boxed(125, ["Magnesiumoxid", 48, 193]),
    boxed(153, ["Ernährungsphysiologische", 402, 597], ["Zusatzstoffe", 602, 690]),
    boxed(181, ["Fütterung:", 38, 140], ["625.000", 408, 468], ["I.E.", 472, 500], ["Vitamin", 510, 580], ["A", 585, 600]),
    boxed(209, ["Dieses", 38, 100], ["Ergänzungsfutter", 105, 300], ["3.000", 426, 467], ["mg", 470, 495], ["Vitamin", 500, 560], ["E", 565, 580]),
  ];
  assert.deepEqual(lineText(Ocr.reorderColumns(lines)), [
    "Carolina", "Zusammensetzung:", "Weizengrießkleie", "Calciumcarbonat", "Magnesiumoxid", "Fütterung:", "Dieses Ergänzungsfutter",
    "Analytische Bestandteile:", "4% Phosphor", "10% Calcium", "Ernährungsphysiologische Zusatzstoffe", "625.000 I.E. Vitamin A", "3.000 mg Vitamin E",
  ]);
});

test("getrennte Spaltenstücke behalten die Entscheidung der ursprünglichen Zeile (Konfidenzfilter)", () => {
  const row = (y, confidence, ...cells) => ({ words: cells.map(([text, x0, x1, conf]) => ({ text, confidence: conf ?? confidence, bbox: { x0, x1, y0: y, y1: y + 15 } })) });
  const result = lines => ({ blocks: [{ paragraphs: [{ lines }] }] });
  const data = result([
    row(40, 90, ["Zusammensetzung:", 47, 250, 90], ["Analytische", 403, 520, 90], ["Bestandteile:", 525, 690, 90]),
    row(69, 90, ["Weizengrießkleie", 47, 200, 75], ["4%", 410, 440, 95], ["Phosphor", 450, 520, 95]),
    row(97, 90, ["Calciumcarbonat", 47, 190, 75], ["10%", 410, 445, 95], ["Calcium", 455, 520, 95]),
    row(125, 90, ["Magnesiumoxid", 48, 193, 75], ["2%", 410, 440, 95], ["Magnesium", 450, 540, 95]),
  ]);
  assert.equal(Ocr.textFromResult(data), "Zusammensetzung:\nWeizengrießkleie\nCalciumcarbonat\nMagnesiumoxid\nAnalytische Bestandteile:\n4% Phosphor\n10% Calcium\n2% Magnesium");
  // eine ursprünglich verworfene Rauschzeile bleibt verworfen, auch wenn sie sich teilen ließe
  const noisy = result([
    row(40, 90, ["Zusammensetzung:", 47, 250, 90], ["Analytische", 403, 520, 90], ["Bestandteile:", 525, 690, 90]),
    row(69, 90, ["Weizen", 47, 200, 90], ["4%", 410, 440, 90], ["Phosphor", 450, 520, 90]),
    row(97, 20, ["xq", 47, 90, 20], ["zt", 410, 440, 20]),
  ]);
  assert.equal(Ocr.textFromResult(noisy), "Zusammensetzung:\nWeizen\nAnalytische Bestandteile:\n4% Phosphor");
});

test("zweispaltiges Etikett: eine mittig gesetzte Zeile ohne Spaltenlücke bleibt ganz", () => {
  const rows = Array.from({ length: 16 }, (_, i) => boxed(69 + i * 28, [`Zutat${i}`, 47, 200], [`${i}%`, 410, 440], [`Wert${i}`, 450, 520]));
  const lines = [
    boxed(40, ["Zusammensetzung:", 47, 250], ["Analytische", 403, 520], ["Bestandteile:", 525, 690]),
    ...rows,
    // Fußzeilen über die ganze Breite: die Wortlücke liegt zwar bei der Spaltenlücke, ist aber klein
    boxed(600, ["Charge:", 250, 318], ["4711", 334, 380], ["MHD", 410, 450], ["12/2027", 455, 520]),
    boxed(630, ["Charge:", 250, 318], ["4711", 334, 380]),
  ];
  const result = lineText(Ocr.reorderColumns(lines));
  assert.ok(result.includes("Charge: 4711 MHD 12/2027"), result.join(" | "));
  assert.ok(result.includes("Charge: 4711"), result.join(" | "));
  // die Spalten darüber bleiben getrennt: erst alle Zutaten, dann die Analytik
  assert.equal(result[0], "Zusammensetzung:");
  assert.equal(result[1], "Zutat0");
  assert.equal(result[16], "Zutat15");
  assert.equal(result[17], "Analytische Bestandteile:");
  assert.equal(result[18], "0% Wert0");
});

test("Spaltenreihenfolge ändert einspaltige Etiketten, Tabellen und Zeilen ohne Überschriftenkollision nicht", () => {
  // Tabelle in einer Spalte: Zellen derselben Zeile bleiben zusammen
  const table = [
    boxed(10, ["Zusatzstoffe", 40, 160], ["je", 165, 185], ["kg:", 190, 220]),
    boxed(40, ["625.000", 40, 110], ["I.E.", 120, 150], ["Vitamin", 260, 340], ["A", 345, 360], ["(3a672a)", 520, 600]),
    boxed(68, ["3.000", 60, 110], ["mg", 120, 150], ["Vitamin", 260, 340], ["E", 345, 360], ["(3a700)", 520, 590]),
  ];
  assert.deepEqual(Ocr.reorderColumns(table), table);
  // zwei Überschriften in einer Zeile, aber ohne Lücke zwischen den Spalten: keine Trennung
  const dense = [
    boxed(10, ["Zusammensetzung:", 40, 200], ["Analytische", 205, 300], ["Bestandteile:", 305, 400]),
    boxed(40, ["Weizen", 40, 120], ["4%", 125, 150], ["Protein", 155, 230], ["Mais", 240, 300]),
  ];
  assert.deepEqual(Ocr.reorderColumns(dense), dense);
  // Wörter ohne Position bleiben unverändert
  const plain = [[{ text: "Zusammensetzung:", confidence: 90 }, { text: "Analytische", confidence: 90 }]];
  assert.deepEqual(Ocr.reorderColumns(plain), plain);
});

test("Abschnitte werden vollständig und zeilenweise als Beleg gezeigt (Zusammensetzung, Analytik, Zusatzstoffe)", () => {
  const rules = [
    { id: "art17_003_mineral", severity: "critical", patterns: [{ patternValue: "Zusammensetzung", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] },
    { id: "art17_004_mineral", severity: "critical", patterns: [{ patternValue: "Analytische", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] },
    { id: "art15_006", severity: "warning", patterns: [{ patternValue: "Zusatzstoffe", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] },
  ];
  const text = [
    "Mineralfutter für Rinder",
    "Zusammensetzung:", "Weizengrießkleie", "Calciumcarbonat", "Monocalciumphosphat", "Natriumchlorid", "pflanzliches Fett aus Raps, raffiniert, gehärtet", "",
    "Analytische Bestandteile:", "4% Phosphor", "10% Calcium", "4% Natrium", "2% Magnesium", "",
    "Ernährungsphysiologische Zusatzstoffe (je kg):", "625.000 I.E. Vitamin A (3a672a)", "3.000 mg Vitamin E (3a700)", "",
    "Technologische Zusatzstoffe (je kg):", "1 mg Citronensäure", "100 mg Betahydroxytoluol (E321)", "",
    "Inverkehrbringer: Weissachmühle GmbH, Mühlenstraße 15, 87534 Oberstaufen",
  ].join("\n");
  const [composition, analytic, additives] = Labeling.check(text, FEED_TYPES[2], rules).ruleResults;
  assert.equal(composition.status, "found");
  assert.equal(composition.matchedText, "Zusammensetzung:\nWeizengrießkleie\nCalciumcarbonat\nMonocalciumphosphat\nNatriumchlorid\npflanzliches Fett aus Raps, raffiniert, gehärtet");
  assert.equal(analytic.status, "found");
  assert.equal(analytic.matchedText, "Analytische Bestandteile:\n4% Phosphor\n10% Calcium\n4% Natrium\n2% Magnesium");
  assert.equal(additives.status, "found");
  assert.equal(additives.matchedText, "Ernährungsphysiologische Zusatzstoffe (je kg):\n625.000 I.E. Vitamin A (3a672a)\n3.000 mg Vitamin E (3a700)\n"
    + "Technologische Zusatzstoffe (je kg):\n1 mg Citronensäure\n100 mg Betahydroxytoluol (E321)");
  // Logo- und Siegeltext nach der letzten Messwertzeile gehört nicht zum Abschnitt
  const trailing = Labeling.check("Mineralfutter für Rinder\nZusatzstoffe je kg:\n10 mg Vitamin E\n5 mg Zink\nA VLOG\nAMA-Gütesiegel tauglich", FEED_TYPES[2], rules).ruleResults[2];
  assert.equal(trailing.matchedText, "Zusatzstoffe je kg:\n10 mg Vitamin E\n5 mg Zink");
  // umgebrochene Namen: genau eine Fortsetzungszeile bleibt erhalten, Siegeltext danach nicht
  const rule2 = rules[2];
  const wrapped = (...lines) => Labeling.check(`Mineralfutter für Rinder\nZusatzstoffe je kg:\n${lines.join("\n")}`, FEED_TYPES[2], [rule2]).ruleResults[0].matchedText;
  assert.equal(wrapped("250 mg Vitamin E", "100 mg Vitamin", "A"), "Zusatzstoffe je kg:\n250 mg Vitamin E\n100 mg Vitamin\nA");
  assert.equal(wrapped("250 mg Vitamin E", "100 mg Kupfer als Kupfer-(II)-sulfat,", "pentahydrat"), "Zusatzstoffe je kg:\n250 mg Vitamin E\n100 mg Kupfer als Kupfer-(II)-sulfat,\npentahydrat");
  assert.equal(wrapped("250 mg Vitamin E", "100 mg Vitamin", "A", "AMA-Gütesiegel tauglich"), "Zusatzstoffe je kg:\n250 mg Vitamin E\n100 mg Vitamin\nA");
  assert.equal(wrapped("250 mg Vitamin E", "40 mg Selen als Natriumselenit (3b801)", "A VLOG", "utter, gepru"), "Zusatzstoffe je kg:\n250 mg Vitamin E\n40 mg Selen als Natriumselenit (3b801)");
  // eine fünfstellige Menge mit großgeschriebener Einheit ist keine Postleitzahl
  const fiveDigits = Labeling.check("Mineralfutter für Rinder\nZusatzstoffe je kg:\n25000 IE Vitamin A\n300 mg Vitamin E", FEED_TYPES[2], rules).ruleResults[2];
  assert.equal(fiveDigits.matchedText, "Zusatzstoffe je kg:\n25000 IE Vitamin A\n300 mg Vitamin E");
  // Kontaktzeilen gehören nicht zum Abschnitt
  const withAddress = Labeling.check("Mineralfutter für Rinder\nZusatzstoffe je kg:\n10 mg Vitamin E\nHersteller: Weissachmühle GmbH, 87534 Oberstaufen\n3 mg Eisen", FEED_TYPES[2], rules).ruleResults[2];
  assert.equal(withAddress.matchedText, "Zusatzstoffe je kg:\n10 mg Vitamin E");
});

test("Mengenangaben aus einer Nachbarspalte sind keine Losnummer", () => {
  const rule = { id: "art15_004", severity: "critical", patterns: ["Partie", "Charge", "Lot"].map(patternValue => ({ patternValue, patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 })) };
  const check = text => Labeling.check(`Mineralfutter für Rinder\nZusammensetzung: Calciumcarbonat, Magnesiumoxid\n${text}`, FEED_TYPES[2], [rule]).ruleResults[0];
  for (const text of ["Kennnummer der Partie: 1mg Citronensäure\nSiehe Aufdruck Betahydroxytoluol", "Kennnummer der Partie:\n1mg", "Kennnummer der Partie: 100 mg\nVitamin A",
                      "Chargen-Nr.: 5 g", "Charge: 25 kg", "Lot: 12 %", "Charge: 10 IE", "Kennnummer der Partie: 4711mg"]) {
    assert.equal(check(text).status, "probablyFound", text);
  }
  // echte Losnummern bleiben bestätigt, auch wenn sie so ähnlich beginnen
  for (const text of ["Charge: 4711", "Chargen-Nr.: A12345", "Charge: L 123456", "Lot: 2024-17", "Charge: 240315 MHD 03/2027", "Chargen-Nr.: 12 gelagert", "Charge: 123 g12"]) {
    assert.equal(check(text).status, "found", text);
  }
  // „Kennnummer der Partie: Siehe Aufdruck“ ist ein Verweis auf den Aufdruck
  const reference = check("Kennnummer der Partie:\nSiehe Aufdruck");
  assert.equal(reference.status, "probablyFound");
  assert.match(reference.note, /Verweis auf Aufdruck erkannt/);
});

test("Zeilenweise vermischte Spalten: Zutaten und Analytik werden getrennt belegt", () => {
  const rules = [
    { id: "art17_003_mineral", severity: "critical", patterns: [{ patternValue: "Zusammensetzung", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] },
    { id: "art17_004_mineral", severity: "critical", patterns: [{ patternValue: "Analytische Bestandteile", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] },
  ];
  const label = "Mineralfutter für Rinder\nZusammensetzung: Analytische Bestandteile:\nWeizengrießkleie 4% Phosphor\nCalciumcarbonat 10% Calcium\nMonocalciumphosphat 4% Natrium\nNatriumchlorid 2% Magnesium\nMagnesiumoxid\nRübenmelasse\npflanzliches Fett aus Raps, raffiniert, gehärtet\nErnährungsphysiologische Zusatzstoffe (je kg):\n625.000 I.E. Vitamin A (3a672a)";
  const [composition, analysis] = Labeling.check(label, FEED_TYPES[2], rules).ruleResults;
  assert.equal(composition.status, "found");
  assert.equal(composition.matchedText.split("\n").slice(1).join("|"),
    "Weizengrießkleie|Calciumcarbonat|Monocalciumphosphat|Natriumchlorid|Magnesiumoxid|Rübenmelasse|pflanzliches Fett aus Raps, raffiniert, gehärtet");
  assert.equal(analysis.status, "found");
  assert.equal(analysis.matchedText.split("\n").slice(1).join("|"), "4% Phosphor|10% Calcium|4% Natrium|2% Magnesium");
});

test("Vermischte Spalten: Abschnittsüberschrift beendet die Zutaten, Messwert nach Zutatenzeile ist nicht eindeutig", () => {
  const rule = { id: "art17_003_mineral", severity: "critical", patterns: [{ patternValue: "Zusammensetzung", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] };
  const check = body => Labeling.check(`Mineralfutter für Rinder\nZusammensetzung: Analytische Bestandteile:\n${body}`, FEED_TYPES[2], [rule]).ruleResults[0];
  const heading = check("Weizengrießkleie 4% Phosphor\nCalciumcarbonat 10% Calcium\nFütterungsempfehlung\nRinder 100 g täglich");
  assert.equal(heading.status, "probablyFound");
  assert.match(heading.note, /mehrspaltiges Layout/);
  const interleaved = check("Weizengrießkleie 4% Phosphor\nCalciumcarbonat 10% Calcium\nMagnesiumoxid\nRübenmelasse 4% Natrium\nNatriumchlorid 2% Magnesium");
  assert.equal(interleaved.status, "probablyFound");
  assert.doesNotMatch(interleaved.matchedText, /% Natrium/);
});

test("Vermischte Spalten: Feuchte-Zeile, längere Analytikspalte und unbekannte Zeilen", () => {
  const rule = { id: "art17_003_mineral", severity: "critical", patterns: [{ patternValue: "Zusammensetzung", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] };
  const check = body => Labeling.check(`Mineralfutter für Rinder\nZusammensetzung: Analytische Bestandteile:\n${body}`, FEED_TYPES[2], [rule]).ruleResults[0];
  const head = "Weizengrießkleie 4% Phosphor\nCalciumcarbonat 10% Calcium\nMonocalciumphosphat 4% Natrium\n";
  const moisture = check(`${head}Rübenmelasse 5% Feuchte\nMagnesiumoxid\nNatriumchlorid\nZusatzstoffe (je kg):\n1 mg Vitamin A`);
  assert.equal(moisture.status, "found");
  assert.match(moisture.matchedText, /Rübenmelasse\nMagnesiumoxid|Rübenmelasse$|Rübenmelasse\n/);
  const longer = check(`${head}Magnesiumoxid\nRübenmelasse\n5% Rohasche\n2% Rohfaser\nZusatzstoffe (je kg):\n1 mg Vitamin A`);
  assert.equal(longer.status, "found");
  const unknown = check(`${head}Magnesiumoxid\nRübenmelasse\n**§§ 12 ??\nZusatzstoffe (je kg):`);
  assert.equal(unknown.status, "probablyFound");
});

test("cleanText: Kennnummern werden gegen die bekannte Liste geprüft, nur eindeutige Korrekturen", () => {
  Ocr.setAdditiveCodes(["3b502", "3a502", "3b405", "3a671"]);
  try {
    // 3a502 und 3b502 sind beide bekannt: nicht eindeutig, Text bleibt
    assert.match(Ocr.cleanText("2.500 mg Mangan (30502)"), /\(30502\)/);
    Ocr.setAdditiveCodes(["3b502", "3b405", "3a671"]);
    assert.match(Ocr.cleanText("2.500 mg Mangan (30502)"), /\(3b502\)/);
    assert.match(Ocr.cleanText("Kupfer (3b405) Vitamin D3 (3a671)"), /\(3b405\).*\(3a671\)/);
    assert.match(Ocr.cleanText("Wasser (30999)"), /\(30999\)/);
  } finally {
    Ocr.setAdditiveCodes([]);
  }
});

test("Zusatzstoffe: Überschrift mit Menge ohne Kennnummer bleibt Überschrift, Stoffnamen vor Kennnummern bleiben", () => {
  const rule = { id: "art15_006", severity: "warning", patterns: [{ patternValue: "Zusatzstoffe", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] };
  const check = body => Labeling.check(`Ergänzungsfuttermittel für Pferde.\n${body}`, FEED_TYPES[1], [rule]).ruleResults[0];
  const feeding = check("Zusatzstoffe:\nFütterungsempfehlung: 100 g pro Tier und Tag");
  assert.notEqual(feeding.status, "found");
  const colon = check("Zusatzstoffe:\nVitamin E: 100 mg (3a700)");
  assert.equal(colon.status, "found");
  assert.ok(colon.matchedText.split("\n").includes("Vitamin E: 100 mg (3a700)"));
  const sameLine = check("Zusatzstoffe: Kupfer als Kupfersulfat (3b405)\n10 mg Vitamin E");
  assert.equal(sameLine.status, "found");
  assert.match(sameLine.matchedText, /^Zusatzstoffe: Kupfer als Kupfersulfat \(3b405\)/);
  const foreignCode = check("Zusatzstoffe:\nFütterungsempfehlung pro Tag: 100 g pro Tier und Tag\nKupfer als Kupfersulfat (3b405)");
  assert.notEqual(foreignCode.status, "found");
  assert.doesNotMatch(foreignCode.matchedText ?? "", /^100 g/m);
  const form = check("Zusatzstoffe:\nKupfer in Form von Kupfersulfat: 100 mg (3b405)");
  assert.equal(form.status, "found");
  assert.ok(form.matchedText.split("\n").includes("Kupfer in Form von Kupfersulfat: 100 mg (3b405)"));
  const named = check("Zusatzstoffe:\n10 mg Vitamin E\nKupfer als Kupfersulfat (3b405)");
  assert.equal(named.status, "found");
  assert.ok(named.matchedText.split("\n").includes("Kupfer als Kupfersulfat (3b405)"));
});

test("Zusatzstoffe: Tabellenzeilen mit Nachbarspalten-Text, fehlende Einheit und Kennnummer in der Folgezeile", () => {
  const rule = { id: "art15_006", severity: "warning", patterns: [{ patternValue: "Zusatzstoffe", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] };
  const label = "Mineralfutter für Rinder\nErnährungsphysiologische Zusatzstoffe (je kg):\n625.000 I.E. Vitamin A (3a672a)\nFütterungsempfehlung pro Tag: 90.000 Vitamin D3 (3a671)\nDieses Ergänzungsfutter darf we- 2.000 mg Beta-Carotin (3a160(a))\n2.500 mg Mangan als Mangan-(II)-Oxid\nminen und Spurenelementen an (3b502)\nTechnologische Zusatzstoffe (je kg):\n100 mg Betahydroxytoluol (E321)";
  const result = Labeling.check(label, FEED_TYPES[2], [rule]).ruleResults[0];
  assert.equal(result.status, "found");
  assert.doesNotMatch(result.matchedText, /Fütterungsempfehlung|Dieses Ergänzungsfutter|minen und/);
  for (const row of ["90.000 Vitamin D3 (3a671)", "2.000 mg Beta-Carotin (3a160(a))", "(3b502)", "100 mg Betahydroxytoluol (E321)"]) {
    assert.ok(result.matchedText.split("\n").includes(row), row);
  }
});

test("Zusammensetzung neben einer anderen Überschrift weist auf ein mehrspaltiges Layout hin", () => {
  const rule = { id: "art17_003_mineral", severity: "critical", patterns: [{ patternValue: "Zusammensetzung", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] };
  const result = Labeling.check("Mineralfutter für Rinder\nZusammensetzung: Analytische Bestandteile:\nWeizengrießkleie 4% Phosphor\nCalciumcarbonat 10% Calcium", FEED_TYPES[2], [rule]).ruleResults[0];
  assert.equal(result.status, "probablyFound");
  assert.match(result.note, /mehrspaltiges Layout/);
  const plain = Labeling.check("Mineralfutter für Rinder\nZusammensetzung siehe Rückseite", FEED_TYPES[2], [rule]).ruleResults[0];
  assert.match(plain.note ?? "", /Indirekter Treffer/);
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

test("Diätzwecke Eintrag 72 und 55 für Kälber werden erkannt und zweckbezogen geprüft", () => {
  const field = (result, id) => result.ruleResults.find(r => r.rule.id === `art18_${id}`);
  const prevent = Labeling.check("BEWI-SAN Prevent C\nDiätergänzungsfuttermittel für Aufzuchtkälber\nZur Stabilisierung der physiologischen Verdauung\n"
    + "Darmflorastabilisatoren:\n80 x 10° KBE Enterococcus faecium NCIMB 11181 (4b1708) (Milchsäurebakterium)\n", FEED_TYPES[1], []);
  assert.equal(field(prevent, "purpose").status, "found");
  assert.match(field(prevent, "purpose").matchedText, /Stabilisierung der physiologischen Verdauung/);
  assert.equal(field(prevent, "stabiliser").status, "found");
  assert.match(field(prevent, "stabiliser").matchedText, /KBE Enterococcus faecium NCIMB 11181/);
  assert.equal(field(prevent, "risk_hint").status, "unclear");
  assert.match(field(prevent, "review").note, /Eintrag 72.*vier Wochen/);
  const withHint = Labeling.check("Diätergänzungsfuttermittel für Aufzuchtkälber\nZur Stabilisierung der physiologischen Verdauung.\nDarmflorastabilisatoren: 1 x 10^9 KBE Stamm X\n"
    + "Bei Gefahr von, während oder nach Verdauungsstörungen.", FEED_TYPES[1], []);
  assert.equal(field(withHint, "risk_hint").status, "found");
  // Name oder Menge allein genügen nicht
  const stabiliser = body => field(Labeling.check(`Diätergänzungsfuttermittel für Aufzuchtkälber\nZur Stabilisierung der physiologischen Verdauung.\n${body}`, FEED_TYPES[1], []), "stabiliser");
  for (const body of ["Darmflorastabilisatoren: Enterococcus faecium (KBE)", "Darmflorastabilisatoren: 100 KBE", "Darmflorastabilisatoren: Enterococcus faecium NCIMB 11181",
                      "Darmflorastabilisatoren:\n\n1 x 10^9 KBE Enterococcus faecium",
                      "Darmflorastabilisatoren: 100 KBE\nMindestens haltbar bis: 12.12.2026", "Darmflorastabilisatoren: 100 KBE\nHersteller: Muster GmbH",
                      "Darmflorastabilisator: 100 KBE\nNettogewicht: 400 g", "Darmflorastabilisatoren: Enterococcus faecium\nMHD 12.12.2026 5 KBE"]) {
    assert.equal(stabiliser(body).status, "unclear", body);
  }
  assert.match(stabiliser("Darmflorastabilisatoren: 100 KBE").note, /Bezeichnung/);
  assert.equal(stabiliser("Darmflorastabilisatoren: Enterococcus faecium (4b1708) 5,0 x 10^8 KBE/kg").status, "found");
  assert.equal(stabiliser("Darmflorastabilisatoren:\n1 x 10° KBE Enterococcus faecium").status, "found");
  assert.equal(stabiliser("Darmflorastabilisator: Enterococcus faecium (4b1708) 5,0 x 10^8 KBE/kg").status, "found");
  assert.equal(stabiliser("Darmflorastabilisator: Enterococcus faecium (4b1708) 5,0 x 10^8 KBE/kg\nMindestens haltbar bis: 12.12.2026").status, "found");
  // ohne ausgewiesenen Stabilisator bleibt das Feld offen
  const noStabiliser = Labeling.check("Diätergänzungsfuttermittel für Aufzuchtkälber\nZur Stabilisierung der physiologischen Verdauung.", FEED_TYPES[1], []);
  assert.equal(field(noStabiliser, "stabiliser").status, "unclear");
  const lyt = Labeling.check("BEWI-SAN Bewilyt\nDiätergänzungsfuttermittel für Aufzuchtkälber\nZur Stabilisierung des Wasser- und\nElektrolythaushaltes\n"
    + "Es wird empfohlen, vor der Verfütterung den Rat eines Tierarztes einzuholen.", FEED_TYPES[1], []);
  assert.equal(field(lyt, "purpose").status, "found");
  assert.match(field(lyt, "purpose").matchedText, /Wasser- und Elektrolythaushaltes/);
  assert.equal(field(lyt, "advice").status, "found");
  assert.match(field(lyt, "review").note, /Eintrag 55.*sieben Tagen/);
  // ohne Diätdeklaration entsteht keine Diätprüfung
  const plain = Labeling.check("Ergänzungsfuttermittel für Aufzuchtkälber. Zur Stabilisierung der physiologischen Verdauung.", FEED_TYPES[1], []);
  assert.equal(field(plain, "purpose"), undefined);
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
