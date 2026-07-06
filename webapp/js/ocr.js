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
                         confidence: typeof w.confidence === "number" ? w.confidence : 0 }));
          if (words.length) lines.push(words);
        }
      }
    }
    return lines;
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
      const kept = flattenLines(data.blocks).map(filterLine).filter(Boolean);
      if (kept.length) return cleanText(kept.join("\n"));
    }
    return cleanText(data && data.text ? data.text : "");
  }

  // Zusatzstoff-Codes wie (3a671) liest die OCR oft falsch:
  // das "a" als "3" → (33671), das "b" als "5" → (35506).
  // Fünfstellige Zahlen in Klammern, die mit 33/35 beginnen, kommen auf
  // Futtermitteletiketten sonst nicht vor.
  const ADDITIVE_CODE_FIXES = [
    [/\(3\s*3(\d{3}[a-z]{0,3})\)/gi, "(3a$1)"],
    [/\(3\s*5(\d{3}[a-z]{0,3})\)/gi, "(3b$1)"],
  ];

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
    return cleaned;
  }

  return { textFromResult, cleanText, flattenLines, filterLine };
})();

// Für Unit-Tests unter Node (im Browser ohne Wirkung).
if (typeof module !== "undefined" && module.exports) module.exports = Ocr;
