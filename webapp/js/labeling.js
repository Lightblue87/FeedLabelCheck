/*
 * labeling.js – Portierung von LabelingCheckService, LabelingFeedTypeDetector
 * und SQLiteLabelingRuleRepository (Swift) für den Browser.
 * Benötigt sql.js (global initSqlJs).
 */
"use strict";

const Labeling = (() => {

  const MIN_OCR_LENGTH = 40;

  // ── SQLite-Zugriff ────────────────────────────────────────────
  let db = null;

  let sqlModule = null;

  async function openDatabase(buffer, sqlJsConfig) {
    if (!sqlModule) sqlModule = await initSqlJs(sqlJsConfig);
    if (db) db.close();
    db = new sqlModule.Database(new Uint8Array(buffer));
    return db;
  }

  function queryAll(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function loadFeedTypes() {
    return queryAll("SELECT id, name_de, description_de, keywords_de FROM labeling_feed_types ORDER BY id")
      .map(r => ({
        id: r.id,
        nameDe: r.name_de || r.id,
        descriptionDe: r.description_de,
        keywordsDe: (r.keywords_de || "").split(",").map(s => s.trim()).filter(Boolean),
      }));
  }

  function loadRules(feedTypeId) {
    const rules = queryAll(`
      SELECT id, regulation_id, feed_type_id, title_de, description_de,
             legal_basis, requirement_type, severity, is_mandatory, display_order
      FROM labeling_rules
      WHERE feed_type_id = 'all' OR feed_type_id = ?
      ORDER BY display_order, id`, [feedTypeId]);
    if (!rules.length) return [];

    const placeholders = rules.map(() => "?").join(",");
    const patternRows = queryAll(`
      SELECT id, rule_id, pattern_type, pattern_value, pattern_language,
             confidence_weight, is_negative_pattern
      FROM labeling_rule_patterns
      WHERE rule_id IN (${placeholders})
      ORDER BY rule_id, is_negative_pattern, pattern_language, confidence_weight DESC`,
      rules.map(r => r.id));

    const patterns = new Map();
    for (const p of patternRows) {
      if (!patterns.has(p.rule_id)) patterns.set(p.rule_id, []);
      patterns.get(p.rule_id).push({
        patternType: p.pattern_type || "keyword",
        patternValue: p.pattern_value || "",
        patternLanguage: p.pattern_language || "de",
        confidenceWeight: p.confidence_weight,
        isNegativePattern: !!p.is_negative_pattern,
      });
    }

    return rules.map(r => ({
      id: r.id,
      regulationId: r.regulation_id || "",
      feedTypeId: r.feed_type_id || "",
      titleDe: r.title_de || "",
      descriptionDe: r.description_de || "",
      legalBasis: r.legal_basis || "",
      requirementType: r.requirement_type || "",
      severity: r.severity || "info",
      isMandatory: !!r.is_mandatory,
      displayOrder: r.display_order,
      patterns: patterns.get(r.id) || [],
    }));
  }

  function loadDatabaseInfo() {
    const meta = {};
    try {
      for (const r of queryAll("SELECT key, value FROM labeling_metadata")) meta[r.key] = r.value;
    } catch (e) { /* Tabelle optional */ }
    let ruleCount = 0;
    try {
      ruleCount = queryAll("SELECT COUNT(*) AS c FROM labeling_rules")[0].c;
    } catch (e) { /* leer */ }
    return {
      version: meta.labeling_db_version || "–",
      regulation: meta.labeling_source_regulation || "VO (EG) Nr. 767/2009",
      versionDate: meta.labeling_source_version_date || "–",
      totalRuleCount: ruleCount,
    };
  }

  function searchFeedMaterials(query, limit = 50) {
    const q = `%${query}%`;
    let eu = [], dlg = [];
    try {
      eu = queryAll(`
        SELECT catalog_number, chapter_name_de, name_de,
               COALESCE(description_de,'') AS description_de,
               COALESCE(mandatory_declarations_de,'') AS mandatory_declarations_de,
               COALESCE(restrictions_de,'') AS restrictions_de
        FROM feed_materials
        WHERE name_de LIKE ? COLLATE NOCASE OR catalog_number LIKE ?
        ORDER BY catalog_number LIMIT ?`, [q, q, limit]);
    } catch (e) { /* Tabelle optional */ }
    try {
      dlg = queryAll(`
        SELECT number, group_name_de, name_de,
               COALESCE(description_de,'') AS description_de,
               COALESCE(labeling_de,'') AS labeling_de,
               COALESCE(requirements_de,'') AS requirements_de
        FROM dlg_feed_materials
        WHERE name_de LIKE ? COLLATE NOCASE OR number LIKE ?
        ORDER BY number LIMIT ?`, [q, q, limit]);
    } catch (e) { /* Tabelle optional */ }
    return { eu, dlg };
  }

  // ── Futtermitteltyp-Erkennung (Port des Swift-Detectors) ──────
  const EXTRA_FEED_TERMS = {
    milk_replacer: ["Milchaustauschfuttermittel", "Milchaustausch-Alleinfuttermittel", "Milchaustausch-Ergänzungsfuttermittel"],
    complementary_feed: ["Ergänzungfuttermittel", "Ergaenzungfuttermittel"],
  };
  const EXTRA_FEED_DECLARATIONS = Object.values(EXTRA_FEED_TERMS).flat();
  const SPLIT_FEED_PATTERN = /\b((?:Ergänzungs|Ergaenzungs|Allein)f)[ \t]+(uttermittel)\b/gi;
  const EXTRA_FEED_PATTERN = new RegExp(String.raw`\b(?:${EXTRA_FEED_DECLARATIONS.map(escapeRegex).join("|")})\b`, "i");
  const INDIRECT_FEED_TERMS = new Set(["complete nutrition", "100% complete nutrition", "tranke"]);

  const DIRECT_LEGAL_TERMS = new Set([
    "einzelfuttermittel", "mischfuttermittel", "alleinfuttermittel",
    "allein-futtermittel", "alleinfutter", "diat alleinfuttermittel",
    "diaet alleinfuttermittel", "erganzungsfuttermittel", "ergaenzungsfuttermittel",
    "erganzungsfutermittel", "ergaenzungsfutermittel", "erganzungsfuttermitel",
    "ergaenzungsfuttermitel", "erganzungsfutter", "mineralfuttermittel",
    "mineral-futtermittel", "milchaustauscher", "milch-austauscher",
    ...EXTRA_FEED_DECLARATIONS.map(normalizeText),
  ]);

  function normalizeText(text) {
    return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Ergänzungsfuttermittel müssen den Pflichthinweis "… darf wegen der
  // gegenüber Alleinfuttermitteln höheren Gehalte … nur an … verfüttert
  // werden" tragen (VO (EG) Nr. 767/2009). Das Wort "Alleinfuttermittel"
  // in diesem Vergleich ist KEINE Produktbezeichnung und darf die
  // Typ-Erkennung nicht als mehrdeutig kippen.
  const COMPARISON_MARKERS = ["gegenuber", "gegenueber", "im vergleich zu", "verglichen mit"];

  function containsPhraseOutsideComparison(phrase, text) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(phrase)}([^a-z0-9]|$)`, "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index + m[1].length;
      const before = text.slice(Math.max(0, start - 30), start);
      const after = text.slice(start + phrase.length, start + phrase.length + 40);
      const comparison = COMPARISON_MARKERS.some(marker => before.includes(marker))
        || (/^allein/.test(phrase) && /^\s+hoher(?:e|en|er|es)[, ]+gehalt/.test(after));
      if (!comparison) return true;
      re.lastIndex = start + phrase.length;   // Überlappungen weiter prüfen
    }
    return false;
  }

  function feedTypePriority(id) {
    if (["complete_feed", "complementary_feed", "single_feed", "compound_feed",
         "mineral_feed", "milk_replacer"].includes(id)) return 2.0;
    if (id === "pet_feed") return 0.8;
    return 1.0;
  }

  function keywordScore(keyword, feedTypeId) {
    const nk = normalizeText(keyword);
    if (DIRECT_LEGAL_TERMS.has(nk)) return 2.0;
    if (feedTypeId === "pet_feed") return 0.35;
    return 1.0;
  }

  function rankedCandidates(normalized, feedTypes) {
    if (!normalized) return [];
    return feedTypes
      .filter(ft => ft.id !== "all" && ft.id !== "unknown")
      .map(ft => {
        const keywords = [...new Set([...ft.keywordsDe, ...(EXTRA_FEED_TERMS[ft.id] || [])])];
        const matched = keywords.filter(kw => {
          const nk = normalizeText(kw);
          if (!nk || INDIRECT_FEED_TERMS.has(nk)) return false;
          if (DIRECT_LEGAL_TERMS.has(nk)) return containsPhraseOutsideComparison(nk, normalized);
          return normalized.includes(nk);
        });
        if (!matched.length) return null;
        const bestKeyword = Math.max(...matched.map(kw => keywordScore(kw, ft.id)));
        const score = feedTypePriority(ft.id) + bestKeyword + Math.min(matched.length * 0.05, 0.2);
        const confidence = Math.min(1.0, Math.max(0.55, score / 4.5));
        return { feedType: ft, confidence, matchedKeywords: matched, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.feedType.id.localeCompare(b.feedType.id));
  }

  function hasDirectLegalMatch(result) {
    return result.matchedKeywords.some(kw => DIRECT_LEGAL_TERMS.has(normalizeText(kw)));
  }

  function detectFeedType(ocrText, feedTypes) {
    const normalized = normalizeText(ocrText.replace(SPLIT_FEED_PATTERN, "$1$2"));
    const candidates = rankedCandidates(normalized, feedTypes);
    const best = candidates[0];
    if (!best) return null;
    const milk = candidates.find(c => c.feedType.id === "milk_replacer" && hasDirectLegalMatch(c));
    if (milk && candidates.every(c => ["milk_replacer", "complete_feed"].includes(c.feedType.id)
        || !hasDirectLegalMatch(c))) return milk;
    if (candidates.length > 1 && best.score - candidates[1].score < 0.25) {
      if (hasDirectLegalMatch(best) && !hasDirectLegalMatch(candidates[1])) return best;
      return null;   // mehrdeutig → manuelle Auswahl
    }
    return best;
  }

  // ── Regelprüfung (Port des Swift-Checkers) ────────────────────
  function languagePriority(lang) {
    switch ((lang || "").toLowerCase()) {
      case "de": return 0;
      case "en": return 1;
      default: return 2;
    }
  }

  function languageName(lang) {
    switch ((lang || "").toLowerCase()) {
      case "de": return "Deutsch";
      case "en": return "Englisch";
      default: return "einer weiteren Sprache";
    }
  }

  function keywordMatch(keyword, text, normText) {
    const normalized = normalizeText(keyword);
    const term = keyword.trim();
    let idx;
    if (term === "KG") {
      // KG direkt hinter einer Zahl ist eine Mengeneinheit, keine Rechtsform. Rückwärts über
      // Leerzeichen gehen statt den Text je Treffer zu kopieren (sonst quadratischer Aufwand;
      // Look-behind vermeiden: ältere iOS-Versionen laden die Datei sonst gar nicht).
      idx = -1;
      for (const match of text.matchAll(/\bKG\b/g)) {
        let i = match.index - 1;
        while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
        if (!(i >= 0 && text[i] >= "0" && text[i] <= "9")) { idx = match.index; break; }
      }
    } else if (/^(?:AG|OHG)$/.test(term)) {
      idx = text.search(new RegExp(`\\b${term}\\b`));
    } else if (/^(?:Weg|Platz)$/.test(term)) {
      idx = normText.search(new RegExp(`${term.toLowerCase()}[ \\t]+\\d+\\b`));
    } else {
      idx = normText.indexOf(normalized);
    }
    if (idx < 0) return null;
    // Snippet um den Treffer (auf dem Originaltext; Normalisierung ist längenerhaltend)
    const start = Math.max(0, idx - 20);
    const end = Math.min(text.length, idx + keyword.length + 40);
    return "…" + text.slice(start, end).replace(/\n/g, " ").trim() + "…";
  }

  function regexMatch(pattern, text) {
    let re;
    try { re = new RegExp(pattern, "i"); } catch (e) { return null; }
    const m = re.exec(text);
    if (!m) return null;
    const matched = m[0];
    return matched.length > 80 ? matched.slice(0, 80) + "…" : matched;
  }

  function matchPattern(pattern, text, normText) {
    if (pattern.patternType === "regex") return regexMatch(pattern.patternValue, text);
    return keywordMatch(pattern.patternValue, text, normText);
  }

  const DECIMAL = String.raw`\d+(?:[,.]\d+)?`;
  const PACKAGE_AMOUNT = String.raw`(${DECIMAL})[ \t]*(kg|g|t|ml|l|Liter|Kilogramm|Gramm)\b`;
  const NET_LABEL = "Nettomasse|Nettogewicht|Nettomenge|Nettofüllmenge|Nettoinhalt|Nettovolumen|Packungsinhalt|Füllmenge|Inhalt|Netto|net weight|net contents|net volume|net quantity|poids net|contenu net|peso netto|nettogewicht|netto inhoud|masa netto";
  const NET_AMOUNT = new RegExp(String.raw`\b(?:${NET_LABEL})\b[ \t:)]*\n?[ \t]*(?:[℮e][ \t]*)?${PACKAGE_AMOUNT}`, "i");
  const AMOUNT_LINE = new RegExp(String.raw`^[ \t]*(?:[℮e][ \t]*)?${PACKAGE_AMOUNT}[ \t]*[℮e]?[ \t]*$`, "im");
  const AMOUNT_LINE_ALL = new RegExp(AMOUNT_LINE.source, "gim");
  const PACK_COUNT = new RegExp(String.raw`\([ \t]*(\d+)[ \t]*[×x][ \t]*${PACKAGE_AMOUNT}[ \t]*\)`, "i");
  const NET_HEADING = new RegExp(String.raw`\b(?:${NET_LABEL})\b`, "i");
  const OCR_AMOUNT_HINT = "OCR-Kandidat Packungsmenge: ";
  const MOISTURE_NAME = "Feuchtegehalt|Feuchtigkeitsgehalt|Feuchtigkeit|Feuchte|Wassergehalt|moisture(?: content)?";
  const ANALYTICAL_NAME = `Rohprotein|Rohfett|Rohfaser|Rohasche|Fettgehalt|Calcium|Phosphor|crude protein|crude fat|crude fib(?:re|er)|crude ash|${MOISTURE_NAME}`;

  function needsPackageAmount(text) {
    return !NET_AMOUNT.test(text) && !AMOUNT_LINE.test(text) && (NET_HEADING.test(text) || PACK_COUNT.test(text));
  }

  function packageAmountHint(primaryText, sparseText) {
    const amounts = new Map();
    const pack = primaryText.match(PACK_COUNT);
    const number = value => Number(value.replace(",", "."));
    for (const line of sparseText.split("\n")) {
      const match = line.match(AMOUNT_LINE);
      if (!match) continue;
      const [, amount, unit] = match;
      const value = number(amount);
      if (pack && (unit.toLowerCase() !== pack[3].toLowerCase()
          || Math.abs(value - Number(pack[1]) * number(pack[2])) > 1e-8)) continue;
      amounts.set(`${value} ${unit.toLowerCase()}`, `${amount} ${unit}`);
    }
    return amounts.size === 1 ? OCR_AMOUNT_HINT + amounts.values().next().value : "";
  }

  function percentageEvidence(text, fieldNames) {
    const field = String.raw`\b(?:${fieldNames})\b`;
    const percent = String.raw`${DECIMAL}[ \t|]*%`;
    const pattern = new RegExp(String.raw`${field}[ \t:.·|]*${percent}|\b${percent}[ \t|]*${field}`, "i");
    return text.match(pattern)?.[0] ?? null;
  }

  // Obergrenze je Überschrift: ohne sie kopiert jede Überschrift den Resttext (quadratischer Aufwand).
  const MAX_COMPOSITION_CHARS = 6000;

  function compositionEvidence(text) {
    const heading = /\b(?:[zt]usammensetzung|composition)\b[^:\n]{0,65}:[\s=]*/giu;
    const nextSection = /\n[ \t]*(?:\n|\[(?:DE|EN|FR|IT|NL|PL)\])|\b(?:[zt]usammensetzung|composition)\b[^:\n]{0,65}:|\b(?:Hersteller|Vertrieb|Verantwortlich\w*|Importeur|Hergestellt\s+von|Nettomasse|Nettogewicht|Nettomenge|Inhalt|Chargen?(?:-?Nr\.?|nummer)?|Losnummer|Dosierung|Anwendung)[ \t]*:|\n(?=[^\n]{2,75}\bGmbH\b)|\b(?:Inhaltsstoffe|Hinweise)[ \t]*:|\b(?:Gehalt an Zusatzstoffen|Einsatzempfehlung|Fütterungsempfehlung|Fütterungshinweise?|Fütterungsanleitung|Fütterung|Futtermenge|Tagesration|Feeding(?: guide| instructions?)?|Analytische Bestandteile|Zusatzstoffe|Feuchtegehalt|Lagerungshinweise?|Mindestens haltbar bis|MHD|Feeding recommendation|Analytical constituents|Additives|Best before|Conseils d[’']utilisation|Constituants analytiques|Additifs|Istruzioni per l[’']uso)\b/i;
    for (const match of text.matchAll(heading)) {
      const start = match.index + match[0].length;
      const body = text.slice(start, start + MAX_COMPOSITION_CHARS).split(nextSection, 1)[0].trim();
      if (/^(?:siehe|keine|see)\b|^s\./i.test(body) || !/\p{L}{2,}/u.test(body)) continue;
      if (/\p{L}[^:;,/\n]{0,40}(?:[,;]|[ \t]\/)\s*\p{L}|\d[ \t]*%/u.test(body)) {
        return `${match[0].trim()} ${body}`.replace(/\s+/g, " ");
      }
    }
    return null;
  }

  function structuredEvidence(ruleId, text) {
    if (ruleId === "art15_003") {
      // Eine ℮/e-markierte Menge gilt auch dann, wenn davor andere Mengenzeilen stehen (Fütterungstabelle).
      const markedLine = [...text.matchAll(AMOUNT_LINE_ALL)].map(m => m[0].trim()).find(l => /^[℮e]|[℮e]$/i.test(l));
      return text.match(NET_AMOUNT)?.[0].trim() ?? markedLine ?? null;
    }
    if (ruleId === "art15_002" || ruleId.startsWith("art17_005_")) {
      return text.match(/^\p{L}[\p{L}\p{N} .&'’-]{2,65}[ \t]+(?:N\.?V\.?|B\.?V\.?)[ \t]*\n[^\n]{3,70}\n(?:NL[- \t]+)?\d{4}[ \t]+[A-Z]{2}[ \t]+\p{L}[^\n]{1,40}/mu)?.[0] ?? null;
    }
    if (ruleId === "art15_001") {
      return text.match(EXTRA_FEED_PATTERN)?.[0] ?? text.match(SPLIT_FEED_PATTERN)?.[0] ?? null;
    }
    if (ruleId === "art15_005") return percentageEvidence(text, MOISTURE_NAME);
    if (ruleId.startsWith("art17_004_")) return percentageEvidence(text, ANALYTICAL_NAME);
    if (ruleId === "art16_003" || ruleId.startsWith("art17_001_")) {
      return text.match(/\bfür\s+(?:alle\s+)?(?:Wildvögel|Legehennen|Aufzuchtkälber)\b/i)?.[0] ?? null;
    }
    if (ruleId.startsWith("art17_003_")) return compositionEvidence(text);
    return null;
  }

  const LOT_LABEL = /\b(?:chargen?(?:[ \t-]*(?:nummer|nr))?|los(?:[ \t-]*(?:nummer|nr))?|(?:zulassungsnummer|kennnummer|bezugsnr\.?)\s+der\s+partie|partie(?:[ \t-]*(?:nummer|nr))?|lot(?:[ \t]+no)?|batch(?:[ \t]+(?:number|no))?|L(?=[ \t]*:)|^L(?=[ \t]+[A-Z0-9]))\b\.?[ \t]*(?:[:#\-–][ \t]*\n?[ \t]*|\n[ \t]*)?/gim;
  const LOT_SEGMENT = String.raw`(?=[A-Za-z0-9./-]*\d)[A-Za-z0-9]+(?:[./-][A-Za-z0-9]+)*`;
  const LOT_VALUE = new RegExp(String.raw`^(?:[A-Z]{1,5}[ \t]+)?${LOT_SEGMENT}(?:[ \t]+${LOT_SEGMENT})*(?:[ \t]+[A-Z]{1,5}(?=[ \t]*(?:[;,.\n]|$)))?`);
  const IMPRINT_REFERENCE = /\b(?:mhd|mindestens\s+haltbar\s+bis|chargen[ -]*(?:nr\.?|nummer))(?:\s*\/\s*chargen[ -]*(?:nr\.?|nummer))?\s*:?\s*(?:s\.|siehe)?\s*aufdruck\b/i;

  // Ein einzelnes "L" ist sonst keine Losangabe (10 L 50 …); direkt hinter einem Datum schon: "MHD 20.12.2026 L 123456".
  const DATED_LOT = new RegExp(String.raw`\b\d{1,2}[./-](?:\d{1,2}[./-])?\d{2,4}[ \t]+(L)[ \t]+(${LOT_SEGMENT}(?:[ \t]+${LOT_SEGMENT})*)`);

  // Steht die Losnummer-Überschrift ohne Wert da, folgt in der nächsten Zeile oft ein anderes Feld
  // (MHD …, NETTO 800 g): dessen Name darf nicht als Code gelten. Ein Code wie "NET12345" bleibt erlaubt.
  const NEIGHBOR_FIELD = /^(?:mhd|exp|bbd|best[ \t]+before|mindestens|netto\w*|net|inhalt|gewicht|hersteller|vertrieb|zusammensetzung|analytische|feuchte\w*|tierart)(?![A-Za-z0-9])/i;

  function declaredLot(text) {
    for (const label of text.matchAll(LOT_LABEL)) {
      const code = text.slice(label.index + label[0].length).match(LOT_VALUE)?.[0];
      if (code && !/^\d$/.test(code) && !NEIGHBOR_FIELD.test(code)) return `${label[0].trim()} ${code}`;
    }
    const dated = text.match(DATED_LOT);
    if (dated && !/^\d$/.test(dated[2])) return `${dated[1]} ${dated[2]}`;
    return null;
  }

  /**
   * Ein separat aufgedruckter "PO"-Code (mit mindestens einer Ziffer) kann die
   * Losnummer sein, ist aber kein Beleg: nur als Hinweis, der bestätigt werden muss.
   */
  const PO_LOT_NOTE = "Möglicher Chargencode „PO …“ erkannt. Bitte bestätigen, dass dieser Code die Partie-/Losnummer ist.";
  function possibleLotCode(text) {
    const candidates = new Map();
    for (const [printed, code] of text.matchAll(/\bPO\b[ \t:.-]+((?=[A-Z0-9/-]*\d)[A-Z0-9][A-Z0-9/-]*(?:[ \t]+\d[A-Z0-9/-]*)*)/g)) {
      if (code.replace(/[^A-Z0-9]/g, "").length >= 3) candidates.set(code.replace(/[ \t]+/g, " "), printed);
    }
    return candidates.size === 1 ? candidates.values().next().value : null;
  }

  function needsImprintLot(text) {
    return IMPRINT_REFERENCE.test(text) && !declaredLot(text) && !possibleLotCode(text);
  }

  function matchingImprintLot(first, second) {
    const candidate = possibleLotCode(first);
    const other = possibleLotCode(second);
    return candidate && other && candidate.replace(/[ \t:.-]+/g, " ") === other.replace(/[ \t:.-]+/g, " ")
      ? candidate : null;
  }

  function checkRule(rule, text, normText) {
    const positive = rule.patterns.filter(p => !p.isNegativePattern);
    const negative = rule.patterns.filter(p => p.isNegativePattern);

    if (!positive.length) {
      return { rule, status: "notCheckable", matchedText: null, matchedLanguage: null,
               confidence: 0, note: "Keine Prüfmuster hinterlegt." };
    }

    const hasNegativeMatch = negative.some(p => matchPattern(p, text, normText) !== null);

    const lotRule = rule.id === "art15_004";
    const evidence = lotRule ? declaredLot(text) : structuredEvidence(rule.id, text);
    const po = lotRule && !evidence ? possibleLotCode(text) : null;
    const netQuantity = rule.id === "art15_003";
    const hasNumericEvidence = netQuantity || rule.id.startsWith("art17_004_");
    const packageHint = netQuantity && !evidence
      ? text.split("\n").find(line => line.startsWith(OCR_AMOUNT_HINT))
        || text.match(PACK_COUNT)?.[0] || text.match(AMOUNT_LINE)?.[0].trim()
      : null;
    let best = evidence ? { text: evidence, language: "de", weight: 1, languagePriority: 0 } : null;
    const hint = po || packageHint;
    if (hint) best = { text: hint, language: "de", weight: 0.7, languagePriority: 0 };
    for (const p of positive) {
      if (rule.id === "art15_001" && p.patternType === "keyword" && normalizeText(p.patternValue) === "milk replacer"
          && !/^[ \t]*(?:(?:calf|lamb|kid)[ \t]+)?milk replacer(?:[ \t]+for[ \t]+[^\n]+)?[ \t]*$/im.test(text)) continue;
      // Allgemeine Zahlenmuster können Futterrationen, einzelne Ziffern oder Fragmente erfassen.
      if (p.patternType === "regex" && (hasNumericEvidence || (lotRule && p.confidenceWeight >= 0.85))) continue;
      const weight = netQuantity ? Math.min(p.confidenceWeight, 0.7) : p.confidenceWeight;
      const m = matchPattern(p, text, normText);
      if (m !== null) {
        const prio = languagePriority(p.patternLanguage);
        if (!best || prio < best.languagePriority
            || (prio === best.languagePriority && weight > best.weight)) {
          best = { text: m, language: p.patternLanguage, weight, languagePriority: prio };
        }
      }
    }

    if (hasNegativeMatch) {
      return { rule, status: "unclear", matchedText: best?.text ?? null,
               matchedLanguage: best?.language ?? null, confidence: 0.3,
               note: "Ausschlussmuster erkannt – manuelle Prüfung empfohlen." };
    }

    if (!best) {
      return { rule, status: "missing", matchedText: null, matchedLanguage: null,
               confidence: 0, note: "Im Prüftext nicht erkannt. Bitte Etikett manuell prüfen." };
    }

    const status = best.weight >= 0.85 ? "found" : "probablyFound";
    const notes = [];
    if (best.language !== "de") notes.push(`Hinweis wurde in ${languageName(best.language)} gefunden.`);
    if (status === "probablyFound") {
      const imprint = (rule.id === "art15_004" || rule.id === "art16_002" || rule.id.startsWith("art17_002_"))
        && IMPRINT_REFERENCE.test(text);
      if (imprint && !po) notes.push("Verweis auf Aufdruck erkannt. Bitte Aufdruck separat fotografieren oder den Wert im Prüftext ergänzen.");
      if (po) notes.push(PO_LOT_NOTE);
      if (!imprint && !po) notes.push("Indirekter Treffer erkannt – Etikett bitte manuell bestätigen.");
    }
    return { rule, status, matchedText: best.text, matchedLanguage: best.language,
             confidence: best.weight, note: notes.join(" ") || null };
  }

  function overallStatus(results) {
    if (results.every(r => r.status === "notCheckable")) return "nichtPruefbar";
    if (results.some(r => r.rule.severity === "critical" && r.status === "missing")) return "auffaellig";
    const hasCriticalUncertain = results.some(r =>
      r.rule.severity === "critical" && (r.status === "probablyFound" || r.status === "unclear"));
    const hasUnclear = results.some(r => r.status === "unclear");
    const hasWarningMissing = results.some(r => r.rule.severity === "warning" && r.status === "missing");
    if (hasCriticalUncertain || hasUnclear || hasWarningMissing) return "unklar";
    return "keineAuffaelligkeit";
  }

  function check(ocrText, feedType, rules) {
    if (ocrText.length < MIN_OCR_LENGTH) {
      return {
        feedType,
        ruleResults: rules.map(rule => ({
          rule, status: "notCheckable", matchedText: null, matchedLanguage: null,
          confidence: 0, note: "Text zu kurz für eine Prüfung.",
        })),
        overallStatus: "nichtPruefbar",
      };
    }
    const normText = normalizeText(ocrText);
    const ruleResults = rules.map(rule => checkRule(rule, ocrText, normText));
    return { feedType, ruleResults, overallStatus: overallStatus(ruleResults) };
  }

  return {
    openDatabase, loadFeedTypes, loadRules, loadDatabaseInfo,
    searchFeedMaterials, detectFeedType, check, needsPackageAmount, packageAmountHint,
    needsImprintLot, matchingImprintLot, MIN_OCR_LENGTH,
  };
})();

// Für Unit-Tests unter Node (im Browser ohne Wirkung).
if (typeof module !== "undefined" && module.exports) module.exports = Labeling;
