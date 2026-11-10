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
    return null;
  }

  // Ein an der Spaltenlücke getrenntes Stück übernimmt die Entscheidung der ursprünglichen Zeile: Hat die ganze Zeile
  // den Konfidenzfilter bestanden, wird ein einzelnes Wort der einen Spalte nicht nachträglich verworfen.
  const fragmentOrigin = new WeakMap();

  /** Ordnet die Zeilen eines zweispaltigen Etiketts spaltenweise (links, dann rechts). */
  function reorderColumns(lines) {
    const gutter = findColumnGutter(lines);
    if (!gutter) return lines;
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
  function textFromResult(data) {
    if (data && Array.isArray(data.blocks) && data.blocks.length) {
      const kept = reorderColumns(flattenLines(data.blocks)).map(words => {
        const origin = fragmentOrigin.get(words);
        if (!origin) return filterLine(words);
        // Stück einer getrennten Zeile: gilt, wenn die ursprüngliche Zeile gilt; nur schwache Randwörter fallen weg.
        if (!filterLine(origin)) return null;
        const kept = words.filter(w => w.confidence >= WORD_MIN_CONFIDENCE || countAlnum(w.text) >= WORD_MIN_ALNUM);
        return kept.length ? kept.map(w => w.text).join(" ") : null;
      }).filter(Boolean);
      if (kept.length) return cleanText(kept.join("\n"));
    }
    return cleanText(data && data.text ? data.text : "");
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
    return text.replace(/\(([1-4])([0-9])(\d{2,3}[a-z]{0,3})\)/gi, (whole, group, second, rest) => {
      if (knownAdditiveCodes.has(`${group}${second}${rest}`.toLowerCase())) return whole;
      // Kandidaten aus der gesamten Liste: gleiche Gruppenziffer und gleicher Rest, beliebiger Buchstabe.
      const wanted = new RegExp(`^${group}([a-z])${rest.toLowerCase()}$`);
      const hits = [...knownAdditiveCodes].map(code => wanted.exec(code)).filter(Boolean).map(match => match[1]);
      return hits.length === 1 ? `(${group}${hits[0]}${rest})` : whole;
    });
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

  function shouldRecoverText(text) {
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
    return regions.map(([left, top, right, bottom, magnify]) => ({
      x: Math.floor(left * width), y: Math.floor(top * height),
      right: Math.ceil(right * width), bottom: Math.ceil(bottom * height),
      // Canvas auf Mobilgeräten begrenzen, ohne die Ausschnittgeometrie zu ändern.
      scale: Math.min(magnify, 2800 / Math.max((right - left) * width, (bottom - top) * height)),
    }));
  }

  const CZECH_ANALYSIS_LINE = /^(?:Hrub[yýáée]\s+(?:protein|tuk|vl[aá]knina|popel)|(?:Cukr|[ŠS]krob|V[aá]pn[ií]k|Fosfor|Sod[ií]k|Drasl[ií]k|Hor[cč][ií]k))\s+[\d.,]+\s*%/iu;
  const GERMAN_ANALYSIS_LINE = /^(?:Rohprotein|Rohfett|Rohfaser|Rohasche|Calcium|Phosphor|Natrium|Kalium|Magnesium|Zucker|Stärke)\s+[\d.,]+\s*%/iu;
  const GERMAN_INGREDIENT_LINE = /^DE\s+(\p{L}[^\n]{20,240})$/iu;
  const COMPOSITION_HEAD = /^(?:Samenstelling|Komposition|Composition|Zusammensetzung)\s*\/[^\n]{6,260}$/iu;

  /**
   * Nur spezifische neue Belegzeilen übernehmen, niemals generischen OCR-Müll
   * oder abgeleitete/hinzugedichtete Angaben. Werte bleiben Original-OCR.
   * Rückgabe kann eine vollständige echte DE-Zutatenzeile und unterstützende
   * fremdsprachige Analysenzeilen enthalten, aber keinen Konformitätsstatus.
   */
  function recoveredEvidence(primary, candidate) {
    const lines = String(candidate || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const existing = new Set(String(primary || "").split(/\r?\n/)
      .map(l => l.toLowerCase().replace(/\s+/g, " ").trim()));
    const novel = line => !existing.has(line.toLowerCase().replace(/\s+/g, " ").trim());
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const german = GERMAN_INGREDIENT_LINE.exec(lines[i]);
      if (german && german[1].split(/[,;]/).filter(x => /\p{L}{3,}/u.test(x)).length >= 3 && novel(lines[i])) {
        const heading = lines.slice(Math.max(0, i - 11), i).reverse().find(l => COMPOSITION_HEAD.test(l));
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
        if (novel(heading)) out.push(heading);
        out.push(...analysis.slice(0, 14));
      }
    }
    return [...new Set(out)].join("\n");
  }

  return { textFromResult, cleanText, setAdditiveCodes, flattenLines, reorderColumns, filterLine, findTextRegion, orientationScore, needsOrientationCheck, isBetterOrientation, shouldRecoverText, recoveryRegions, recoveredEvidence };
})();

// Für Unit-Tests unter Node (im Browser ohne Wirkung).
if (typeof module !== "undefined" && module.exports) module.exports = Ocr;
