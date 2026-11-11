/*
 * ocr.js – Nachbearbeitung der OCR-Ergebnisse (tesseract.js) für den
 * Kennzeichnungs-Check.
 *
 * Etikettenfotos zeigen neben dem Etikett meist bedruckten Sack oder
 * Hintergrund, aus dem Tesseract Müllzeilen liest ("AS A NÄRUUEN", "; 2 /").
 * Zwei Maßnahmen bereinigen das Ergebnis:
 *   1. textFromResult(): Zeilen/Wörter mit niedriger Erkennungs-Konfidenz
 *      (Hintergrund-Rauschen) verwerfen
 *   2. cleanText():      Silbentrennung zusammenführen, Symbol-Müllzeilen
 *      entfernen, typische Fehllesungen von Zusatzstoff-Codes korrigieren
 *
 * Eine Bild-Vorverarbeitung (Verkleinern, Graustufen, Kontrastspreizung)
 * wurde erprobt und wieder verworfen: Auf realen Etikettenfotos las
 * Tesseract das Originalbild messbar besser (24/24 statt 21–23/24 korrekt
 * rekonstruierbarer Zusatzstoff-Codes).
 */
"use strict";

const Ocr = (() => {

  // Eine Zeile gilt als echter Etikettentext, wenn mindestens zwei Wörter
  // solide erkannt wurden – oder ein einzelnes Wort sehr sicher ist
  // (Überschriften wie "Fütterungsempfehlung:").
  const LINE_SOLID_WORD_CONFIDENCE = 50;
  const LINE_MIN_SOLID_WORDS = 2;
  const LINE_SINGLE_WORD_CONFIDENCE = 80;

  // Innerhalb behaltener Zeilen fliegen kurze Wortfragmente mit niedriger
  // Konfidenz raus (Randmüll wie "SE", "De", "EEE"). Längere Wörter bleiben
  // auch bei niedriger Konfidenz erhalten – dort ist ein fehlerhaft
  // gelesenes echtes Wort (z. B. ein Zusatzstoff-Code) wahrscheinlicher
  // als Rauschen.
  const WORD_MIN_CONFIDENCE = 40;
  const WORD_MIN_ALNUM = 4;

  function countAlnum(s) {
    const m = String(s).match(/[0-9A-Za-zÀ-ÖØ-öø-ž]/g);
    return m ? m.length : 0;
  }

  /** Flacht die tesseract.js-Blockstruktur zu Zeilen aus Wörtern ab. */
  function flattenLines(blocks) {
    const lines = [];
    for (const block of blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const line of paragraph.lines || []) {
          const words = (line.words || [])
            .filter(w => (w.text || "").trim())
            .map(w => ({ text: w.text.trim(),
                         confidence: typeof w.confidence === "number" ? w.confidence : 0,
                         bbox: w.bbox }));
          if (words.length) lines.push(words);
        }
      }
    }
    return lines;
  }

  // ── Zweispaltige Etiketten ─────────────────────────────────────
  // Tesseract liest Zeilen quer über beide Spalten („Zusammensetzung: Analytische Bestandteile:“) und mischt
  // damit linke und rechte Spalte. Nur wenn zwei Abschnittsüberschriften in einer Zeile kollidieren und
  // zwischen den Spalten eine leere Lücke liegt, werden die Zeilen an der Lücke getrennt und spaltenweise
  // geordnet. Einspaltige Etiketten und Tabellen innerhalb einer Spalte bleiben unverändert.
  const SECTION_HEADING_START = /^(?:Analytische|Analytical|Zusatzstoffe|Ernährungsphysiologische|Technologische|Zootechnische|Sensorische|Fütterungsempfehlung|Inhaltsstoffe|Zusammensetzung|Composition|Hersteller|Inverkehrbringer|Constituants)/i;

  function lineHeight(words) {
    const heights = words.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    return heights[Math.floor(heights.length / 2)] || 1;
  }

  // Zweispaltige Etiketten ohne „Überschrift: Überschrift“-Zeile (z. B. „Zusammensetzung: … Samenstelling: …“ nebeneinander,
  // links endet die Zeile mitten im Satz): Die Lücke ist ein senkrechtes Band in der Mitte, das fast kein Wort überdeckt,
  // mit Text auf beiden Seiten. Streng gehalten, damit einspaltiger Text mit zufälligen Lücken nicht getrennt wird.
  function coverageGutter(lines) {
    const rows = lines.filter(words => words.length && words.every(w => w.bbox));
    if (rows.length < 12) return null;
    const heights = rows.map(lineHeight).sort((a, b) => a - b);
    const height = heights[Math.floor(heights.length / 2)];
    const minX = Math.min(...rows.map(words => Math.min(...words.map(w => w.bbox.x0))));
    const maxX = Math.max(...rows.map(words => Math.max(...words.map(w => w.bbox.x1))));
    if (!(maxX - minX > height * 12)) return null;
    const from = Math.floor(minX + (maxX - minX) * 0.3);
    const to = Math.ceil(minX + (maxX - minX) * 0.7);
    const covered = new Array(to - from + 1).fill(0);
    for (const words of rows) {
      const hit = new Set();
      for (const word of words) {
        for (let x = Math.max(from, Math.floor(word.bbox.x0)); x <= Math.min(to, Math.ceil(word.bbox.x1)); x++) hit.add(x);
      }
      for (const x of hit) covered[x - from]++;
    }
    const allowed = Math.max(1, Math.ceil(rows.length * 0.12));
    let best = null;
    for (let x = 0, start = null; x <= covered.length; x++) {
      const free = x < covered.length && covered[x] <= allowed;
      if (free && start === null) start = x;
      if (!free && start !== null) {
        if (!best || x - start > best.width) best = { start, width: x - start };
        start = null;
      }
    }
    if (!best || best.width < height * 0.6) return null;
    const x = from + best.start + best.width / 2;
    // Beide Seiten müssen deutlich besetzt sein (mindestens sechs Zeilen und 35 % der Zeilen mit Text je Seite).
    const leftRows = rows.filter(words => words.some(w => (w.bbox.x0 + w.bbox.x1) / 2 < x)).length;
    const rightRows = rows.filter(words => words.some(w => (w.bbox.x0 + w.bbox.x1) / 2 >= x)).length;
    if (leftRows < 6 || rightRows < 6 || leftRows < rows.length * 0.35 || rightRows < rows.length * 0.35) return null;
    // Beide Seiten müssen Fließtext tragen: Eine Tabelle aus Namens- und Wertespalte hat dieselbe freie Mitte, aber nur
    // ein bis zwei Wörter je Zeile auf der Wertseite und darf nicht in „erst alle Namen, dann alle Werte“ zerlegt werden.
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const leftWords = median(rows.map(words => words.filter(w => (w.bbox.x0 + w.bbox.x1) / 2 < x).length).filter(n => n > 0));
    const rightWords = median(rows.map(words => words.filter(w => (w.bbox.x0 + w.bbox.x1) / 2 >= x).length).filter(n => n > 0));
    if (leftWords < 4 || rightWords < 4) return null;
    return { x, height, width: best.width };
  }

  function findColumnGutter(lines) {
    for (let index = 0; index < lines.length; index++) {
      const words = lines[index];
      if (!words.every(w => w.bbox)) continue;
      const height = lineHeight(words);
      for (let j = 1; j < words.length; j++) {
        const before = words[j - 1];
        const gap = words[j].bbox.x0 - before.bbox.x1;
        if (!before.text.endsWith(":") || !SECTION_HEADING_START.test(words[j].text) || gap < height * 1.5) continue;
        // Spaltenlücke: Bereich zwischen den beiden Überschriften, den höchstens ein Wort der Zeilen darunter überdeckt.
        const from = Math.ceil(before.bbox.x1);
        const to = Math.floor(words[j].bbox.x0);
        const below = lines.slice(index);
        const covered = new Array(to - from + 1).fill(0);
        for (const line of below) {
          const hit = new Set();
          for (const word of line) {
            if (!word.bbox) continue;
            for (let x = Math.max(from, Math.floor(word.bbox.x0)); x <= Math.min(to, Math.ceil(word.bbox.x1)); x++) hit.add(x);
          }
          for (const x of hit) covered[x - from]++;
        }
        // Frei ist ein Bereich, den nur wenige Zeilen überdecken (Rauschwörter, mittig gesetzte Zeilen).
        const allowed = Math.max(1, Math.ceil(below.length * 0.12));
        let best = null;
        for (let x = 0, start = null; x <= covered.length; x++) {
          const free = x < covered.length && covered[x] <= allowed;
          if (free && start === null) start = x;
          if (!free && start !== null) {
            if (!best || x - start > best.width) best = { start, width: x - start };
            start = null;
          }
        }
        if (best && best.width >= height) return { x: from + best.start + best.width / 2, height, width: best.width };
      }
    }
    return coverageGutter(lines);
  }

  // Ein an der Spaltenlücke getrenntes Stück übernimmt die Entscheidung der ursprünglichen Zeile: Hat die ganze Zeile
  // den Konfidenzfilter bestanden, wird ein einzelnes Wort der einen Spalte nicht nachträglich verworfen.
  const fragmentOrigin = new WeakMap();

  // ── Randspalte neben Fließtext ──
  // Neben dem Haupttext steht oft eine schmale zweite Spalte: ein Kasten mit Hersteller, Charge und Haltbarkeit oder
  // eine Tabelle „Inhaltsstoffe“. Sie reicht nicht über die ganze Höhe und liegt nicht in der Mitte, die Suche nach
  // einer Spaltenlücke für das ganze Etikett findet sie nicht. Erkannt wird sie an einer Folge von Zeilen mit einer
  // breiten Wortlücke an derselben Stelle. Die Zeilen der Folge werden an der Lücke getrennt: erst der linke Text,
  // dann die Randspalte.
  // Streng gehalten: mindestens vier getrennte Zeilen, links Fließtext (im Median mindestens vier Wörter), rechts
  // überwiegend Text. Eine Tabelle aus Name und Wert („Rohprotein … 17,8 %“) bleibt deshalb zusammen.
  function widestGap(words, height) {
    let best = null;
    const gaps = [];
    for (let j = 1; j < words.length; j++) {
      const from = words[j - 1].bbox.x1;
      const to = words[j].bbox.x0;
      gaps.push(to - from);
      if (!best || to - from > best.to - best.from) best = { from, to, at: j };
    }
    if (!best || best.to - best.from < height * 1.5) return null;
    // Deutlich breiter als die übrigen Wortabstände der Zeile (Blocksatz hat überall breite Abstände).
    const others = gaps.filter((_, index) => index !== best.at - 1).sort((a, b) => a - b);
    const usual = others.length ? others[Math.floor(others.length / 2)] : 0;
    return best.to - best.from >= usual * 2.5 ? best : null;
  }

  function sideColumnRuns(lines) {
    const sorted = lines.map(words => words.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0));
    const runs = [];
    let index = 0;
    while (index < lines.length) {
      const height = lineHeight(sorted[index]);
      const gap = widestGap(sorted[index], height);
      if (!gap) { index++; continue; }
      let from = gap.from;
      let to = gap.to;
      // Freier Bereich einer Zeile, der das Band am besten deckt: eine Wortlücke oder der Rand neben dem Text (eine
      // längere linke Zeile schiebt den Bandanfang nach rechts, eine Zeile nur der Randspalte das Ende nach links).
      // Bleibt kein Band von mindestens einer Zeilenhöhe, endet die Folge.
      const narrow = words => {
        let nextFrom = from;
        let nextTo = from;
        const edges = [-Infinity, ...words.flatMap(w => [w.bbox.x0, w.bbox.x1]), Infinity];
        for (let e = 0; e < edges.length; e += 2) {
          const lo = Math.max(edges[e], from);
          const hi = Math.min(edges[e + 1], to);
          if (hi - lo > nextTo - nextFrom) { nextFrom = lo; nextTo = hi; }
        }
        if (nextTo - nextFrom < height) return false;
        from = nextFrom;
        to = nextTo;
        return true;
      };
      let end = index;
      while (end + 1 < lines.length && narrow(sorted[end + 1])) end++;
      // Zeilen direkt darüber gehören dazu, wenn sie das Band frei lassen (ihre eigene Lücke war als Anfang zu schmal).
      let start = index;
      const floor = runs.length ? runs[runs.length - 1].end + 1 : 0;
      while (start > floor && narrow(sorted[start - 1])) start--;
      let split = 0;
      let rightText = 0;
      let rightRows = 0;
      const leftCounts = [];
      for (let k = start; k <= end; k++) {
        const left = sorted[k].filter(w => w.bbox.x1 <= from + 1);
        const right = sorted[k].filter(w => w.bbox.x0 >= to - 1);
        if (left.length && right.length) { split++; leftCounts.push(left.length); }
        if (right.length) {
          rightRows++;
          if (/^\P{N}*\p{L}{2}/u.test(right[0].text)) rightText++;
        }
      }
      leftCounts.sort((a, b) => a - b);
      const prose = leftCounts.length ? leftCounts[Math.floor(leftCounts.length / 2)] >= 4 : false;
      // Dieselbe Randspalte läuft weiter, wenn die Folge an die vorige anschließt (höchstens zwei Zeilen über die
      // ganze Breite dazwischen) und rechts an derselben Stelle beginnt. Dann genügen zwei getrennte Zeilen.
      const previous = runs[runs.length - 1];
      const continues = previous && start <= previous.end + 3 && Math.abs(to - previous.to) <= height * 2;
      if (prose && (continues ? split >= 2 : split >= 4 && rightText >= rightRows * 0.6)) {
        runs.push({ start, end, x: (from + to) / 2, to });
        index = end + 1;
      } else index++;
    }
    return runs;
  }

  function reorderSideColumns(lines) {
    if (lines.length < 4 || !lines.every(words => words.length && words.every(w => w.bbox))) return lines;
    const runs = sideColumnRuns(lines);
    if (!runs.length) return lines;
    const result = [];
    let at = 0;
    for (const run of runs) {
      result.push(...lines.slice(at, run.start));
      const left = [];
      const right = [];
      for (const words of lines.slice(run.start, run.end + 1)) {
        const l = words.filter(w => (w.bbox.x0 + w.bbox.x1) / 2 < run.x);
        const r = words.filter(w => (w.bbox.x0 + w.bbox.x1) / 2 >= run.x);
        for (const part of [l, r]) if (part.length && part.length < words.length) fragmentOrigin.set(part, words);
        if (l.length) left.push(l);
        if (r.length) right.push(r);
      }
      result.push(...left, ...right);
      at = run.end + 1;
    }
    result.push(...lines.slice(at));
    return result;
  }

  /** Ordnet die Zeilen eines zweispaltigen Etiketts spaltenweise (links, dann rechts). */
  function reorderColumns(lines) {
    const gutter = findColumnGutter(lines);
    if (!gutter) return reorderSideColumns(lines);
    const tolerance = gutter.height * 0.4;
    const result = [];
    let left = [];
    let right = [];
    const flush = () => { result.push(...left, ...right); left = []; right = []; };
    for (const words of lines) {
      if (!words.every(w => w.bbox)) { flush(); result.push(words); continue; }
      const crossing = words.some(w => w.bbox.x0 < gutter.x - tolerance && w.bbox.x1 > gutter.x + tolerance);
      if (crossing) { flush(); result.push(words); continue; }
      const side = words.filter(w => (w.bbox.x0 + w.bbox.x1) / 2 < gutter.x);
      const other = words.filter(w => (w.bbox.x0 + w.bbox.x1) / 2 >= gutter.x);
      // Eine Zeile über beide Hälften wird nur getrennt, wenn ihre Lücke so breit ist wie die Spaltenlücke.
      // Eine mittig gesetzte Zeile („Charge: 4711“) fällt mit ihrer kleinen Wortlücke nicht darunter.
      if (side.length && other.length) {
        const gap = Math.min(...other.map(w => w.bbox.x0)) - Math.max(...side.map(w => w.bbox.x1));
        if (gap < gutter.width * 0.5) { flush(); result.push(words); continue; }
      }
      for (const part of [side, other]) if (part.length && part.length < words.length) fragmentOrigin.set(part, words);
      if (side.length) left.push(side);
      if (other.length) right.push(other);
    }
    flush();
    return result;
  }

  function findTextRegion(data, matchLine) {
    for (const words of flattenLines(data.blocks)) {
      const match = matchLine(words.map(word => word.text).join(" "));
      if (!match) continue;
      let offset = 0;
      const positions = [];
      for (const word of words) {
        const start = offset;
        offset += word.text.length + 1;
        if (word.bbox && start < match.index + match[0].length && offset > match.index) {
          positions.push(word.bbox);
        }
      }
      if (positions.length) return { first: positions[0], last: positions[positions.length - 1] };
    }
    return null;
  }

  function filterLine(words) {
    const solid = words.filter(w => w.confidence >= LINE_SOLID_WORD_CONFIDENCE).length;
    const maxConfidence = Math.max(...words.map(w => w.confidence));
    if (solid < LINE_MIN_SOLID_WORDS && maxConfidence < LINE_SINGLE_WORD_CONFIDENCE) return null;
    const kept = words.filter(w =>
      w.confidence >= WORD_MIN_CONFIDENCE || countAlnum(w.text) >= WORD_MIN_ALNUM);
    return kept.length ? kept.map(w => w.text).join(" ") : null;
  }

  /**
   * Extrahiert den Text aus einem tesseract.js-Ergebnis (`data`).
   * Sind Blöcke mit Wort-Konfidenzen vorhanden (recognize(…, { blocks: true })),
   * wird Hintergrund-Rauschen herausgefiltert; sonst wird data.text verwendet.
   * Das Ergebnis läuft immer durch cleanText().
   */
  /** Text aus Zeilen (Wortlisten mit Position): Spalten ordnen, Rauschzeilen filtern, bereinigen. Leer, wenn nichts bleibt. */
  function textFromLines(lines) {
    const kept = reorderColumns(lines).map(words => {
      const origin = fragmentOrigin.get(words);
      if (!origin) return filterLine(words);
      // Stück einer getrennten Zeile: gilt, wenn die ursprüngliche Zeile gilt; nur schwache Randwörter fallen weg.
      if (!filterLine(origin)) return null;
      const strong = words.filter(w => w.confidence >= WORD_MIN_CONFIDENCE || countAlnum(w.text) >= WORD_MIN_ALNUM);
      return strong.length ? strong.map(w => w.text).join(" ") : null;
    }).filter(Boolean);
    return kept.length ? cleanText(kept.join("\n")) : "";
  }

  function textFromResult(data) {
    if (data && Array.isArray(data.blocks) && data.blocks.length) {
      const fromLines = textFromLines(flattenLines(data.blocks));
      if (fromLines) return fromLines;
    }
    return cleanText(data && data.text ? data.text : "");
  }

  // ── Kachel-OCR ──
  // Auf Fotos mit ungleichmäßiger Beleuchtung, Perspektive oder schräg laufender Schrift scheitert Tesseract am Gesamtbild
  // (eine Helligkeitsschwelle und eine Zeilenrichtung für die ganze Seite), liest aber kleine Ausschnitte sauber. Das Foto
  // wird deshalb in überlappende Kacheln zerlegt, jede einzeln gelesen und die Zeilen über die Wortpositionen wieder
  // zusammengesetzt. Gemessen am Pavo-WeightLift-Foto: 8 von 20 Sollzeilen im Vollbild, 15–16 mit Kacheln.
  const TILE_TARGET = 1100;   // angestrebte Kachelkante in Bildpunkten des Fotos
  const TILE_MAX_PER_SIDE = 3;
  const TILE_OVERLAP = 0.08;  // Überlappung je Innenkante, Anteil der Kachelkante

  /** Kachelraster für ein Foto: [] bei kleinen Bildern, sonst Rechtecke (Bildkoordinaten) mit Vergrößerung. */
  function tileGrid(width, height, override) {
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return [];
    const cols = override?.cols ?? Math.min(TILE_MAX_PER_SIDE, Math.max(1, Math.ceil(width / TILE_TARGET)));
    const rows = override?.rows ?? Math.min(TILE_MAX_PER_SIDE, Math.max(1, Math.ceil(height / TILE_TARGET)));
    // Ein großes Foto, das in eine Kachel passt, bleibt ganz. Ein kleines (unter einer Kachelkante) wird als eine
    // vergrößerte, aufbereitete Kachel gelesen: Schrift im Schatten wird so oft erst lesbar.
    if (cols * rows < 2 && Math.max(width, height) >= TILE_TARGET) return [];
    const tiles = [];
    const tileWidth = width / cols;
    const tileHeight = height / rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = Math.max(0, Math.floor(col * tileWidth - TILE_OVERLAP * tileWidth));
        const y = Math.max(0, Math.floor(row * tileHeight - TILE_OVERLAP * tileHeight));
        const right = Math.min(width, Math.ceil((col + 1) * tileWidth + TILE_OVERLAP * tileWidth));
        const bottom = Math.min(height, Math.ceil((row + 1) * tileHeight + TILE_OVERLAP * tileHeight));
        // Kleine Kacheln (niedrig aufgelöste Fotos) vergrößern, große unverändert lesen.
        const scale = Math.min(2, Math.max(1, 1300 / Math.max(right - x, bottom - y)));
        tiles.push({ col, row, cols, rows, x, y, right, bottom, scale });
      }
    }
    return tiles;
  }

  // Dasselbe Wort aus zwei Kacheln: die Rahmen decken sich waagerecht mindestens zur Hälfte, und die Mitten liegen
  // auf derselben Höhe. Bei schräg laufender Schrift überlappen auch Rahmen benachbarter Zeilen; die Höhe der Mitte
  // trennt sie.
  function samePlace(a, b) {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    if (w <= 0 || w < Math.min(a.x1 - a.x0, b.x1 - b.x0) * 0.5) return false;
    const heightA = a.y1 - a.y0;
    const heightB = b.y1 - b.y0;
    const centerA = (a.y0 + a.y1) / 2;
    const centerB = (b.y0 + b.y1) / 2;
    return Math.abs(centerA - centerB) < Math.min(heightA, heightB) * 0.4;
  }
  // Tesseract liefert gelegentlich entartete Wortrahmen: einen wenige Pixel hohen Streifen oder einen Rahmen über zwei
  // Zeilen. Beim Vereinigen würden sie Wörter aus Nachbarzeilen in eine Zeile ziehen. Streifen fallen weg. Ein deutlich
  // zu hoher Rahmen (ab dem 2,4-Fachen des Zeilenmedians; ein Wort mit Zeilenhöhe als Rahmen neben kleineren
  // Tabellenwerten liegt beim Doppelten) wird auf die Höhe der Zeile gestutzt, das Wort selbst bleibt.
  function withSaneBoxes(words) {
    // Unsicher gelesene Zeichen ohne Buchstaben oder Ziffern (Flecken, Rahmenlinien) sind kein Anker für andere Lesungen.
    const sane = words.filter(w => w.bbox.y1 - w.bbox.y0 >= 5 && (countAlnum(w.text) > 0 || w.confidence >= 30));
    if (sane.length < 3) return sane;
    const sorted = values => values.slice().sort((a, b) => a - b);
    const median = values => sorted(values)[Math.floor(values.length / 2)];
    const height = median(sane.map(w => w.bbox.y1 - w.bbox.y0));
    const regular = sane.filter(w => w.bbox.y1 - w.bbox.y0 <= height * 2.4);
    const center = median(regular.map(w => (w.bbox.y0 + w.bbox.y1) / 2));
    return sane.filter(w => w.bbox.y1 - w.bbox.y0 >= height * 0.4).map(w => {
      if (w.bbox.y1 - w.bbox.y0 <= height * 2.4) return w;
      return { ...w, bbox: { ...w.bbox, y0: center - height / 2, y1: center + height / 2 } };
    });
  }
  // Gleich gelesen: bis auf Groß-/Kleinschreibung, Satzzeichen und einen Lesefehler je vier Zeichen.
  function similarText(a, b) {
    const x = a.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const y = b.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (!x || !y) return x === y;
    if (x === y) return true;
    if (Math.abs(x.length - y.length) > 2) return false;
    // Editierabstand, begrenzt auf kurze Wörter
    const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
    for (let i = 1; i <= x.length; i++) {
      let diagonal = prev[0];
      prev[0] = i;
      for (let j = 1; j <= y.length; j++) {
        const next = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (x[i - 1] === y[j - 1] ? 0 : 1));
        diagonal = prev[j];
        prev[j] = next;
      }
    }
    return prev[y.length] <= Math.max(1, Math.floor(Math.max(x.length, y.length) / 4));
  }

  // Die Seitenaufteilung liest auch um 90° gedrehte Textblöcke. Deren Wortrahmen sind höher als breit; als waagerechte
  // Zeilen verarbeitet kämen die Wörter durcheinander. Eine Zeile gilt als hochkant, wenn die Mehrheit ihrer Wörter
  // ab drei Zeichen deutlich höher als breit ist.
  function uprightLines(lines) {
    return lines.filter(words => {
      const long = words.filter(w => w.bbox && w.text.length >= 3);
      if (!long.length) return true;
      const tall = long.filter(w => w.bbox.y1 - w.bbox.y0 > (w.bbox.x1 - w.bbox.x0) * 1.3).length;
      return tall * 2 <= long.length;
    });
  }

  /**
   * Zeilen einer Lesung als Text mit Höhe, Sicherheit und Rahmen, umgerechnet auf die Bildpunkte des Fotos
   * (`scale` = Verkleinerung des gelesenen Bildes gegenüber dem Foto).
   */
  function lineSummaries(lines, scale = 1) {
    return lines.filter(words => words.length && words.every(w => w.bbox)).map(words => ({
      text: words.map(w => w.text).join(" "),
      height: lineHeight(words) / scale,
      confidence: Math.min(...words.map(w => w.confidence)),
      bbox: { x0: Math.min(...words.map(w => w.bbox.x0)) / scale, y0: Math.min(...words.map(w => w.bbox.y0)) / scale,
              x1: Math.max(...words.map(w => w.bbox.x1)) / scale, y1: Math.max(...words.map(w => w.bbox.y1)) / scale },
    }));
  }

  /** Mittlere Worthöhe einer Lesung (Wörter ab drei Zeichen), 0 ohne solche Wörter. */
  function bodyHeight(lines) {
    const heights = lines.flat().filter(w => w.bbox && w.text.length >= 3).map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    return heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  }

  // Zeile nur aus einer Menge größer null mit Einheit, jedes Wort mit Sicherheit ab 80 („5kg“, „℮ 500 g“).
  const AMOUNT_ONLY = /^[℮e]?\s*(\d+(?:[.,]\d+)?)\s*(?:kg|g|ml|l)\s*[℮e]?$/i;
  function isSureAmountLine(words) {
    const match = AMOUNT_ONLY.exec(words.map(w => w.text).join(" ").trim());
    return !!match && Number(match[1].replace(",", ".")) > 0 && words.every(w => w.confidence >= 80);
  }

  // Mittlere Neigung langer Zeilen (ab vier Wörtern und 200 Bildpunkten Länge), 0 ohne solche Zeilen.
  function medianSlope(lines) {
    const slopes = [];
    for (const words of lines) {
      const boxed = words.filter(w => w.bbox);
      if (boxed.length < 4) continue;
      const a = boxed[0].bbox;
      const b = boxed[boxed.length - 1].bbox;
      const dx = (b.x0 + b.x1) / 2 - (a.x0 + a.x1) / 2;
      if (dx > 200) slopes.push(((b.y0 + b.y1) / 2 - (a.y0 + a.y1) / 2) / dx);
    }
    slopes.sort((x, y) => x - y);
    return slopes.length ? slopes[Math.floor(slopes.length / 2)] : 0;
  }

  /**
   * Vereinigt mehrere Lesungen desselben Fotos zu Zeilen des ganzen Fotos: Kacheln (aus tileGrid) und Vollbild-Lesungen
   * (x = y = 0, scale = 1, cols = rows = 1) in beliebiger Mischung. Reihenfolge = Rang: Frühere Lesungen geben die
   * Zeilenstruktur vor, spätere ergänzen fehlende Wörter und ersetzen unsicher gelesene.
   * tiles: [{ x, y, right, bottom, scale, col, row, cols, rows, angle (optional, Zeilenneigung in Grad), lines: Zeilen wie aus flattenLines (Positionen in
   *          Koordinaten der Lesung) }]
   * Rückgabe: Zeilen (Wortlisten) mit Positionen in Bildkoordinaten, von oben nach unten.
   */
  function mergeTiles(tiles) {
    const kept = [];
    for (const tile of tiles) {
      const tileWidth = tile.right - tile.x;
      // Neigung der Zeilen in dieser Lesung (positiv: nach rechts abfallend): aus dem gemessenen Winkel der Kachel,
      // sonst aus den Zeilen selbst (Median über lange Zeilen; einzelne vermischte Zeilen fallen nicht ins Gewicht).
      const slant = Number.isFinite(tile.angle) ? Math.tan(tile.angle * Math.PI / 180) : medianSlope(tile.lines || []);
      for (const raw of tile.lines || []) {
        const words = [];
        for (const word of raw) {
          if (!word.bbox) continue;
          const bbox = { x0: tile.x + word.bbox.x0 / tile.scale, x1: tile.x + word.bbox.x1 / tile.scale,
                         y0: tile.y + word.bbox.y0 / tile.scale, y1: tile.y + word.bbox.y1 / tile.scale };
          // An einer Innenkante abgeschnittene Wörter verwerfen: Die Nachbarkachel enthält sie vollständig.
          const margin = 2;
          if ((tile.col > 0 && bbox.x0 <= tile.x + margin) || (tile.col < tile.cols - 1 && bbox.x1 >= tile.right - margin)
              || (tile.row > 0 && bbox.y0 <= tile.y + margin) || (tile.row < tile.rows - 1 && bbox.y1 >= tile.bottom - margin)) continue;
          words.push({ text: word.text, confidence: word.confidence, bbox });
        }
        const cleaned = withSaneBoxes(words);
        words.length = 0;
        words.push(...cleaned);
        if (!words.length) continue;
        words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
        // 1) Jedes Wort sucht sein Gegenstück an derselben Stelle in den bisherigen Zeilen.
        //    Liegen mehrere bisherige Wörter an der Stelle (eng gesetzte Zeilen), gewinnt das gleich gelesene.
        const homes = words.map(word => {
          let found = null;
          for (const line of kept) {
            // Zeilen derselben Lesung sind nie Gegenstücke (ein entarteter Rahmen würde sonst zwei Zeilen verbinden).
            if (line.tile === tile) continue;
            for (const twin of line.words) {
              if (!samePlace(word.bbox, twin.bbox)) continue;
              if (similarText(word.text, twin.text)) return { line, twin };
              found ||= { line, twin };
            }
          }
          return found;
        });
        if (homes.some(Boolean)) {
          words.forEach((word, index) => {
            const home = homes[index];
            if (home) {
              // Gleich gelesen: nichts zu tun. Sonst gewinnt die deutlich sicherere Lesung, aber nur, wenn sie nicht
              // weniger Zeichen trägt (ein „%“ ersetzt kein „11%“, ein „11“ auch nicht).
              // Das gilt auch für fast gleich Gelesenes („HD“ unsicher, „MHD“ sicher).
              if (word.text === home.twin.text) home.twin.confidence = Math.max(home.twin.confidence, word.confidence);
              // Bei sehr viel sichererer Lesung darf sie etwas kürzer sein („03/2028“ statt „0312075“).
              else if (word.text.length >= home.twin.text.length * 0.75
                       && ((word.confidence >= home.twin.confidence + 10 && countAlnum(word.text) >= countAlnum(home.twin.text)
                            && word.text.length >= home.twin.text.length)
                           || (word.confidence >= home.twin.confidence + 30 && countAlnum(word.text) >= countAlnum(home.twin.text) * 0.75))) Object.assign(home.twin, word);
              else if (similarText(word.text, home.twin.text)) home.twin.confidence = Math.max(home.twin.confidence, word.confidence);
              return;
            }
            // Neues Wort: nur wenn es sicher gelesen ist (Rauschzeichen am Zeilenrand fallen weg). Es kommt in die Zeile
            // des nächsten Nachbarn mit Gegenstück (so bleibt eine in dieser Lesung vermischte Zeile nach Spalten getrennt).
            const alnum = countAlnum(word.text);
            // Ausnahme: eine sehr sicher gelesene Zahl oder ein Prozentzeichen („5“ in „Nettomasse: 5 kg“, „%“ hinter
            // einem Analysewert). Die Stelle ist über die Nachbarwörter der Zeile verankert.
            const sureValue = word.confidence >= 80 && /^(?:\d[\d.,]*|[%‰])$/.test(word.text);
            if (!sureValue && !(alnum >= 2 && word.confidence >= 60) && !(alnum >= WORD_MIN_ALNUM && word.confidence >= WORD_MIN_CONFIDENCE)) return;
            let nearest = null;
            let anchor = null;
            let distance = Infinity;
            homes.forEach((other, k) => {
              if (!other) return;
              const gap = Math.max(0, Math.max(words[k].bbox.x0, word.bbox.x0) - Math.min(words[k].bbox.x1, word.bbox.x1));
              if (gap < distance) { distance = gap; nearest = other.line; anchor = words[k]; }
            });
            // Das neue Wort muss in seiner eigenen Lesung auf der Höhe des Nachbarn liegen (entlang der gemessenen
            // Zeilenneigung der Kachel). Bei eng gesetzten oder gewölbten Zeilen fasst eine Lesung sonst Wörter zweier
            // Zeilen zusammen.
            const run = (word.bbox.x0 + word.bbox.x1) / 2 - (anchor.bbox.x0 + anchor.bbox.x1) / 2;
            const offset = Math.abs((word.bbox.y0 + word.bbox.y1) / 2 - (anchor.bbox.y0 + anchor.bbox.y1) / 2 - run * slant);
            if (offset >= Math.min(word.bbox.y1 - word.bbox.y0, anchor.bbox.y1 - anchor.bbox.y0) * 0.4) return;
            nearest.words.push(word);
            nearest.dirty = true;
            if (tile.col > nearest.col) nearest.col = tile.col;
          });
          for (const line of kept) if (line.dirty) { line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0); line.dirty = false; }
          continue;
        }
        // 2) Fortsetzung über die Naht ohne gemeinsames Wort (Lücke im Überlappungsbereich, z. B. Tabelle „Name … Wert“):
        //    gleiche Höhe am Übergang und kein zu großer Abstand.
        if (tile.col > 0) {
          const first = words[0];
          const height = first.bbox.y1 - first.bbox.y0;
          let continued = null;
          let smallest = Infinity;
          const firstX = (first.bbox.x0 + first.bbox.x1) / 2;
          const firstY = (first.bbox.y0 + first.bbox.y1) / 2;
          for (const line of kept) {
            if (line.row !== tile.row || line.col !== tile.col - 1 || line.source !== tile.source) continue;
            const last = line.words[line.words.length - 1];
            const gap = first.bbox.x0 - last.bbox.x1;
            if (gap < 0 || gap > tileWidth * 0.35) continue;
            // Die bisherige Zeile wird mit ihrer eigenen Neigung bis zum neuen Wort verlängert (schräg laufende Schrift).
            const start = line.words[0];
            const lastX = (last.bbox.x0 + last.bbox.x1) / 2;
            const lastY = (last.bbox.y0 + last.bbox.y1) / 2;
            const run = lastX - (start.bbox.x0 + start.bbox.x1) / 2;
            const lineSlope = run > 150 ? (lastY - (start.bbox.y0 + start.bbox.y1) / 2) / run : 0;
            const dy = Math.abs(firstY - (lastY + lineSlope * (firstX - lastX)));
            if (dy < Math.min(height, last.bbox.y1 - last.bbox.y0) * 0.5 && dy < smallest) { continued = line; smallest = dy; }
          }
          if (continued) {
            continued.words.push(...words);
            continued.col = tile.col;
            continue;
          }
        }
        // Eine Zeile, die nur eine spätere Lesung kennt, braucht mindestens zwei sicher gelesene Wörter.
        // Ausnahme: eine sicher gelesene Mengenangabe („5kg“). Die Packungsmenge steht oft groß und allein, und nur
        // eine der Lesungen erfasst sie.
        if (tile !== tiles[0] && tile.source !== tiles[0].source
            && words.filter(w => w.confidence >= 60 && countAlnum(w.text) >= 2).length < 2
            && !isSureAmountLine(words)) continue;
        kept.push({ words, tile, row: tile.row, col: tile.col, source: tile.source, first: tile === tiles[0] });
      }
    }
    // Zwei Wörter einer Zeile an derselben waagerechten Stelle sind zwei Lesungen desselben Aufdrucks, die wegen eines
    // entarteten Rahmens nicht als Gegenstück erkannt wurden. Die deutlich unsicherere Lesung entfällt.
    for (const line of kept) {
      if (line.words.length < 2) continue;
      const drop = new Set();
      for (let i = 0; i < line.words.length; i++) {
        for (let j = i + 1; j < line.words.length; j++) {
          const a = line.words[i];
          const b = line.words[j];
          const overlap = Math.min(a.bbox.x1, b.bbox.x1) - Math.max(a.bbox.x0, b.bbox.x0);
          if (overlap < Math.min(a.bbox.x1 - a.bbox.x0, b.bbox.x1 - b.bbox.x0) * 0.5) continue;
          if (Math.abs(a.confidence - b.confidence) >= 20) drop.add(a.confidence < b.confidence ? a : b);
        }
      }
      if (drop.size) line.words = line.words.filter(w => !drop.has(w));
    }
    // Reihenfolge von oben nach unten. Die Zeilenneigung (schräg fotografiert) wird herausgerechnet, damit eine kurze
    // Zeile am rechten Rand nicht vor ihre linken Nachbarn rutscht.
    const center = words => ({ x: words.reduce((sum, w) => sum + (w.bbox.x0 + w.bbox.x1) / 2, 0) / words.length,
                               y: words.reduce((sum, w) => sum + (w.bbox.y0 + w.bbox.y1) / 2, 0) / words.length });
    const slope = medianSlope(kept.map(line => line.words));
    const keyed = kept.map(line => {
      const c = center(line.words);
      return { words: line.words, key: c.y - slope * c.x, first: line.source === tiles[0]?.source && line.first,
               x0: line.words[0].bbox.x0, x1: Math.max(...line.words.map(w => w.bbox.x1)) };
    });
    // Ist die erste Lesung ein Vollbild, gibt sie die Lesereihenfolge vor (Tesseract ordnet dort nach Textblöcken, also
    // spaltenweise). Zeilen aus späteren Lesungen werden unter der nächsten darüberliegenden Zeile eingefügt, die
    // waagerecht mit ihnen überlappt. Ohne Vollbild als Grundlage gilt die Reihenfolge von oben nach unten.
    const lead = tiles[0];
    if (!(lead && lead.cols === 1 && lead.rows === 1 && keyed.some(line => line.first))) {
      return keyed.sort((a, b) => a.key - b.key).map(line => line.words);
    }
    const ordered = keyed.filter(line => line.first);
    for (const line of keyed.filter(l => !l.first).sort((a, b) => a.key - b.key)) {
      let at = -1;
      for (let i = 0; i < ordered.length; i++) {
        const other = ordered[i];
        if (other.key <= line.key && Math.min(other.x1, line.x1) > Math.max(other.x0, line.x0)) at = i;
      }
      if (at < 0) {
        const below = ordered.findIndex(other => other.key > line.key && Math.min(other.x1, line.x1) > Math.max(other.x0, line.x0));
        at = below >= 0 ? below - 1 : ordered.length - 1;
      }
      ordered.splice(at + 1, 0, line);
    }
    // Die Blockfolge der Seitenaufteilung kann übereinanderstehende Zeilen derselben Spalte vertauschen. Eine Zeile
    // rückt vor die erste frühere Zeile, die waagerecht mit ihr überlappt und deutlich tiefer steht.
    const sorted = [];
    for (const line of ordered) {
      const height = line.words[0].bbox.y1 - line.words[0].bbox.y0;
      const before = sorted.findIndex(other => other.key > line.key + height * 0.5
        && Math.min(other.x1, line.x1) - Math.max(other.x0, line.x0) >= Math.min(other.x1 - other.x0, line.x1 - line.x0) * 0.5);
      if (before < 0) sorted.push(line);
      else sorted.splice(before, 0, line);
    }
    return sorted.map(line => line.words);
  }

  // ── Bildaufbereitung je Kachel (reine Rechenfunktionen auf Graustufen, ohne Canvas) ──

  // Lokaler Hintergrund: Mittelwerte eines groben Rasters, bilinear auf Bildgröße gebracht.
  function localBackground(gray, width, height) {
    const cell = Math.max(8, Math.round(Math.min(width, height) / 24));
    const gridW = Math.max(1, Math.ceil(width / cell));
    const gridH = Math.max(1, Math.ceil(height / cell));
    const sums = new Float32Array(gridW * gridH);
    const counts = new Uint32Array(gridW * gridH);
    for (let y = 0; y < height; y++) {
      const gy = Math.min(gridH - 1, (y / cell) | 0);
      for (let x = 0; x < width; x++) {
        const index = gy * gridW + Math.min(gridW - 1, (x / cell) | 0);
        sums[index] += gray[y * width + x];
        counts[index]++;
      }
    }
    for (let i = 0; i < sums.length; i++) sums[i] /= counts[i] || 1;
    const background = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const fy = Math.min(gridH - 1, Math.max(0, y / cell - 0.5));
      const y0 = fy | 0;
      const y1 = Math.min(gridH - 1, y0 + 1);
      const wy = fy - y0;
      for (let x = 0; x < width; x++) {
        const fx = Math.min(gridW - 1, Math.max(0, x / cell - 0.5));
        const x0 = fx | 0;
        const x1 = Math.min(gridW - 1, x0 + 1);
        const wx = fx - x0;
        background[y * width + x] = (sums[y0 * gridW + x0] * (1 - wx) + sums[y0 * gridW + x1] * wx) * (1 - wy)
          + (sums[y1 * gridW + x0] * (1 - wx) + sums[y1 * gridW + x1] * wx) * wy;
      }
    }
    return { background, grid: sums };
  }

  function percentile(histogram, total, fraction) {
    let seen = 0;
    for (let v = 0; v < histogram.length; v++) {
      seen += histogram[v];
      if (seen >= total * fraction) return v;
    }
    return histogram.length - 1;
  }

  /**
   * Gleicht ungleichmäßige Beleuchtung aus: Jeder Bildpunkt wird auf seinen lokalen Hintergrund bezogen und um 128
   * gespreizt. Dunkle Schrift bleibt dunkel, helle Schrift hell. `spread` ist die Helligkeitsspanne des Hintergrunds
   * (5.–95. Perzentil); bei kleiner Spanne lohnt der Ausgleich nicht.
   * @returns {{flat: Uint8ClampedArray, spread: number}}
   */
  function flattenIllumination(gray, width, height) {
    const { background, grid } = localBackground(gray, width, height);
    const bgHistogram = new Uint32Array(256);
    for (const value of grid) bgHistogram[Math.max(0, Math.min(255, Math.round(value)))]++;
    const spread = percentile(bgHistogram, grid.length, 0.95) - percentile(bgHistogram, grid.length, 0.05);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) histogram[Math.min(255, Math.abs(Math.round(gray[i] - background[i])))]++;
    const gain = 110 / Math.max(8, percentile(histogram, gray.length, 0.97));
    const flat = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) flat[i] = 128 + (gray[i] - background[i]) * gain;
    return { flat, spread };
  }

  /**
   * Schätzt die Neigung der Textzeilen in Grad (positiv: Zeilen fallen nach rechts ab). Das Bild wird verkleinert,
   * die Schrift als Maske genommen und für jeden Winkel das Zeilenprofil gebildet; bei geraden Zeilen ist das Profil
   * am schärfsten. 0, wenn kein Winkel klar besser ist als „gerade“.
   */
  function estimateSkew(gray, width, height, maxAngle = 15) {
    const factor = Math.max(1, Math.ceil(width / 420));
    const w = Math.floor(width / factor);
    const h = Math.floor(height / factor);
    if (w < 40 || h < 40) return 0;
    const small = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) sum += gray[(y * factor + dy) * width + x * factor + dx];
        small[y * w + x] = sum / (factor * factor);
      }
    }
    const { background } = localBackground(small, w, h);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < small.length; i++) histogram[Math.min(255, Math.abs(Math.round(small[i] - background[i])))]++;
    const threshold = Math.max(8, percentile(histogram, small.length, 0.85));
    const xs = [];
    const ys = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (Math.abs(small[y * w + x] - background[y * w + x]) > threshold) { xs.push(x - w / 2); ys.push(y - h / 2); }
    }
    if (xs.length < 200) return 0;
    const score = angle => {
      const sin = Math.sin(angle * Math.PI / 180);
      const cos = Math.cos(angle * Math.PI / 180);
      const rows = new Float32Array(h + 2);
      for (let i = 0; i < xs.length; i++) {
        // Drehung gegen den Uhrzeigersinn um `angle`: y' = -dx·sin + dy·cos
        const row = Math.round(h / 2 - xs[i] * sin + ys[i] * cos);
        if (row >= 0 && row < rows.length) rows[row]++;
      }
      let total = 0;
      for (let i = 1; i < rows.length; i++) { const d = rows[i] - rows[i - 1]; total += d * d; }
      return total;
    };
    const straight = score(0);
    let best = 0;
    let bestScore = straight;
    for (let angle = -maxAngle; angle <= maxAngle + 1e-9; angle += 0.25) {
      const value = score(angle);
      if (value > bestScore) { bestScore = value; best = angle; }
    }
    return bestScore > straight * 1.1 ? Math.round(best * 4) / 4 : 0;
  }

  /**
   * Rechnet einen Wortrahmen aus einem gerade gerichteten Bild (um `angle` Grad gegen den Uhrzeigersinn um die Mitte
   * gedreht, gleiche Größe) in die Koordinaten des ungedrehten Bildes zurück. Breite und Höhe bleiben erhalten.
   */
  function unrotateBox(bbox, angle, width, height) {
    if (!angle) return bbox;
    const sin = Math.sin(angle * Math.PI / 180);
    const cos = Math.cos(angle * Math.PI / 180);
    const dx = (bbox.x0 + bbox.x1) / 2 - width / 2;
    const dy = (bbox.y0 + bbox.y1) / 2 - height / 2;
    const cx = width / 2 + dx * cos - dy * sin;
    const cy = height / 2 + dx * sin + dy * cos;
    const halfW = (bbox.x1 - bbox.x0) / 2;
    const halfH = (bbox.y1 - bbox.y0) / 2;
    return { x0: cx - halfW, x1: cx + halfW, y0: cy - halfH, y1: cy + halfH };
  }

  /** Qualitätsmaß einer Lesung: Buchstaben in sicher erkannten Wörtern (für den Vergleich Vollbild gegen Kacheln). */
  function linesQuality(lines) {
    let letters = 0;
    for (const words of lines) {
      for (const word of words) {
        if (word.confidence < 75) continue;
        const count = (word.text.match(/\p{L}/gu) || []).length;
        if (count >= 3) letters += count;
      }
    }
    return letters;
  }

  function orientationScore(data) {
    return flattenLines(data.blocks).flat().filter(word =>
      word.confidence >= 70 && /\p{L}{3}/u.test(word.text)
    ).length;
  }

  function needsOrientationCheck(data) {
    return data.confidence < 50 && orientationScore(data) < 12;
  }

  // Kurze Etikettenausschnitte liefern auch aufrecht nur wenige sichere Wörter. Dort genügt eine
  // deutliche relative Verbesserung, sofern die Drehung selbst brauchbaren Text liefert.
  function isBetterOrientation(candidate, original) {
    const c = orientationScore(candidate);
    const o = orientationScore(original);
    return c >= o + 12 || (c >= 6 && c >= o * 3 + 4);
  }

  // Zusatzstoff-Codes wie (3a671) liest die OCR oft falsch:
  // das "a" als "3" → (33671), das "b" als "5" → (35506).
  // Fünfstellige Zahlen in Klammern, die mit 33/35 beginnen, kommen auf
  // Futtermitteletiketten sonst nicht vor.
  const ADDITIVE_CODE_FIXES = [
    [/\(3\s*3(\d{3}[a-z]{0,3})\)/gi, "(3a$1)"],
    [/\(3\s*5(\d{3}[a-z]{0,3})\)/gi, "(3b$1)"],
    // (3a671) als (32671): nur Vitamine/Provitamine (3a6xx–3a9xx), damit
    // Mengen wie (32000) unberührt bleiben.
    [/\(3\s*2([6-9]\d{2}[a-z]{0,3})\)/gi, "(3a$1)"],
  ];

  // Bekannte Kennnummern (aus zusatzstoffe.json), kleingeschrieben. Ohne Liste gilt nur die Regelkorrektur oben.
  let knownAdditiveCodes = null;

  function setAdditiveCodes(codes) {
    const set = new Set();
    for (const code of codes || []) {
      const normalised = String(code || "").toLowerCase().replace(/\s+/g, "");
      if (/^[1-4][a-z]\d{1,4}[a-z]{0,3}$/.test(normalised)) set.add(normalised);
    }
    knownAdditiveCodes = set.size ? set : null;
  }

  // Kennnummer in Klammern, die nicht bekannt ist: der Buchstabe nach der Gruppenziffer wird oft als Ziffer gelesen
  // ((30502) statt (3b502)). Korrigiert wird nur, wenn genau ein Buchstabe eine bekannte Kennnummer ergibt.
  function fixUnknownCodes(text) {
    if (!knownAdditiveCodes) return text;
    const repair = (whole, group, second, rest, build) => {
      if (knownAdditiveCodes.has(`${group}${second}${rest}`.toLowerCase())) return whole;
      // Kandidaten aus der gesamten Liste: gleiche Gruppenziffer und gleicher Rest, beliebiger Buchstabe.
      const wanted = new RegExp(`^${group}([a-z])${rest.toLowerCase()}$`);
      const hits = [...knownAdditiveCodes].map(code => wanted.exec(code)).filter(Boolean).map(match => match[1]);
      return hits.length === 1 ? build(hits[0]) : whole;
    };
    const parenthesised = text.replace(/\(([1-4])([0-9])(\d{2,3}[a-z]{0,3})\)/gi,
      (whole, group, second, rest) => repair(whole, group, second, rest, letter => `(${group}${letter}${rest})`));
    // Kennnummer ohne Klammer unmittelbar nach einer Menge („200 IE 33671, 1 mg 3b406“): dieselbe Korrektur. Nur hinter
    // einer Mengenangabe mit Einheit (auch verlesen: „m0“, „JE“; der Code darf in der nächsten Zeile stehen), damit Zahlen im Fließtext
    // unberührt bleiben.
    return parenthesised.replace(/(\d[\d.,]*[ \t]*(?:m[g0o]|g|µg|mcg|I\.E\.|[IJ]E|IU|KBE|CFU)(?:\/kg)?\s+)([1-4])(\d)(\d{2,3}[a-z]{0,3})(?![\p{L}\p{N}])/giu,
      (whole, before, group, second, rest) => repair(whole, group, second, rest, letter => `${before}${group}${letter}${rest}`));
  }

  /**
   * Bereinigt rohen OCR-Text:
   *  - Zeilen mit weniger als zwei alphanumerischen Zeichen (reiner
   *    Symbol-Müll wie "; 2 /") entfernen
   *  - Silbentrennung am Zeilenende zusammenführen ("Bierhe-\nfe" → "Bierhefe")
   *  - typische Fehllesungen von Zusatzstoff-Codes korrigieren
   *  - Mehrfach-Leerzeilen zusammenfassen
   */
  function cleanText(text) {
    const lines = String(text || "")
      .split("\n")
      .map(l => l.replace(/\s+/g, " ").trim())
      .filter(l => l === "" || countAlnum(l) >= 2);

    let cleaned = lines.join("\n")
      .replace(/([a-zäöüß])-\n([a-zäöüß])/g, "$1$2")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    for (const [pattern, replacement] of ADDITIVE_CODE_FIXES) {
      cleaned = cleaned.replace(pattern, replacement);
    }
    return fixUnknownCodes(cleaned);
  }


  // Fallback für Fotos mit sehr kleiner Schrift / mehrsprachigen Zeilen.
  // Ein enger Ausschnitt mit 2–2,5-facher Skalierung kann Text retten, den
  // die Vollbild-OCR wegen Spalten oder dominanter großer Schrift übergeht.
  // Maximal 3 Zusatzläufe pro Bild, keine zusätzlichen Sprachpakete.
  // Typisches zweispaltiges Mehrsprachen-Layout, das Tesseract zeilenweise
  // vermischt ("Zusammensetzung ... Composition ..."). Spalten getrennt lesen.
  function hasMixedLanguageColumns(text) {
    return /(?:Zusammensetzung[^\n]{0,150}Composition|Rohprotein[^\n]{0,130}Crude[ \t]+protein|Analytische[ \t]+Bestandteile[^\n]{0,130}Analytical)/iu.test(text);
  }

  // ── Fütterungstabelle ──
  // Überschrift auch bei zerlesenem OCR („FEEDING AD …“). Zeilen der deutschen Sicht: „Mageres Pferd 0,5 kg/Tag 1,0 kg/Tag“.
  const FEEDING_HEADING = /\b(?:Feeding\s+(?:ad|guide|instr)|F[üu]tterungs?(?:empfehlung|hinweis|tabelle)|Fütterungsmenge)/iu;
  const FEEDING_AMOUNT = String.raw`\d[\d.,]*\s*(?:kg|g)\/Tag`;
  const FEEDING_ROW = new RegExp(String.raw`^\p{L}[\p{L} .()-]{2,45}?\s+${FEEDING_AMOUNT}(?:\s+${FEEDING_AMOUNT})*$`, "u");
  const FEEDING_WEIGHT_ROW = /^Körpergewicht(?:\s+\d[\d.,]*\s*kg)+$/u;

  function feedingRows(germanText) {
    return String(germanText || "").split(/\r?\n/).map(l => l.trim()).filter(l => FEEDING_ROW.test(l) || FEEDING_WEIGHT_ROW.test(l));
  }

  // Fütterungstabelle erkennbar, aber die deutschen Zeilen fehlen oder sind zerlesen.
  // Eine einzelne Fütterungsempfehlung („500 g pro Tag“) ist keine Tabelle: Es braucht ein Tabellenmerkmal (Körpergewicht
  // als Spalte, auch zerlesen wie „rgewicht / Body weig“).
  const FEEDING_TABLE_SIGNAL = /(?:K[öo]rpergewicht|Body\s+weig|Lichaamsgewicht|rgewicht\s*\/)/iu;
  function needsFeedingRecovery(text) {
    if (!FEEDING_HEADING.test(text) || !FEEDING_TABLE_SIGNAL.test(text)) return false;
    return feedingRows(germanView(text)).length < 3;
  }

  const COMPOSITION_READ = /(?:^|\n)\s*DE\s+[^\n]*,[^\n]*,\s*\p{L}|(?:Zusammensetzung|Komposition|Composition)\s*:[^\n]*,[^\n]*,\s*\p{L}/imu;
  const ANALYSIS_HEADING = /(?:Analytische\s+Bestandteile|Analytical\s+constituents|Constituintes\s+analiticos|Analytick[eé]\s+slo[zž]ky)/iu;

  // Analyse: Überschrift erkennbar, aber weniger als zwei Wertzeilen gelesen.
  function needsAnalysisRecovery(text) {
    if (!ANALYSIS_HEADING.test(text)) return false;
    const lines = String(text).split(/\r?\n/).map(l => l.trim());
    return lines.filter(l => GERMAN_ANALYSIS_LINE.test(l) || CZECH_ANALYSIS_LINE.test(l)).length < 2;
  }

  // Nach einer Nachlese: Ist noch etwas offen, das ein weiterer Ausschnitt lesen könnte (Fütterungstabelle, Zutaten, Analyse)?
  function recoveryPending(text) {
    return needsFeedingRecovery(text) || !COMPOSITION_READ.test(text) || needsAnalysisRecovery(text);
  }

  function shouldRecoverText(text) {
    if (needsFeedingRecovery(text)) return true;
    if (hasMixedLanguageColumns(text)) return true;
    const words = String(text || "").match(/\p{L}{3,}/gu) || [];
    if (words.length < 30) return true;
    const hasComposition = /(?:^|\n)\s*DE\s+[^\n]*,[^\n]*,\s*\p{L}|(?:Zusammensetzung|Komposition|Composition)\s*:[^\n]*,[^\n]*,\s*\p{L}/imu.test(text);
    const hasAnalysis = /(?:Analytische\s+Bestandteile|Analytical\s+constituents|Hrub[yý]\s+protein|Rohprotein)\b/iu.test(text);
    const hasFeeding = /(?:Feeding\s+(?:advice|instructions)|F[üu]tterung(?:sempfehlung|shinweise)|Körpergewicht)\b/iu.test(text);
    return !hasComposition && (hasAnalysis || hasFeeding || words.length < 75);
  }

  // Relative Koordinaten vermeiden Geräte- und Auflösungsabhängigkeiten.
  // Jede Region wird getrennt gelesen, statt das gesamte Foto hochzuskalieren.
  // Obergrenze der Pixelfläche eines vergrößerten Ausschnitts (Canvas-Speicher auf Mobilgeräten). Eine Grenze nach
  // Kantenlänge würde bei Fotos in Handygröße (z. B. 4032×3024) die Vergrößerung auf unter 1,3-fach drücken.
  const MAX_CROP_PIXELS = 12e6;

  function recoveryRegions(width, height, primaryText = "") {
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return [];
    const regions = width >= height && hasMixedLanguageColumns(primaryText)
      ? [
        [0.035, 0.05, 0.53, 0.96, 2],
        [0.47, 0.05, 0.97, 0.96, 2],
        [0.075, 0.11, 0.93, 0.52, 2],
      ] : width >= height
      ? [
        [0.075, 0.11, 0.93, 0.52, 2],
        [0.05, 0.50, 0.95, 0.96, 2],
      ] : [
        [0.05, 0.25, 0.75, 0.68, 2.5],
        [0.06, 0.02, 0.95, 0.42, 2],
        [0.06, 0.60, 0.95, 0.98, 2],
      ];
    // Fütterungstabelle: eigener Ausschnitt zuerst (insgesamt höchstens drei Ausschnitte).
    if (needsFeedingRecovery(primaryText)) {
      regions.unshift(width >= height ? [0.08, 0.60, 0.72, 0.92, 2.5] : [0.05, 0.45, 0.95, 0.98, 2]);
      regions.length = Math.min(regions.length, 3);
    }
    return regions.map(([left, top, right, bottom, magnify]) => ({
      x: Math.floor(left * width), y: Math.floor(top * height),
      right: Math.ceil(right * width), bottom: Math.ceil(bottom * height),
      // Canvas auf Mobilgeräten begrenzen, ohne die Ausschnittgeometrie zu ändern.
      scale: Math.min(magnify, Math.sqrt(MAX_CROP_PIXELS / (((right - left) * width) * ((bottom - top) * height)))),
    }));
  }

  const CZECH_ANALYSIS_LINE = /^(?:Hrub[yýáée]\s+(?:protein|tuk|vl[aá]knina|popel)|(?:Cukr|[ŠS]krob|V[aá]pn[ií]k|Fosfor|Sod[ií]k|Drasl[ií]k|Hor[cč][ií]k))\s+[\d.,]+\s*%/iu;
  const GERMAN_ANALYSIS_LINE = /^(?:Rohprotein|Rohfett|Rohfaser|Rohasche|Calcium|Phosphor|Natrium|Kalium|Magnesium|Zucker|Stärke)\s+[\d.,]+\s*%/iu;
  // Zeilen, die die Bezugsbasis der Analysewerte nennen (Trockenmasse, „bezogen auf …“). Sie ändern die Bedeutung der Werte
  // und werden deshalb mit ihnen übernommen; ohne sie würden die Werte fälschlich als Originalsubstanz gerechnet.
  const ANALYSIS_BASIS_LINE = /\b(?:Trockenmasse|Trockensubstanz|dry\s+matter|bezogen\s+auf|normiert\s+auf|based\s+on|Basis\s*:)|(?:%|\b(?:mg|g)\s*\/\s*kg)\s+(?:TS|TM|DM)\b/iu;
  const GERMAN_INGREDIENT_LINE = /^DE\s+(\p{L}[^\n]{20,240})$/iu;
  const COMPOSITION_HEAD = /^(?:Samenstelling|Komposition|Composition|Zusammensetzung)\s*\/[^\n]{6,260}$/iu;

  /**
   * Nur spezifische neue Belegzeilen übernehmen, niemals generischen OCR-Müll
   * oder abgeleitete/hinzugedichtete Angaben. Werte bleiben Original-OCR.
   * Rückgabe kann eine vollständige echte DE-Zutatenzeile und unterstützende
   * fremdsprachige Analysenzeilen enthalten, aber keinen Konformitätsstatus.
   */
  function recoveredEvidence(primary, candidate) {
    const primaryHeading = String(primary || "").split(/\r?\n/).map(l => l.trim()).find(l => COMPOSITION_HEAD.test(l));
    const lines = String(candidate || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const existing = new Set(String(primary || "").split(/\r?\n/)
      .map(l => l.toLowerCase().replace(/\s+/g, " ").trim()));
    const novel = line => !existing.has(line.toLowerCase().replace(/\s+/g, " ").trim());
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const german = GERMAN_INGREDIENT_LINE.exec(lines[i]);
      if (german && german[1].split(/[,;]/).filter(x => /\p{L}{3,}/u.test(x)).length >= 3 && novel(lines[i])) {
        // Die Überschrift steht im Ausschnitt oder, wenn der Ausschnitt erst unterhalb beginnt, im bereits gelesenen
        // Haupttext. Beides ist tatsächlich gelesener Text; ohne Überschrift wird nichts übernommen.
        const heading = lines.slice(Math.max(0, i - 11), i).reverse().find(l => COMPOSITION_HEAD.test(l)) || primaryHeading;
        // Nur die tatsächlich ausgelesene Überschrift + DE-Zeile koppeln.
        // Damit funktioniert der bestehende mehrsprachige Composition-Parser.
        if (heading) out.push(heading, lines[i]);
      }
    }
    // Deutschsprachige Zutaten auf einsprachigen Etiketten ergänzen.
    for (const line of lines) {
      const m = /^Zusammensetzung\s*:\s*(.+)$/iu.exec(line);
      if (m && m[1].split(/[,;]/).filter(x => /\p{L}{3,}/u.test(x)).length >= 3 && novel(line)) {
        out.push(line);
      }
    }
    // Analytische Werte nur mit einer tatsächlich erkannten Tabellenüberschrift
    // übernehmen. Fremdsprachige Werte sind Rohbelege, keine Sprachkonformität.
    const heading = lines.find(line => /Analytische\s+Bestandteile|Analytick[eé]\s+slo[zž]ky|Constituintes\s+analiticos|Analytical\s+constituents/iu.test(line));
    if (heading) {
      const analysis = lines.filter(line => (GERMAN_ANALYSIS_LINE.test(line) || CZECH_ANALYSIS_LINE.test(line)) && novel(line));
      if (analysis.length >= 2) {
        // Die Überschrift immer mitnehmen, auch wenn der Haupttext sie schon enthält: Der Nachleseblock wird mit einer
        // Leerzeile angehängt, und ein Abschnitt endet dort. Ohne Überschrift bliebe er von den neuen Werten getrennt.
        out.push(heading);
        out.push(...lines.filter(line => line !== heading && ANALYSIS_BASIS_LINE.test(line)));
        out.push(...analysis.slice(0, 14));
      }
    }
    // Fütterungstabelle: Überschrift (im Ausschnitt oder im Haupttext) und mindestens drei deutsche Zeilen.
    const german = germanView(candidate);
    // Vollständigkeit an allen gelesenen Zeilen messen; bekannte Zeilen bleiben im Block, damit die Tabelle
    // zusammenhängend steht. Neu muss mindestens eine Zeile sein.
    const rows = feedingRows(german);
    if (rows.length >= 3 && rows.some(row => novel(row))) {
      const feedingHeading = lines.find(l => FEEDING_HEADING.test(l))
        || String(primary || "").split(/\r?\n/).map(l => l.trim()).find(l => FEEDING_HEADING.test(l));
      if (feedingHeading) out.push(feedingHeading, ...rows);
    }
    return [...new Set(out)].join("\n");
  }


  // ── Deutsche Textteile aus mehrsprachigen Etiketten ──
  // Mehrsprachige Packungen drucken jede Angabe in vielen Sprachen, getrennt durch „ / “ oder mit Sprachkürzel am
  // Zeilenanfang („NL …“, „DE …“). Die Prüfung nach VO (EG) 767/2009 gilt dem deutschen Text. germanView() liefert
  // eine Sicht, in der nur die deutschen Teile stehen; der OCR-Text selbst bleibt unverändert.
  // Nach dem Kürzel muss ein Wort folgen: „NL 5823 AC Musterort“ ist eine Anschrift mit Länderkennzeichen, keine Sprachzeile.
  const OTHER_LANGUAGE_PREFIX = /^(?:NL|EN|FR|IT|ES|DA|DK|SE|SV|PL|PT|CZ|FI|RO|HU|EL|GR)[ \t]+\p{L}/u;
  const GERMAN_PREFIX = /^DE[ \t]+(\S.*)$/;
  // Wörter, die in den Etiketten häufig vorkommen und in den anderen Sprachen nicht gleich lauten.
  const GERMAN_WORDS = /\b(?:der|die|das|den|dem|und|oder|nicht|mit|für|von|zur|zum|nach|bei|bis|auf|wird|werden|ist|sind|nur|auch|wieder|Pferd(?:e|en)?|Hund(?:e|en)?|Katze[n]?|Futter\p{L}*|Fütterung\p{L}*|Zusammensetzung|Komposition|Gewicht|Körpergewicht|Untergewicht|Übergewicht|Mageres|Starkes|Tag|kühl|trocken|dunkel|lagern|Verpackung|Gebrauch|verschließen|Lagerungshinweis|Hinweis\p{L}*|Analytische|Bestandteile|Zusatzstoffe|Gebrauchsanweisung|Inhalt|Nettomenge|Haltbarkeit)\b/giu;

  // Wörter anderer Sprachen, wie sie auf mehrsprachigen Futtermitteletiketten vorkommen (Niederländisch, Englisch,
  // Französisch, Spanisch, Italienisch, Skandinavisch, Polnisch, Portugiesisch, Tschechisch). Ohne einen solchen
  // Hinweis in einem anderen Segment ist „A / B / C“ eine einsprachige Aufzählung und bleibt unverändert.
  const OTHER_LANGUAGE_WORDS = /\b(?:samenstelling|composition|composici[oó]n|composizione|sammens[æa]tning|sammans[äa]ttning|kompozycja|composi[çc][ãa]o|slo[zž]en[ií]|koostumus|lichaamsgewicht|ondergewicht|paard|body\s+weight|underweight|lean|severe|horse|storage|advi[cs]e|advice|feeding|analytical|constituents?|ingredients|conseils?|conservation|koel|droog|donker|bewaren|verpakking|hersluiten|bewaaradvies|opbevarings|f[öo]rvarings|przechowanie|skladov[aá]n[ií]|constituintes|analiticos|analytick[eé])\b/iu;

  function germanScore(segment) {
    const words = (String(segment).match(GERMAN_WORDS) || []).length;
    // Umlaute allein entscheiden nicht (Schwedisch, Dänisch, Tschechisch haben sie auch), sie brechen nur Gleichstände.
    return words + (/[äöüßÄÖÜ]/.test(segment) ? 0.5 : 0);
  }

  // Wählt aus „A / B / C“ das eindeutig deutsche Segment; sonst null (Zeile bleibt, wie sie ist).
  // Mengen am Zeilenende („… Lean horse 0,5 kg/dag/Tag/day 1,0 kg/dag/Tag/day“) gehören zu allen Segmenten. Sie werden
  // vor der Wahl abgetrennt; die Einheit behält das deutsche Teilwort („kg/Tag“).
  const TRAILING_AMOUNTS = /^(.*?\S)[ \t]+((?:\d[\d.,]*[ \t]*(?:kg|g)(?:\/\p{L}+)*[ \t]*)+)$/u;
  function germanAmounts(amounts) {
    return amounts.trim().replace(/(\d[\d.,]*)[ \t]*(kg|g)((?:\/\p{L}+)+)/gu, (all, number, unit, tail) => {
      const options = tail.split("/").filter(Boolean);
      const german = options.filter(o => germanScore(o) >= 1);
      return german.length === 1 ? `${number} ${unit}/${german[0]}` : all;
    });
  }

  function germanSegment(line) {
    const trailing = TRAILING_AMOUNTS.exec(line);
    if (trailing && /[ \t]\/[ \t]/.test(trailing[1])) {
      const chosenHead = germanSegment(trailing[1]);
      return chosenHead ? `${chosenHead} ${germanAmounts(trailing[2])}` : null;
    }
    const parts = line.split(/[ \t]\/[ \t]/).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const scores = parts.map(germanScore);
    const best = Math.max(...scores);
    if (best < 1 || scores.filter(x => x === best).length !== 1) return null;
    // Nur zwei Segmente („Tag / Nacht“ ist einsprachig): nur bei deutlichem Vorsprung und sonst ohne deutsche Treffer.
    if (parts.length === 2 && (best < 3 || Math.min(...scores) > 0)) return null;
    const chosen = scores.indexOf(best);
    // Ein deutsches Segment allein genügt nicht (z. B. „Zusammensetzung: Getreide / Mais / Erbsen“): Ein anderes
    // Segment muss erkennbar einer anderen Sprache angehören.
    if (!parts.some((part, index) => index !== chosen && OTHER_LANGUAGE_WORDS.test(part))) return null;
    // „Samenstelling / Zusammensetzung / Composition: Hafer, Gerste“: Die Liste nach dem Doppelpunkt gehört zu allen
    // Überschriften und bleibt erhalten.
    const shared = /^[^:]{1,80}:[ \t]*(\S.*)$/.exec(parts[parts.length - 1]);
    if (shared && chosen !== parts.length - 1 && !parts[chosen].includes(":")) return `${parts[chosen]}: ${shared[1]}`;
    return parts[chosen];
  }


  // ── Analytische Bestandteile in mehrsprachiger Schreibweise ohne Leerzeichen ──
  // „Analytische Bestandteile/Constituants analytiques/… analitici: Protein/Protéine/Eiwit/Proteine 11 % + Fett-
  // gehalt/Teneur en matières grasses/… 5 % + …“: Die Angaben laufen als Fließtext über Zeilenumbrüche, jeder Eintrag
  // nennt den Namen in mehreren Sprachen, durch „/“ ohne Leerzeichen getrennt, danach den Wert. Daraus wird eine
  // deutsche Zeile mit denselben Werten („Analytische Bestandteile: Protein 11 %, Fettgehalt 5 %, …“).
  const ANALYSIS_BLOCK_HEAD = /^[^\p{L}\n]*(?:[A-Z]{1,2}\s+)?Analytische\s+Bestandteile\s*\//u;
  const OCR_LINE_NOISE = /^(?:[=~\-–—_*|<>]+|[A-Z]{1,2})\s+/;
  const ANALYSIS_BLOCK_END = /^(?:[^\p{L}\n]*(?:[A-Z]{1,2}\s+)?)?(?:Ern[äa]hrungsphysiologische|Emn[äa]hrungsphysiologische|Technologische|Zootechnische|Sensorische|Zusatzstoffe|Additifs|Fütterung\w*|Inverkehrbringer|Hersteller|Vertrieb|Importeur|Zusammensetzung|Netto\w*|Inhalt(?![\p{L}])|Füllmenge|Mindestens|MHD|Charge\w*|Los(?:nummer|-Nr)|Kennnummer|Bezugsnummer|Lagerung\w*|Art\.)/iu;
  const GERMAN_ANALYTIC_NAME = /^(?:Roh(?:protein|fett|faser|asche)|Protein|Eiwei[ßs]|Fett(?:gehalt)?|Feuchtigkeit|Feuchtegehalt|Feuchte|Asche|Calcium|Phosphor|Natrium|Kalium|Magnesium|Taurin|Stärke|Zucker|Kohlenhydrate)$/iu;
  const OTHER_ANALYSIS_WORDS = /\b(?:constituants|componenti|bestanddelen|teneur|mati[eè]res|vetgehalte|tenore|materia|cellulose|cellulosa|celstof|ruwe|cendres|ceneri|humidit[eé&]|vocht|umidit[aà]|taurine|taurina|prot[eé&]ine|eiwit|proteine)\b/giu;
  const ANALYSIS_ENTRY = /(.+?)\s+(\d[\d.,]*)\s*(%|mg\/kg|g\/kg)(?![\p{L}\p{N}])/gu;

  // Liefert { text, end } für den Block ab Zeile `start` oder null, wenn kein mehrsprachiger Analyseblock vorliegt.
  function germanAnalysisBlock(lines, start) {
    if (!ANALYSIS_BLOCK_HEAD.test(lines[start].trim())) return null;
    const body = [];
    let end = start;
    for (let k = start; k < lines.length && k < start + 14; k++) {
      const line = lines[k].trim();
      if (!line || (k > start && ANALYSIS_BLOCK_END.test(line))) break;
      body.push(line.replace(OCR_LINE_NOISE, ""));
      end = k;
    }
    // Der Block reicht nur bis zur letzten Zeile mit einem Analysewert. Was danach kommt (ein Hinweissatz, eine Angabe
    // ohne bekannte Überschrift), gehört nicht dazu und bleibt im Text stehen.
    while (body.length > 1 && !/\d\s*(?:%|mg\/kg|g\/kg)/.test(body[body.length - 1])) { body.pop(); end--; }
    // Zeilen zusammenführen; ein Trennstrich am Zeilenende („Fett-“ + „gehalt/…“) verbindet das Wort.
    let joined = "";
    for (const line of body) {
      joined = /\p{L}-$/u.test(joined) && /^\p{Ll}/u.test(line) ? joined.slice(0, -1) + line : (joined ? `${joined} ${line}` : line);
    }
    // Nennt der Block eine abweichende Bezugsbasis (Trockenmasse, „% TS“), bleibt er unverändert: Der Hinweis darf
    // beim Umschreiben nicht verloren gehen, spätere Umrechnungen hängen daran.
    if (ANALYSIS_BASIS_LINE.test(joined)) return null;
    const colon = joined.indexOf(":");
    if (colon < 0) return null;
    const content = joined.slice(colon + 1);
    if ((content.match(OTHER_ANALYSIS_WORDS) || []).length < 2) return null;
    const entries = [];
    let known = 0;
    for (const match of content.matchAll(ANALYSIS_ENTRY)) {
      // Eine Zahl ohne Einheit mitten in den Namen („Protein/… 11 Fettgehalt/… 5 %“) ist ein Wert, dessen Einheit
      // nicht gelesen wurde. Der Eintrag davor entfällt; der Wert gehört nur zu den Namen dahinter.
      const own = match[1].split(/(?:^|\s)\d[\d.,]*\s+(?=\p{L})/u).pop();
      const names = own.replace(/^[\s•·+«»*,;.]+|[\s•·+«»*,;]+$/g, "").split("/").map(n => n.trim());
      // Der deutsche Name aus der Liste; sonst der erste Name des Eintrags (die Überschrift nennt Deutsch zuerst, die
      // Einträge folgen derselben Reihenfolge: „Chlorid/Chloride“, „Schwefel/Sulphur“). Kein Eintrag wird verworfen:
      // Lässt sich einer nicht benennen, bleibt der ganze Block unverändert.
      const listed = names.find(n => GERMAN_ANALYTIC_NAME.test(n));
      const name = listed ?? names[0];
      if (!name || !/^\p{L}[\p{L}\p{N} .()-]{2,40}$/u.test(name)) return null;
      if (listed) known++;
      entries.push(`${name} ${match[2]} ${match[3]}`);
    }
    // Mindestens zwei Einträge mit bekanntem deutschen Namen belegen, dass es diese Schreibweise ist.
    if (known < 2) return null;
    return { text: `Analytische Bestandteile: ${entries.join(", ")}.`, end };
  }

  // ── Überschrift der Zusatzstoffe in mehrsprachiger Schreibweise ohne Leerzeichen ──
  // „Ernährungsphysiologische Zusatzstoffe/⏎Additifs nutritionnels/Nutritionele toevoegingsmiddelen/Additivi
  // nutrizionali⏎(/kg): 200 IE 3a671, …“: Die deutsche Überschrift steht vorn, die Übersetzungen folgen bis zum
  // Doppelpunkt über Zeilenumbrüche hinweg. Daraus wird „Ernährungsphysiologische Zusatzstoffe (/kg): 200 IE 3a671, …“.
  // Die Liste selbst bleibt unverändert.
  const ADDITIVES_BLOCK_HEAD = /^[^\p{L}\n]*((?:(?:Ernährungsphysiologische|Technologische|Zootechnische|Sensorische)\s+)?Zusatzstoffe)\s*\/\s*(.*)$/iu;
  const ADDITIVES_FOREIGN = /\b(?:additi[fv]\w*|additives?|toevoeging\w*|aditivos?|tilsætning\w*|dodatki)\b/i;
  function germanAdditivesBlock(lines, start) {
    const head = ADDITIVES_BLOCK_HEAD.exec(lines[start].trim());
    if (!head) return null;
    let rest = head[2];
    for (let end = start; end < Math.min(lines.length, start + 4); end++) {
      if (end > start) rest += ` ${lines[end].trim()}`;
      const colon = /^([^:]{0,200}?)\s*(\([^():]{0,12}\))?\s*:\s*(.*)$/.exec(rest);
      if (!colon) continue;
      // Vor dem Doppelpunkt stehen nur Übersetzungen der Überschrift, keine Mengen.
      if (/\d/.test(colon[1]) || !ADDITIVES_FOREIGN.test(colon[1])) return null;
      return { end, text: `${head[1]}${colon[2] ? ` ${colon[2]}` : ""}: ${colon[3]}`.trim() };
    }
    return null;
  }

  function germanView(text) {
    const source = String(text || "");
    const lines = source.split(/\r?\n/);
    const taggedScheme = lines.some(l => GERMAN_PREFIX.test(l.trim()));
    const out = [];
    let afterForeign = false;
    for (let i = 0; i < lines.length; i++) {
      const analysis = germanAnalysisBlock(lines, i);
      if (analysis) { out.push(analysis.text); i = analysis.end; continue; }
      const additives = germanAdditivesBlock(lines, i);
      if (additives) { out.push(additives.text); i = additives.end; continue; }
      const line = lines[i].trim();
      // Sprachweise Zeilen („NL …“, „EN …“): nur die deutsche („DE …“) bleibt.
      if (taggedScheme && OTHER_LANGUAGE_PREFIX.test(line)) { afterForeign = true; continue; }
      // Nach der letzten fremdsprachigen Zeile eines Blocks beginnt etwas Neues (meist die nächste mehrsprachige
      // Überschrift, die die Texterkennung oft nur bruchstückhaft liest). Eine Leerzeile trennt den Abschnitt, damit
      // z. B. die Zusammensetzung nicht in die Lagerungshinweise hineinläuft.
      if (afterForeign && line && !GERMAN_PREFIX.test(line)) out.push("");
      afterForeign = false;
      const tagged = GERMAN_PREFIX.exec(line);
      if (tagged && /,\s*\p{L}/u.test(tagged[1])) {
        // Überschrift direkt davor mit der deutschen Liste zusammenführen („Komposition: Luzerne, …“).
        const previous = out[out.length - 1];
        if (previous && /^(?:Zusammensetzung|Komposition)$/iu.test(previous)) out[out.length - 1] = `${previous}: ${tagged[1]}`;
        else out.push(line);
        continue;
      }
      const german = germanSegment(line);
      out.push(german || lines[i]);
    }
    return out.join("\n");
  }

  return { textFromResult, textFromLines, tileGrid, mergeTiles, uprightLines, lineSummaries, bodyHeight, linesQuality, flattenIllumination, estimateSkew, unrotateBox, cleanText, setAdditiveCodes, flattenLines, reorderColumns, filterLine, findTextRegion, orientationScore, needsOrientationCheck, isBetterOrientation, shouldRecoverText, needsFeedingRecovery, recoveryPending, germanView, recoveryRegions, recoveredEvidence };
})();

// Für Unit-Tests unter Node (im Browser ohne Wirkung).
if (typeof module !== "undefined" && module.exports) module.exports = Ocr;
