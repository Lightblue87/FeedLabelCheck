// Vereinigung mehrerer Lesungen desselben Fotos (Seitenaufteilung, Blocklesung, aufbereitete Kacheln) und die
// Bildaufbereitung je Kachel. Alle Eingaben sind konstruiert; die Fälle bilden Muster nach, die an echten Etiketten
// aufgetreten sind (verschobene Spalten, entartete Wortrahmen, schräg laufende Zeilen, ungleichmäßige Beleuchtung).

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ocr = require("../../webapp/js/ocr.js");

const word = (text, x0, y0, x1, y1, confidence = 92) => ({ text, confidence, bbox: { x0, y0, x1, y1 } });
// Zeile aus Wörtern gleicher Höhe: [text, x0, x1] je Wort
const row = (y, height, ...words) => words.map(([text, x0, x1, confidence]) => word(text, x0, y, x1, y + height, confidence));
const whole = (source, lines, width = 1300, height = 1700) =>
  ({ x: 0, y: 0, right: width, bottom: height, scale: 1, col: 0, row: 0, cols: 1, rows: 1, source, lines });
const texts = lines => lines.map(words => words.map(w => w.text).join(" "));

test("tileGrid: kleine Fotos bleiben ganz, große werden mit Überlappung gekachelt", () => {
  // Kleines Foto: eine vergrößerte Kachel über das ganze Bild
  assert.deepEqual(Ocr.tileGrid(480, 640), [{ col: 0, row: 0, cols: 1, rows: 1, x: 0, y: 0, right: 480, bottom: 640, scale: 2 }]);
  assert.deepEqual(Ocr.tileGrid(1100, 1000), []);
  assert.deepEqual(Ocr.tileGrid(0, 100), []);
  assert.deepEqual(Ocr.tileGrid(NaN, 100), []);
  const tiles = Ocr.tileGrid(2400, 1600);
  assert.equal(tiles.length, 6);
  assert.ok(tiles.every(t => t.cols === 3 && t.rows === 2));
  for (const tile of tiles) {
    assert.ok(tile.x >= 0 && tile.y >= 0 && tile.right <= 2400 && tile.bottom <= 1600);
    assert.ok(tile.scale >= 1 && tile.scale <= 2);
  }
  // Nachbarn überlappen an der Innenkante, die Kacheln decken das ganze Foto.
  const [first, second] = tiles;
  assert.ok(second.x < first.right, "waagerechte Überlappung");
  assert.equal(Math.min(...tiles.map(t => t.x)), 0);
  assert.equal(Math.max(...tiles.map(t => t.right)), 2400);
  assert.equal(Math.max(...tiles.map(t => t.bottom)), 1600);
  // Sehr große Fotos: höchstens drei Kacheln je Seite
  assert.equal(Ocr.tileGrid(8000, 6000).length, 9);
  assert.equal(Ocr.tileGrid(1000, 1000, { cols: 2, rows: 2 }).length, 4);
});

test("mergeTiles: die zweite Lesung ergänzt ein fehlendes Wort am Zeilenende", () => {
  const auto = [row(100, 20, ["Hersteller:", 100, 220], ["Beispiel", 230, 320])];
  const block = [row(100, 20, ["Hersteller:", 100, 220], ["Beispiel", 230, 320], ["GmbH", 330, 390], ["Musterstadt", 400, 520])];
  assert.deepEqual(texts(Ocr.mergeTiles([whole("auto", auto), whole("block", block)])), ["Hersteller: Beispiel GmbH Musterstadt"]);
});

test("mergeTiles: sicherere Lesung ersetzt die unsichere, aber nicht durch weniger Zeichen", () => {
  const auto = [row(100, 20, ["Rohprotein", 100, 220], ["11%", 230, 270, 40], ["Rohfett", 300, 380, 35])];
  const block = [row(100, 20, ["Rohprotein", 100, 220], ["%", 250, 270, 95], ["Rohfaser", 300, 385, 93])];
  // „%“ ersetzt „11%“ nicht; „Rohfaser“ (93) ersetzt das unsichere „Rohfett“ (35).
  assert.deepEqual(texts(Ocr.mergeTiles([whole("auto", auto), whole("block", block)])), ["Rohprotein 11% Rohfaser"]);
});

test("mergeTiles: Rauschzeichen der zweiten Lesung werden nicht ergänzt", () => {
  const auto = [row(100, 20, ["Zusammensetzung:", 100, 300], ["Hafer", 310, 370])];
  const block = [row(100, 20, ["==", 40, 80, 30], ["Zusammensetzung:", 100, 300], ["Hafer", 310, 370], ["ZZ", 400, 430, 20])];
  assert.deepEqual(texts(Ocr.mergeTiles([whole("auto", auto), whole("block", block)])), ["Zusammensetzung: Hafer"]);
});

test("mergeTiles: eine Zeile nur aus der zweiten Lesung braucht zwei sicher gelesene Wörter", () => {
  const auto = [row(100, 20, ["Mineralfutter", 100, 260], ["für", 270, 300], ["Rinder", 310, 390])];
  const block = [
    row(100, 20, ["Mineralfutter", 100, 260], ["für", 270, 300], ["Rinder", 310, 390]),
    row(200, 20, ["Mühlenstraße", 100, 250], ["15", 260, 285]),
    row(300, 20, ["xq", 100, 130, 30]),
  ];
  assert.deepEqual(texts(Ocr.mergeTiles([whole("auto", auto), whole("block", block)])),
    ["Mineralfutter für Rinder", "Mühlenstraße 15"]);
});

test("mergeTiles: einzelne Wörter als Zeile und Rahmen mit Zeilenhöhe bleiben in der ersten Lesung erhalten", () => {
  // Linke Spalte mit Rahmen in Zeilenhöhe (36), rechts kleinere Tabellenwerte (17): beides ist dieselbe Zeile der Lesung.
  const auto = [
    [word("Weizengrießkleie", 112, 237, 336, 273), word("4%", 700, 249, 730, 266), word("Phosphor", 740, 248, 830, 271)],
    [word("Calciumcarbonat", 113, 276, 331, 312), word("10%", 700, 288, 735, 305), word("Calcium", 745, 287, 820, 305)],
    [word("Magnesiumoxid", 114, 398, 300, 426)],
  ];
  const merged = texts(Ocr.mergeTiles([whole("auto", auto), whole("block", auto.map(line => line.map(w => ({ ...w }))))]));
  assert.deepEqual(merged, ["Weizengrießkleie 4% Phosphor", "Calciumcarbonat 10% Calcium", "Magnesiumoxid"]);
});

test("mergeTiles: ein Wort mit entartetem, zu hohem Rahmen bleibt und zieht keine Nachbarzeile an", () => {
  // „max.“ hat in der ersten Lesung einen Rahmen über zwei Zeilen (53 statt 22 hoch).
  const auto = [
    [word("Rinder", 100, 820, 180, 842), word("bis", 193, 820, 227, 842), word("max.", 237, 815, 296, 868), word("8", 307, 821, 320, 842), word("g/kg", 330, 820, 385, 842)],
    row(860, 22, ["nahme", 100, 180], ["gefüttert", 197, 300], ["werden.", 321, 400]),
  ];
  const block = [
    row(820, 22, ["Rinder", 100, 180], ["bis", 193, 227], ["max.", 237, 296], ["8", 307, 320], ["g/kg", 330, 385]),
    row(860, 22, ["nahme", 100, 180], ["gefüttert", 197, 300], ["werden.", 321, 400]),
  ];
  assert.deepEqual(texts(Ocr.mergeTiles([whole("auto", auto), whole("block", block)])),
    ["Rinder bis max. 8 g/kg", "nahme gefüttert werden."]);
});

test("mergeTiles: Zeilen derselben Lesung werden nie miteinander verbunden", () => {
  // In der ersten Lesung trägt die obere Zeile ein unsicheres Bruchstück auf der Höhe der nächsten Zeile der rechten
  // Spalte (die rechte Spalte steht eine halbe Zeile tiefer).
  const auto = [
    [word("Einschließlich", 100, 908, 270, 930), word("Vitamine", 282, 909, 395, 930), word("mind.", 408, 908, 470, 930), word("Kß", 775, 934, 830, 952, 0)],
    [word("mg", 711, 940, 745, 957), word("Selen", 788, 940, 850, 952), word("als", 966, 940, 1000, 952), word("Natriumselenit", 1018, 937, 1200, 952)],
    row(947, 22, ["haltbar", 100, 190], ["bis:", 201, 245], ["Siehe", 253, 320], ["Aufdruck", 331, 430]),
  ];
  const merged = texts(Ocr.mergeTiles([whole("auto", auto)]));
  assert.equal(merged.length, 3);
  assert.ok(merged.includes("mg Selen als Natriumselenit"));
  assert.ok(merged.includes("haltbar bis: Siehe Aufdruck"));
});

test("mergeTiles: bei mehreren Wörtern an einer Stelle gewinnt das gleich gelesene Gegenstück", () => {
  const auto = [
    [word("Einschließlich", 100, 908, 270, 930), word("mind.", 408, 908, 470, 930), word("Kß", 775, 934, 840, 952, 0)],
    [word("mg", 711, 940, 745, 957), word("Selen", 788, 940, 850, 952), word("als", 966, 940, 1000, 952)],
  ];
  // Die Blocklesung mischt linke und rechte Spalte in einer Zeile.
  const block = [[word("Einschließlich", 100, 908, 270, 930), word("mind.", 408, 908, 470, 930)],
                 [word("mg", 711, 940, 745, 957), word("Selen", 780, 936, 850, 952, 95), word("als", 966, 940, 1000, 952)]];
  const merged = texts(Ocr.mergeTiles([whole("auto", auto), whole("block", block)]));
  assert.ok(merged.includes("mg Selen als"), merged.join(" | "));
  assert.equal(merged.filter(line => line.includes("Selen")).length, 1, "„Selen“ landet nicht zusätzlich in der oberen Zeile");
});

test("mergeTiles: ein Wort auf anderer Höhe wird nicht in die Zeile des Nachbarn gezogen", () => {
  // Die Blocklesung fasst „(3b502)“ aus der Zeile darüber mit der Zeile „… Spurenelementen an“ zusammen.
  const auto = [row(781, 22, ["minen", 100, 180], ["und", 190, 235], ["Spurenelementen", 247, 480], ["an", 489, 515])];
  const block = [[...row(781, 22, ["minen", 100, 180], ["und", 190, 235], ["Spurenelementen", 247, 480], ["an", 489, 515]),
                  word("(3b502)", 530, 760, 620, 782)]];
  assert.deepEqual(texts(Ocr.mergeTiles([whole("auto", auto), whole("block", block)])), ["minen und Spurenelementen an"]);
});

test("mergeTiles: vertauschte Blockfolge in einer Spalte wird von oben nach unten geordnet, Spalten bleiben getrennt", () => {
  const auto = [
    row(100, 22, ["Linke", 100, 180], ["Spalte", 190, 270], ["oben", 280, 340]),
    row(300, 22, ["Siehe", 100, 170], ["Aufdruck", 180, 290]),
    row(200, 22, ["Kennnummer", 100, 280], ["der", 286, 330], ["Partie:", 338, 430]),
    // Rechte Spalte folgt in der Blockfolge nach der linken, obwohl sie weiter oben beginnt.
    row(90, 22, ["Rechte", 700, 790], ["Spalte", 800, 880], ["oben", 890, 950]),
    row(190, 22, ["Rechte", 700, 790], ["Spalte", 800, 880], ["unten", 890, 960]),
  ];
  assert.deepEqual(texts(Ocr.mergeTiles([whole("auto", auto)])), [
    "Linke Spalte oben", "Kennnummer der Partie:", "Siehe Aufdruck", "Rechte Spalte oben", "Rechte Spalte unten",
  ]);
});

test("mergeTiles: Kacheln – Zeile über die Naht, abgeschnittene Wörter an der Innenkante entfallen", () => {
  const [left, right] = Ocr.tileGrid(2000, 600, { cols: 2, rows: 1 });
  assert.ok(right.x < left.right);
  const scaleL = left.scale;
  const scaleR = right.scale;
  const inLeft = (text, x0, x1, y = 100, conf = 92) => word(text, (x0 - left.x) * scaleL, y * scaleL, (x1 - left.x) * scaleL, (y + 24) * scaleL, conf);
  const inRight = (text, x0, x1, y = 100, conf = 92) => word(text, (x0 - right.x) * scaleR, (y - right.y) * scaleR, (x1 - right.x) * scaleR, (y + 24 - right.y) * scaleR, conf);
  const tiles = [
    { ...left, source: "tiles", lines: [[inLeft("Luzerne,", 600, 720), inLeft("Reiskleie,", 730, 860), inLeft("Leinsaat,", 930, 1040), inLeft("Bier", 1050, left.right - 1)]] },
    { ...right, source: "tiles", lines: [[inRight("saat,", right.x + 1, 1040), inRight("Bierhefe,", 1050, 1160), inRight("Magnesiumoxid", 1170, 1360)]] },
  ];
  // „Bier“ (links abgeschnitten) und „saat,“ (rechts abgeschnitten) entfallen, die Zeile wird an der Naht fortgesetzt.
  assert.deepEqual(texts(Ocr.mergeTiles(tiles)), ["Luzerne, Reiskleie, Leinsaat, Bierhefe, Magnesiumoxid"]);
});

test("mergeTiles: Kacheln – bei schräg laufender Zeile zählt die gemessene Neigung der Kachel", () => {
  const [left, right] = Ocr.tileGrid(2000, 600, { cols: 2, rows: 1 });
  const slope = Math.tan(3 * Math.PI / 180);
  const at = (tile, text, x0, x1) => {
    const y = 100 + (x0 + x1) / 2 * slope;
    return word(text, (x0 - tile.x) * tile.scale, (y - tile.y) * tile.scale, (x1 - tile.x) * tile.scale, (y + 24 - tile.y) * tile.scale);
  };
  const lines = angle => [
    { ...left, angle, source: "tiles", lines: [[at(left, "Leinsaat,", 800, 920), at(left, "Bierhefe,", 960, 1060)]] },
    { ...right, angle, source: "tiles", lines: [[at(right, "Bierhefe,", 960, 1060), at(right, "Monocalciumphosphat,", 1080, 1400), at(right, "Magnesiumoxid", 1420, 1620)]] },
  ];
  assert.deepEqual(texts(Ocr.mergeTiles(lines(3))), ["Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid"]);
  // Ohne Angabe der Neigung liegen die neuen Wörter scheinbar auf anderer Höhe und werden nicht angehängt.
  assert.deepEqual(texts(Ocr.mergeTiles(lines(0))), ["Leinsaat, Bierhefe,"]);
});

test("linesQuality und textFromLines", () => {
  const lines = [row(100, 20, ["Zusammensetzung:", 100, 300], ["Hafer,", 310, 370], ["Gerste", 380, 450], ["ab", 460, 480], ["unsicher", 500, 600, 50])];
  // Buchstaben in Wörtern mit mindestens drei Buchstaben und Sicherheit ab 75: 15 + 5 + 6
  assert.equal(Ocr.linesQuality(lines), 26);
  assert.equal(Ocr.linesQuality([]), 0);
  assert.equal(Ocr.textFromLines(lines), "Zusammensetzung: Hafer, Gerste ab unsicher");
  assert.equal(Ocr.textFromLines([]), "");
});

test("flattenIllumination: Helligkeitsverlauf wird ausgeglichen, Schrift bleibt dunkel", () => {
  const width = 240;
  const height = 120;
  const gray = new Uint8ClampedArray(width * height);
  // Hintergrund von 90 (links) bis 230 (rechts); dunkle Schriftstriche jeweils 60 unter dem Hintergrund.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const background = 90 + 140 * x / (width - 1);
    const ink = y % 12 < 2 && x % 7 < 2;
    gray[y * width + x] = background - (ink ? 60 : 0);
  }
  const { flat, spread } = Ocr.flattenIllumination(gray, width, height);
  assert.ok(spread > 80, `Spanne des Hintergrunds ${spread}`);
  const at = (x, y) => flat[y * width + x];
  // Hintergrund links und rechts liegt nach dem Ausgleich nah beieinander, vorher 140 auseinander.
  assert.ok(Math.abs(at(20, 6) - at(220, 6)) < 25, `${at(20, 6)} gegen ${at(220, 6)}`);
  // Schrift ist links wie rechts deutlich dunkler als ihr Hintergrund.
  assert.ok(at(21, 6) - at(21, 0) > 60 && at(217, 6) - at(217, 0) > 60, `${at(21, 0)} ${at(21, 6)} ${at(217, 0)} ${at(217, 6)}`);
  const even = Ocr.flattenIllumination(new Uint8ClampedArray(width * height).fill(200), width, height);
  assert.ok(even.spread <= 2);
});

function stripes(width, height, degrees) {
  const gray = new Uint8ClampedArray(width * height).fill(220);
  const slope = Math.tan(degrees * Math.PI / 180);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const line = y - (x - width / 2) * slope;
    if (((line % 28) + 28) % 28 < 9 && x % 5 < 3) gray[y * width + x] = 40;
  }
  return gray;
}

test("estimateSkew: Neigung der Zeilen, positiv bei nach rechts abfallenden Zeilen", () => {
  assert.equal(Ocr.estimateSkew(stripes(840, 600, 0), 840, 600), 0);
  const falling = Ocr.estimateSkew(stripes(840, 600, 3), 840, 600);
  assert.ok(Math.abs(falling - 3) <= 0.5, `gemessen ${falling}`);
  const rising = Ocr.estimateSkew(stripes(840, 600, -2.5), 840, 600);
  assert.ok(Math.abs(rising + 2.5) <= 0.5, `gemessen ${rising}`);
  // Auch ein deutlich schräg gehaltener Aufdruck (Streifen am Kartonrand)
  const steep = Ocr.estimateSkew(stripes(840, 600, -13), 840, 600);
  assert.ok(Math.abs(steep + 13) <= 0.75, `gemessen ${steep}`);
  // Leere Fläche und zu kleine Bilder: keine Aussage
  assert.equal(Ocr.estimateSkew(new Uint8ClampedArray(840 * 600).fill(200), 840, 600), 0);
  assert.equal(Ocr.estimateSkew(new Uint8ClampedArray(30 * 30), 30, 30), 0);
});

test("unrotateBox: rechnet Wortrahmen aus dem gerade gerichteten Bild zurück", () => {
  const box = { x0: 700, x1: 800, y0: 290, y1: 310 };
  assert.equal(Ocr.unrotateBox(box, 0, 1000, 600), box);
  // Mitte bleibt die Mitte.
  const center = Ocr.unrotateBox({ x0: 450, x1: 550, y0: 290, y1: 310 }, 4, 1000, 600);
  assert.ok(Math.abs((center.x0 + center.x1) / 2 - 500) < 1e-9 && Math.abs((center.y0 + center.y1) / 2 - 300) < 1e-9);
  // Zeilen fallen nach rechts ab (positiver Winkel): ein Wort rechts der Mitte liegt im Foto tiefer.
  const back = Ocr.unrotateBox(box, 4, 1000, 600);
  const expectedY = 300 + 250 * Math.sin(4 * Math.PI / 180);
  assert.ok(Math.abs((back.y0 + back.y1) / 2 - expectedY) < 1e-9);
  assert.ok((back.x0 + back.x1) / 2 < 750);
  assert.ok(Math.abs((back.x1 - back.x0) - 100) < 1e-9 && Math.abs((back.y1 - back.y0) - 20) < 1e-9, "Größe bleibt erhalten");
});

// ── Randspalte neben Fließtext ──
// Wörter einer Zeile aus Text: jedes Zeichen 10 breit, Wortabstand 8, ab x.
function words(text, x, y, height = 20) {
  const out = [];
  for (const part of text.split(" ")) {
    out.push(word(part, x, y, x + part.length * 10, y + height));
    x += part.length * 10 + 8;
  }
  return out;
}
const withSide = (left, right, y, sideX = 760) => [...(left ? words(left, 60, y) : []), ...(right ? words(right, sideX, y) : [])];

test("textFromLines: schmale Randspalte neben Fließtext wird abgetrennt", () => {
  const lines = [
    withSide("Zusammensetzung: Putenfleisch 95 % und Karotte", null, 100),
    withSide("und Zucchini sowie gemahlene Eierschalen und Meersalz", "Inhaltsstoffe", 130),
    withSide("Fütterungsempfehlung: ca. 4 % des Körpergewichts täglich", "Rohasche 1,45%", 160),
    withSide("und Gemüse entsteht. Da wir keine Bindemittel", "Feuchtigkeit 73,7%", 190),
    withSide("der natürliche Sud bleibt erhalten und wird gefüttert", null, 220),
    withSide("Damit Ihre Katze auch genug trinkt", "Mindesthaltbarkeitsdatum,", 250),
    withSide("Vertrieb: Beispiel GmbH & Co. KG, Musterstraße 4,", "Bezugsnummer der Partie:", 280),
    withSide("40233 Düsseldorf", "siehe Dosenaufdruck.", 310),
  ];
  const text = Ocr.textFromLines(lines).split("\n");
  assert.ok(text.includes("40233 Düsseldorf"), text.join(" | "));
  assert.ok(text.includes("siehe Dosenaufdruck."));
  assert.ok(text.includes("Vertrieb: Beispiel GmbH & Co. KG, Musterstraße 4,"));
  // Die Randspalte folgt geschlossen nach dem linken Text.
  assert.equal(text.indexOf("siehe Dosenaufdruck."), text.indexOf("Bezugsnummer der Partie:") + 1);
  assert.ok(text.indexOf("Inhaltsstoffe") > text.indexOf("40233 Düsseldorf"));
});

test("textFromLines: die Randspalte läuft nach einer Unterbrechung an derselben Stelle weiter", () => {
  const head = [
    withSide("zur täglichen Fütterung gut geeignet", "Hersteller:", 100),
    withSide("langsam und in Ruhe anfüttern", "Beispiel GmbH & Co. KG", 130),
    withSide("Analytische Bestandteile der Mischung sind", "Musterweg 27", 160),
    withSide("Rohprotein und Rohfett sowie Rohfaser gemessen", "info@beispiel.example", 190),
  ];
  // Eine Zeile über die ganze Breite beendet die erste Folge.
  const across = words("Zur Mineralstoffversorgung empfehlen wir ein zu Ihrem Pferd und seinem Bedarf passendes Mineralfutter", 60, 220);
  const tail = [
    withSide("Die analysierten Werte sind nativen Ursprungs und nicht zugesetzt", "Chargennummer", 250),
    withSide("Zucker ist rein nativ enthalten und nicht zugesetzt", "01102000040327", 280),
  ];
  const text = Ocr.textFromLines([...head, across, ...tail]).split("\n");
  assert.equal(text[text.indexOf("Chargennummer") + 1], "01102000040327", text.join(" | "));
  assert.ok(text.includes("Zucker ist rein nativ enthalten und nicht zugesetzt"));
  // Ohne vorangehende Randspalte genügen zwei Zeilen nicht.
  assert.equal(Ocr.textFromLines(tail).split("\n")[1], "Zucker ist rein nativ enthalten und nicht zugesetzt 01102000040327");
});

test("textFromLines: Tabellen aus Name und Wert und kurze Folgen bleiben zusammen", () => {
  const table = [
    withSide("Rohprotein", "17,8 %", 100), withSide("Rohfett", "5,68 %", 130), withSide("Rohfaser", "2,28 %", 160),
    withSide("Rohasche", "1,45 %", 190), withSide("Feuchtigkeit", "73,7 %", 220),
  ];
  assert.deepEqual(Ocr.textFromLines(table).split("\n"),
    ["Rohprotein 17,8 %", "Rohfett 5,68 %", "Rohfaser 2,28 %", "Rohasche 1,45 %", "Feuchtigkeit 73,7 %"]);
  // Fließtext mit Zahlenspalte rechts (Fütterungstabelle): rechts steht kein Text.
  const amounts = [
    withSide("Katzen bis drei Kilogramm Gewicht", "200 g", 100), withSide("Katzen bis vier Kilogramm Gewicht", "245 g", 130),
    withSide("Katzen bis fünf Kilogramm Gewicht", "280 g", 160), withSide("Katzen bis sechs Kilogramm Gewicht", "310 g", 190),
  ];
  assert.equal(Ocr.textFromLines(amounts).split("\n")[0], "Katzen bis drei Kilogramm Gewicht 200 g");
  // Nur drei Zeilen mit Lücke: zu wenig für eine Randspalte.
  const few = [
    withSide("Zusammensetzung: Hafer und Gerste sowie Leinsaat", "Hersteller:", 100),
    withSide("Analytische Bestandteile der Mischung im Sack", "Beispiel GmbH", 130),
    withSide("Rohprotein und Rohfett sowie Rohfaser gemessen", "Musterweg 27", 160),
  ];
  assert.equal(Ocr.textFromLines(few).split("\n")[0], "Zusammensetzung: Hafer und Gerste sowie Leinsaat Hersteller:");
});

test("uprightLines: hochkant gelesene Zeilen der Seitenaufteilung bleiben außen vor", () => {
  const upright = row(100, 20, ["Alleinfuttermittel", 100, 300], ["für", 310, 340], ["Katzen", 350, 420]);
  const sideways = [word("Zusammensetzung", 500, 100, 522, 300), word("Fleisch", 500, 310, 522, 390), word("%", 500, 400, 522, 412)];
  assert.deepEqual(Ocr.uprightLines([upright, sideways]), [upright]);
  // Kurze Wörter und Zeilen ohne lange Wörter entscheiden nichts.
  const short = [word("8", 100, 100, 110, 122), word("g", 120, 100, 130, 122)];
  assert.deepEqual(Ocr.uprightLines([short]), [short]);
});

test("mergeTiles: sicher gelesenes Wort ersetzt das fast gleiche unsichere, doppelte Lesung an einer Stelle entfällt", () => {
  // Vollbild: „HD“ unsicher und das Datum als Zahlensalat mit entartetem Rahmen. Kachel: „MHD 03/2028“ sicher.
  const full = [[word("HD", 359, 1090, 480, 1130, 39), word("0312075", 512, 1032, 760, 1158, 58), word("S17", 830, 1088, 930, 1128, 80)]];
  const tile = [[word("MHD", 356, 1088, 480, 1130, 89), word("03/2028", 506, 1090, 760, 1130, 96)]];
  const merged = texts(Ocr.mergeTiles([whole("block", full, 1512, 2016), { ...whole("tiles", tile, 1512, 2016), angle: 0 }]));
  assert.deepEqual(merged, ["MHD 03/2028 S17"]);
});

test("mergeTiles: die sicherere Lesung ersetzt nicht, wenn sie ein Zeichen verliert", () => {
  const first = [row(100, 20, ["Proteine", 100, 200], ["11%", 210, 250, 70], ["Fettgehalt", 270, 380])];
  const second = [row(100, 20, ["Proteine", 100, 200], ["11", 210, 238, 93], ["Fettgehalt", 270, 380])];
  assert.deepEqual(texts(Ocr.mergeTiles([whole("block", first), whole("auto", second)])), ["Proteine 11% Fettgehalt"]);
});
