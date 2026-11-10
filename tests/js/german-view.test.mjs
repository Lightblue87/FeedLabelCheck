/*
 * Deutsche Textteile aus mehrsprachigen Etiketten (Ocr.germanView).
 * Textgrundlage: Pavo WeightLift, Rückseite (Nutzerfoto, nur der gedruckte Wortlaut).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ocr = require("../../webapp/js/ocr.js");
const Labeling = require("../../webapp/js/labeling.js");

const COMPOSITION = [
  "Samenstelling / Komposition / Composition / Sammensætning / Composition / Composición / Sammansättning / Composizione / Kompozycja / Composição / Složení / Koostumus",
  "NL Luzerne, Rijstevoermeel, Lijnzaad, Biergist, Monocalciumfosfaat, Magnesiumoxide",
  "DE Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid",
  "EN Alfalfa, Rice bran, Linseed, Brewer's yeast, Monocalcium phosphate, Magnesium oxide",
  "DA Lucerne, Risklid, Hørfrø, ølgær, Monocalciumfosfat, Magnesiumoxid",
  "FR Luzerne, Son de riz, Graine de lin, Levure de bière, Phosphate monocalcique, Oxyde de magnésium",
  "CZ Alfalfa, Rýžové otruby, Lněné semeno, Pivovarské kvasnice, Monokalciumfosfát, Oxid hořečnatý",
].join("\n");

test("Zusammensetzung: nur die deutsche Zeile bleibt, die Überschrift ist die deutsche", () => {
  const view = Ocr.germanView(COMPOSITION);
  assert.equal(view, "Komposition: Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid");
  assert.ok(!/Rijstevoermeel|Alfalfa|Levure/.test(view));
});

test("Prüfung belegt die Zusammensetzung mit der deutschen Zeile, nicht mit der Mehrsprachen-Überschrift", () => {
  const feedType = { id: "complete_feed", nameDe: "Alleinfuttermittel", keywordsDe: ["Alleinfuttermittel"] };
  const rule = { id: "art17_003_complete", severity: "critical", patterns: [{
    patternValue: "Zusammensetzung", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] };
  const text = view => `Ergänzungsfuttermittel für Pferde.\n${view}`;
  const raw = Labeling.check(text(COMPOSITION), feedType, [rule]).ruleResults[0];
  const german = Labeling.check(text(Ocr.germanView(COMPOSITION)), feedType, [rule]).ruleResults[0];
  assert.equal(german.status, "found");
  assert.equal(german.matchedText, "Komposition: Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid");
  // Vorher zeigte die Karte die ganze Mehrsprachen-Überschrift.
  assert.match(raw.matchedText, /Samenstelling/);
});

test("Lagerungshinweis und Fütterungstabelle: das deutsche Segment wird gewählt", () => {
  const text = [
    "Bewaaradvies / Lagerungshinweis / Storage advise / Opbevarings anvisning / Conseils de conservation /",
    "Koel, droog en donker bewaren. Na gebruik de verpakking hersluiten. / Kühl, trocken und dunkel lagern. Die",
    "Lichaamsgewicht / Körpergewicht / Body weight",
    "Slank paard / Mageres Pferd / Lean horse",
    "Ondergewicht / Untergewicht / Underweight",
    "Ernstig ondergewicht / Starkes Untergewicht / Severe underweight",
  ].join("\n");
  assert.deepEqual(Ocr.germanView(text).split("\n"), [
    "Lagerungshinweis",
    "Kühl, trocken und dunkel lagern. Die",
    "Körpergewicht",
    "Mageres Pferd",
    "Untergewicht",
    "Starkes Untergewicht",
  ]);
});

test("Unklare Zeilen bleiben unverändert, einsprachiger Text wird nicht angefasst", () => {
  const unclear = "Alfalfa / Rice bran / Linseed";
  assert.equal(Ocr.germanView(unclear), unclear);
  const german = "Zusammensetzung: Hafer, Gerste, Weizen\nAnalytische Bestandteile: Rohprotein 12 %";
  assert.equal(Ocr.germanView(german), german);
  // Ohne deutsche „DE “-Zeile werden Zeilen mit Sprachkürzel nicht verworfen.
  const nl = "NL Luzerne, Lijnzaad, Biergist";
  assert.equal(Ocr.germanView(nl), nl);
});

test("Einsprachige Aufzählungen mit Schrägstrichen bleiben vollständig", () => {
  for (const line of ["Zusammensetzung: Getreide / Mais / Erbsen", "Mais / Erbsen / Futterkalk", "Fütterung: Heu / Stroh / Gras",
                      "Rohprotein / Rohfett / Futterbestandteile"]) {
    assert.equal(Ocr.germanView(line), line, line);
  }
  // Die Zusammensetzungskarte behält alle Zutaten und meldet keinen Mehrsprachen-Filter.
  const text = "Ergänzungsfuttermittel für Pferde.\nZusammensetzung: Getreide / Mais / Erbsen";
  assert.equal(Ocr.germanView(text), text);
});
