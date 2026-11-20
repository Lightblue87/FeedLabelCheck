// Nachlesen des deutschen Deklarationsabsatzes auf mehrsprachigen Beuteln. Vorlage: Pets Deli Silky Cream (Nutzerfoto
// vom 20.11.2026, bleibt lokal). Die Fälle sind konstruiert und bilden Aufbau und Fehlerbild der ersten Lesung nach:
// englische Kopfzeile, deutscher Absatz über die ganze Breite (zerlesen, nur Zeilenanfänge und Bruchstücke am rechten
// Rand), danach der englische Absatz „Complete feed for cats“.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ocr = require("../../webapp/js/ocr.js");

// Zeile aus Text ab x0 auf Höhe y; Wörter 14 px je Zeichen breit, 26 px hoch.
function line(text, x0, y, { confidence = 85, height = 26, slope = 0 } = {}) {
  let x = x0;
  return text.split(" ").map(part => {
    const x1 = x + part.length * 14;
    const dy = (x - x0) * slope;
    const word = { text: part, confidence, bbox: { x0: x, x1, y0: y + dy, y1: y + dy + height } };
    x = x1 + 12;
    return word;
  });
}

const firstReading = () => [
  line("NO GRAINS OR SUGAR", 200, 200),
  line("COLOURANTS OR FILLERS", 200, 250),
  line("CB für Katzen /", 200, 400),
  line("Getrocknetes Ei, 3%", 200, 444),
  line("nalytische Bestandteile! Rohprotein 12,5%, Rohfett 4%", 200, 488, { confidence: 60 }),
  line("eSetzstoffe:; Emährungsphy-", 2350, 532, { confidence: 40 }),
  line("MO, als Kaliumjodid 09", 200, 576, { confidence: 55 }),
  line("Zinkchelat von Glycinhyarat 17,5 mg,", 200, 620, { confidence: 70 }),
  line("14mg Lagerung Kühlund trocken", 200, 664),
  line("reichend frisches Trinkwasser zur Verfügung", 200, 708),
  line("Complete feed for cats | Composition 40% broth", 200, 790),
  line("fat 4%, crude fibre 0.5%, crude ash 3%", 200, 834),
];

test("germanBlockRegion: findet den deutschen Absatz zwischen englischer Kopfzeile und englischem Absatz", () => {
  const region = Ocr.germanBlockRegion(firstReading(), 3024, 4032);
  assert.ok(region, "Absatz erkannt");
  assert.ok(region.y < 400 && region.y > 276, `oben vor „für Katzen“, nach der Kopfzeile (${region.y})`);
  assert.ok(region.bottom > 734 && region.bottom < 790, `unten nach „Trinkwasser“, vor „Complete feed“ (${region.bottom})`);
  // Das Bruchstück am rechten Rand bestimmt die Breite, nicht die kurzen Zeilenanfänge.
  assert.ok(region.right > 2700, `rechter Rand ${region.right}`);
  assert.ok(region.x < 200);
});

test("germanBlockRegion: kein Absatz ohne mindestens zwei Zeilen mit deutschen Deklarationswörtern", () => {
  const lines = [
    line("NO GRAINS OR SUGAR", 200, 200),
    line("für Katzen", 200, 400),
    line("Lagerung kühl und trocken", 200, 444),
    line("Complete feed for cats", 200, 520),
  ];
  assert.equal(Ocr.germanBlockRegion(lines, 3024, 4032), null);
});

test("germanBlockRegion: Zeilen mit mehreren Sprachen (Zusammensetzung / Samenstelling) starten keinen Absatz", () => {
  const lines = [
    line("Zusammensetzung / Samenstelling / Composition: Luzerne, Reiskleie", 100, 200),
    line("Analytische Bestandteile / Analytical constituents: Rohprotein 16,5%", 100, 244),
    line("Zusatzstoffe / Additives: Vitamin A 10.000 IE", 100, 288),
  ];
  assert.equal(Ocr.germanBlockRegion(lines, 3000, 2000), null);
});

test("regionTiles: breiter Absatz in drei überlappende Streifen, vergrößert bis zur Zielhöhe", () => {
  const region = { x: 126, y: 444, right: 2756, bottom: 1061, lineHeight: 61, rows: 12 };
  const tiles = Ocr.regionTiles(region);
  assert.equal(tiles.length, 3);
  assert.equal(tiles[0].x, 126);
  assert.equal(tiles[2].right, 2756);
  for (let i = 1; i < tiles.length; i++) assert.ok(tiles[i].x < tiles[i - 1].right, "Streifen überlappen");
  for (const t of tiles) {
    assert.ok(t.scale > 1.4 && t.scale <= 3, `Vergrößerung ${t.scale}`);
    assert.ok((t.right - t.x) * (t.bottom - t.y) * t.scale ** 2 <= 12e6 + 1, "Canvas-Grenze");
  }
  // Schmaler Absatz: ein Streifen; große Schrift: keine Vergrößerung
  const narrow = Ocr.regionTiles({ x: 0, y: 0, right: 600, bottom: 500, lineHeight: 120, rows: 4 });
  assert.equal(narrow.length, 1);
  assert.equal(narrow[0].scale, 1);
});

// Physische Zeile auf dem Foto: Wörter ab x0, Höhe folgt der Wölbung y(x). Ein Streifen „liest“ die Wörter in seinem
// Bereich; ein über den Rand ragendes Wort nur bis zum Rand (gekürzter Text, Rahmen bis zur Kante).
function physical(text, x0, curve) {
  let x = x0;
  return text.split(" ").map(part => {
    const x1 = x + part.length * 14;
    const word = { text: part, x0: x, x1, y: curve((x + x1) / 2) };
    x = x1 + 12;
    return word;
  });
}
function readStrip(col, cols, x, right, physicalLines, scale = 2) {
  const lines = physicalLines.map(words => words.filter(w => w.x1 > x && w.x0 < right).map(w => {
    const x0 = Math.max(w.x0, x), x1 = Math.min(w.x1, right);
    const text = w.text.slice(Math.round((x0 - w.x0) / 14), Math.round((x1 - w.x0) / 14)) || w.text[0];
    return { text, confidence: 88, bbox: { x0: (x0 - x) * scale, x1: (x1 - x) * scale, y0: (w.y - 400) * scale, y1: (w.y + 26 - 400) * scale } };
  })).filter(words => words.length);
  return { col, row: 0, cols, rows: 1, x, y: 400, right, bottom: 800, scale, lines };
}

test("stitchStrips: gebogene Zeilen bleiben über die Nähte zusammen, auch wenn jeder Streifen anders geneigt ist", () => {
  // Zeilenabstand 44 px. Nach rechts fallen die Zeilen immer stärker ab (Wölbung): am rechten Rand liegt Zeile 1 tiefer
  // als Zeile 2 am linken Rand. Ein gemeinsamer Neigungswinkel würde die Zeilen vertauschen.
  const curve = base => x => base + ((x - 100) / 1000) ** 2 * 40;
  const text1 = "Alleinfuttermittel für Katzen / Zusammensetzung 40% Brühe, 31,3% Thunfisch, 18,8% Makrele, 3,6% Getrocknetes Ei, 3% Sonnenblumenöl, 1,2%";
  const text2 = "Kartoffelstärke, Mineralstoffe Analytische Bestandteile Rohprotein 12,5%, Rohfett 4%, Rohfaser 0,5%, Rohasche 3%, Feuchtigkeit 80% Zusatzstoffe:";
  const physicalLines = [physical(text1, 110, curve(450)), physical(text2, 110, curve(494))];
  // Streifen wie regionTiles: Schrittweite 900, Überlappung 20 % je Innenkante
  const tiles = [readStrip(2, 3, 1720, 2800, physicalLines), readStrip(0, 3, 100, 1180, physicalLines), readStrip(1, 3, 820, 2080, physicalLines)];
  const rows = Ocr.stitchStrips(tiles).map(words => words.map(w => w.text).join(" "));
  assert.deepEqual(rows, [text1, text2]);
});

test("stitchStrips: Zeilen ohne Gegenstück bleiben erhalten, angeschnittene Wörter werden nicht verdoppelt", () => {
  const flat = base => () => base;
  const physicalLines = [
    physical("Lagerung kühl und trocken lagern. Nach dem Öffnen im Kühlschrank lagern und zügig verbrauchen.", 300, flat(450)),
    physical("Fußnote", 1500, flat(700)),
  ];
  const rows = Ocr.stitchStrips([readStrip(0, 2, 0, 1200, physicalLines), readStrip(1, 2, 800, 2000, physicalLines)])
    .map(words => words.map(w => w.text).join(" "));
  assert.deepEqual(rows, ["Lagerung kühl und trocken lagern. Nach dem Öffnen im Kühlschrank lagern und zügig verbrauchen.", "Fußnote"]);
});

test("stitchStrips: an der Naht gewinnt die deutlich sicherere Lesung desselben Wortes", () => {
  // Streifen 1 liest „Nährstoffschwankungen.“ sicher (Rahmen bis in die Überlappung), Streifen 2 dieselbe Stelle als Unsinn.
  const word = (text, x0, x1, y, confidence) => ({ text, confidence, bbox: { x0, x1, y0: y - 13, y1: y + 13 } });
  const toStrip = (col, x, right, words) => ({ col, row: 0, cols: 2, rows: 1, x, y: 0, right, bottom: 1000, scale: 1,
    lines: [words.map(w => ({ ...w, bbox: { x0: w.bbox.x0 - x, x1: w.bbox.x1 - x, y0: w.bbox.y0, y1: w.bbox.y1 } }))] });
  const left = toStrip(0, 400, 1033, [word("natürlichen", 531, 661, 452, 93), word("Nährstoffschwankungen.", 672, 1029, 464, 87)]);
  const right = toStrip(1, 854, 1400, [word("ANSEHEN", 972, 1125, 483, 0), word("Futtermengen", 1133, 1282, 489, 80), word("sind", 1289, 1329, 499, 95)]);
  const rows = Ocr.stitchStrips([left, right]).map(words => words.map(w => w.text).join(" "));
  assert.deepEqual(rows, ["natürlichen Nährstoffschwankungen. Futtermengen sind"]);
});

test("replaceRegionLines: ersetzt den Absatz nur bei deutlich besserer Lesung, übrige Zeilen bleiben an ihrem Platz", () => {
  const lines = firstReading();
  const region = Ocr.germanBlockRegion(lines, 3024, 4032);
  const better = [
    line("Alleinfuttermittel für Katzen / Zusammensetzung 40% Brühe, 31,3% Thunfisch, 18,8% Makrele", 200, 400, { confidence: 90 }),
    line("Getrocknetes Ei, 3% Sonnenblumenöl, 1,2% Kartoffelstärke, Mineralstoffe Analytische Bestandteile", 200, 444, { confidence: 90 }),
    line("Rohprotein 12,5%, Rohfett 4%, Rohfaser 0,5%, Rohasche 3%, Feuchtigkeit 80%", 200, 488, { confidence: 90 }),
    line("Lagerung kühl und trocken lagern. Bitte stelle immer ausreichend frisches Trinkwasser zur Verfügung", 200, 708, { confidence: 90 }),
  ];
  const replaced = Ocr.replaceRegionLines(lines, better, region);
  assert.ok(replaced, "deutlich bessere Lesung übernommen");
  const texts = replaced.map(words => words.map(w => w.text).join(" "));
  assert.equal(texts[0], "NO GRAINS OR SUGAR");
  assert.equal(texts[1], "COLOURANTS OR FILLERS");
  assert.match(texts[2], /^Alleinfuttermittel für Katzen/);
  assert.equal(texts.at(-2), "Complete feed for cats | Composition 40% broth");
  assert.ok(!texts.some(t => t.startsWith("CB für Katzen")), "alte Lesung des Absatzes entfernt");
  assert.ok(!texts.some(t => t.includes("eSetzstoffe")), "Bruchstück am rechten Rand entfernt");

  // Kaum besser: alte Lesung bleibt
  const similar = [line("für Katzen / Getrocknetes Ei", 200, 400, { confidence: 90 })];
  assert.equal(Ocr.replaceRegionLines(lines, similar, region), null);
});

// Zusammensetzung ohne Doppelpunkt direkt hinter der Futtermittelart (Pets Deli): „Zusammensetzung 40% Brühe, …“.
const Labeling = require("../../webapp/js/labeling.js");
const compositionRule = { id: "art17_003_complete", severity: "critical", patterns: [{
  patternValue: "Zusammensetzung", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] };
const completeFeed = { id: "complete_feed", nameDe: "Alleinfuttermittel", keywordsDe: ["Alleinfuttermittel"] };

test("Zusammensetzung ohne Doppelpunkt mit Prozentanteil dahinter gilt als gefunden, bis zur nächsten Überschrift", () => {
  const text = [
    "Alleinfuttermittel für Katzen / Zusammensetzung 40% Brühe, 31,3% Thunfisch, 18,8% Makrele, 3,6%",
    "Getrocknetes Ei, 3% Sonnenblumenöl, 1,2% Kartoffelstärke, Mineralstoffe Analytische Bestandteile Roh-",
    "protein 12,5%, Rohfett 4%, Rohfaser 0,5%, Rohasche 3%, Feuchtigkeit 80%",
  ].join("\n");
  const result = Labeling.check(text, completeFeed, [compositionRule]).ruleResults[0];
  assert.equal(result.status, "found");
  assert.match(result.matchedText, /^Zusammensetzung 40% Brühe, 31,3% Thunfisch, .*1,2% Kartoffelstärke, Mineralstoffe$/);
});

test("Mehrsprachige Überschrift ohne Prozentanteil zählt nicht als Zusammensetzung ohne Doppelpunkt", () => {
  const text = "Alleinfuttermittel für Katzen\nZusammensetzung / Composition / Samenstelling\nRohprotein 12,5%";
  const result = Labeling.check(text, completeFeed, [compositionRule]).ruleResults[0];
  assert.notEqual(result.status, "found");
});
