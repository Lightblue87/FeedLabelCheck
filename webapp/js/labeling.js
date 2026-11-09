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
    mineral_feed: ["Mieszanka paszowa mineralna"],
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

  const DIET_DECLARATION = /\b(?:di(?:ä|ae?)t[\s‐‑–-]*(allein|ergänzungs|ergaenzungs)[\s‐‑–-]*futtermittel|(complete|complementary)\s+diet(?:etic|ic)\s+(?:pet\s+food|(?:pet\s+)?feed(?:ingstuff)?)|diet(?:etic|ic)\s+(complete|complementary)\s+(?:pet\s+food|(?:pet\s+)?feed(?:ingstuff)?)|(?:aliment\s+di[ée]t[ée]tique\s+)(complet|compl[ée]mentaire))\b/giu;

  function declaredDiet(text, feedTypes) {
    const declarations = new Map();
    for (const [wording, de, enFirst, enSecond, fr] of text.matchAll(DIET_DECLARATION)) {
      const complete = /^(?:allein|complete|complet)$/i.test(de || enFirst || enSecond || fr);
      const typeId = complete ? "complete_feed" : "complementary_feed";
      const feedType = feedTypes.find(type => type.id === typeId);
      if (feedType && !declarations.has(typeId)) declarations.set(typeId, { feedType, wording });
    }
    return [...declarations.values()];
  }

  function detectFeedType(ocrText, feedTypes) {
    const diets = declaredDiet(ocrText, feedTypes);
    if (diets.length > 1) return null;
    if (diets.length === 1) {
      const { feedType, wording } = diets[0];
      return { feedType, confidence: 0.9, matchedKeywords: [wording], score: 4.05 };
    }
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
      // KG hinter einer Zahl oder in „je/pro kg“ bezeichnet keine Rechtsform. Rückwärts über
      // Leerzeichen gehen statt den Text je Treffer zu kopieren (sonst quadratischer Aufwand;
      // Look-behind vermeiden: ältere iOS-Versionen laden die Datei sonst gar nicht).
      idx = -1;
      for (const match of text.matchAll(/\bKG\b/g)) {
        let i = match.index - 1;
        while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
        if (i >= 0 && text[i] >= "0" && text[i] <= "9") continue;
        if (/\b(?:je|pro|per|each)\s*$/i.test(text.slice(Math.max(0, i - 5), i + 1))) continue;
        idx = match.index;
        break;
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
  const NET_PREFIX = String.raw`\b(?:${NET_LABEL})\b[ \t:)]*(?:/[ \t]*)?\n?[ \t]*`;
  const NET_AMOUNT = new RegExp(String.raw`${NET_PREFIX}(?:[℮e][ \t]*)?${PACKAGE_AMOUNT}(?![ \t]*(?:[/=×]|x[ \t]*\d))`, "i");
  const PACK_TOTAL = new RegExp(String.raw`${NET_PREFIX}(\d+)[ \t]*[×x][ \t]*${PACKAGE_AMOUNT}[ \t]*[℮e©]?[ \t]*=[ \t]*${PACKAGE_AMOUNT}`, "i");
  const amountNumber = value => Number(value.replace(",", "."));
  const METRIC_EQUIVALENT = new RegExp(String.raw`${NET_PREFIX}(${DECIMAL})[ \t]*(lbs?|Ib|oz)[ \t]*\((${DECIMAL})[ \t]*(kg|g)\)`, "gi");
  const MARKED_DUAL_AMOUNT = new RegExp(String.raw`^[ \t]*${PACKAGE_AMOUNT}[ \t]*\/[ \t]*${PACKAGE_AMOUNT}[ \t]*[℮e][ \t]*$`, "gim");
  const NET_UNITS = {
    g: ["mass", 1], gramm: ["mass", 1], kg: ["mass", 1000], kilogramm: ["mass", 1000], t: ["mass", 1000000],
    ml: ["volume", 1], l: ["volume", 1000], liter: ["volume", 1000],
  };
  const AMOUNT_LINE = new RegExp(String.raw`^[ \t]*(?:[℮e][ \t]*)?${PACKAGE_AMOUNT}[ \t]*[℮e]?[ \t]*$`, "im");
  const AMOUNT_LINE_ALL = new RegExp(AMOUNT_LINE.source, "gim");
  const PACK_COUNT = new RegExp(String.raw`\([ \t]*(\d+)[ \t]*[×x][ \t]*${PACKAGE_AMOUNT}[ \t]*\)`, "i");
  const NET_TERM = String.raw`\b(?:${NET_LABEL})\b`;
  const NET_HEADING = new RegExp(String.raw`${NET_TERM}(?:[ \t]*/[ \t]*${NET_TERM})*`, "i");
  const OCR_AMOUNT_HINT = "OCR-Kandidat Packungsmenge: ";
  const MOISTURE_NAME = "Feuchtegehalt|Feuchtigkeitsgehalt|Feuchtigkeit|Feuchte|Wassergehalt|moisture(?: content)?|humidit[ée6]";
  const ANALYTICAL_NAME = "Rohprotein|Rohfett|Rohfaser|Rohasche|Fettgehalt|Calcium|Phosphor|crude protein|crude fat|crude fib(?:re|er)|crude ash";

  function declaredNetAmounts(text) {
    const amounts = new Map();
    const add = (amount, unit, evidence) => {
      const [dimension, factor] = NET_UNITS[unit.toLowerCase()];
      const value = amountNumber(amount) * factor;
      if (!Number.isFinite(value) || value <= 0) return;
      const numeric = /^[1-9]\d*\.\d{3}$/.test(amount) ? `${amount} ${unit}` : value.toPrecision(12);
      const key = `${dimension}:${numeric}`;
      if (!amounts.has(key)) amounts.set(key, { dimension, evidence });
    };
    for (const [, count, perPack, unit, total, totalUnit] of text.matchAll(new RegExp(PACK_TOTAL.source, "gi"))) {
      if (unit.toLowerCase() === totalUnit.toLowerCase()
          && !/\.\d{3}$/.test(perPack) && !/\.\d{3}$/.test(total)
          && Math.abs(amountNumber(total) - Number(count) * amountNumber(perPack)) < 1e-8) {
        add(total, totalUnit, `${total} ${totalUnit}`);
      }
    }
    for (const [evidence, amount, unit] of text.matchAll(new RegExp(NET_AMOUNT.source, "gi"))) {
      add(amount, unit, evidence.trim());
    }
    for (const [, customary, customaryUnit, amount, unit] of text.matchAll(METRIC_EQUIVALENT)) {
      const grams = amountNumber(amount) * NET_UNITS[unit.toLowerCase()][1];
      const equivalent = amountNumber(customary) * (customaryUnit.toLowerCase() === "oz" ? 28.349523125 : 453.59237);
      // Die Übereinstimmung ist eine OCR-Plausibilitätsprüfung für gerundete Doppelaufdrucke.
      if (Math.abs(grams - equivalent) <= equivalent * 0.01) add(amount, unit, `${amount} ${unit}`);
    }
    for (const [evidence, amount, unit] of text.matchAll(AMOUNT_LINE_ALL)) {
      if (/^[℮e]|[℮e]$/i.test(evidence.trim())) add(amount, unit, evidence.trim());
    }
    for (const [, amount, unit, secondary, secondaryUnit] of text.matchAll(MARKED_DUAL_AMOUNT)) {
      if (NET_UNITS[unit.toLowerCase()][0] === NET_UNITS[secondaryUnit.toLowerCase()][0]) continue;
      add(amount, unit, `${amount} ${unit}`);
      add(secondary, secondaryUnit, `${secondary} ${secondaryUnit}`);
    }
    return [...amounts.values()];
  }

  function netAmountConflict(amounts) {
    return new Set(amounts.map(amount => amount.dimension)).size < amounts.length;
  }

  function declaredNetAmount(text) {
    const amounts = declaredNetAmounts(text);
    return netAmountConflict(amounts) ? null : amounts.map(amount => amount.evidence).join(" / ") || null;
  }

  function needsPackageAmount(text) {
    return !declaredNetAmounts(text).length && !AMOUNT_LINE.test(text) && (NET_HEADING.test(text) || PACK_COUNT.test(text));
  }

  function packageAmountHint(primaryText, sparseText) {
    const amounts = new Map();
    const pack = primaryText.match(PACK_COUNT);
    for (const line of sparseText.split("\n")) {
      const match = line.match(AMOUNT_LINE);
      if (!match) continue;
      const [, amount, unit] = match;
      const value = amountNumber(amount);
      if (pack && (unit.toLowerCase() !== pack[3].toLowerCase()
          || Math.abs(value - Number(pack[1]) * amountNumber(pack[2])) > 1e-8)) continue;
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

  const MOISTURE_READING = String.raw`\b(?:${MOISTURE_NAME})(?![\p{L}\p{N}])[ \t:.;·|]*(${DECIMAL})[ \t|]*%`;
  const OCR_MOISTURE_HINT = "OCR-Nachprüfung Feuchtewert: ";

  function declaredMoisture(text) {
    const matches = new Map();
    for (const [evidence, amount] of text.matchAll(new RegExp(MOISTURE_READING, "giu"))) {
      const key = amountNumber(amount);
      if (!matches.has(key)) matches.set(key, evidence);
    }
    return [...matches.values()];
  }

  function moistureCropHint(primary, first, second) {
    const pattern = new RegExp(MOISTURE_READING, "iu");
    const a = first.match(pattern);
    const b = second.match(pattern);
    const previous = primary.match(pattern);
    if (!a || !b || !previous) return "";
    const value = amountNumber(a[1]);
    return value >= 0 && value < 100 && value === amountNumber(b[1]) && value !== amountNumber(previous[1])
      ? `${OCR_MOISTURE_HINT}${a[1]} %` : "";
  }

  function moistureHints(text) {
    return [...new Set(text.split("\n").filter(line => line.startsWith(OCR_MOISTURE_HINT)
      && /^\d+(?:[,.]\d+)?[ \t]*%$/.test(line.slice(OCR_MOISTURE_HINT.length))))];
  }


  function moistureValue(evidence) {
    return amountNumber(evidence.match(/\d+(?:[,.]\d+)?(?=[ \t|]*%)/)[0]);
  }

  function moistureConflict(declared, hints) {
    return new Set([...declared, ...hints].map(moistureValue)).size > 1;
  }

  // Obergrenze je Überschrift: ohne sie kopiert jede Überschrift den Resttext (quadratischer Aufwand).
  const MAX_COMPOSITION_CHARS = 6000;

  // Mehrsprachige Tabellen führen die Zutaten sprachweise in eigenen Zeilen auf.
  const MULTILINGUAL_COMPOSITION = /^((?:Samenstelling|Komposition|Composition|Zusammensetzung)[ \t]*\/[ \t]*[^\n]{1,240})\n(?:(?:NL|EN|FR|IT|ES|DA|SE|PL|PT|CZ)[ \t]+[^\n]+\n){0,10}DE[ \t]+([^\n]+)/im;
  const FEEDING_TABLE_HEADING = /\b(?:Feeding[ \t]+(?:advice|guide)|Fütterungsempfehlung)\b[^\n]*/i;

  function compositionEvidence(text) {
    const listed = text.match(MULTILINGUAL_COMPOSITION);
    if (listed && /,\s*\p{L}/u.test(listed[2])) return `${listed[1]}: ${listed[2]}`;
    const heading = /\b(?:[zt]usammensetzung|composition)\b[^:\n]{0,65}:[\s=]*|^(?:(?:[zt]usammensetzung|composition)[ \t]*|ingredients[ \t]*:?[ \t]*)\n/gimu;
    const nextSection = /\n[ \t]*(?:\n|\[(?:DE|EN|FR|IT|NL|PL)\])|\b(?:[zt]usammensetzung|composition|ingredients)\b[^:\n]{0,65}:|\n[ \t]*(?:[zt]usammensetzung|composition|ingredients)[ \t]*\n|\n[ \t]*crude protein[ \t:]*[<>]?[ \t]*\d|\b(?:Hersteller|Vertrieb|Verantwortlich\w*|Importeur|Hergestellt\s+von|Nettomasse|Nettogewicht|Nettomenge|Inhalt|Chargen?(?:-?Nr\.?|nummer)?|Losnummer|Dosierung|Anwendung)[ \t]*:|\n(?=[^\n]{2,75}\bGmbH\b)|\b(?:Inhaltsstoffe|Hinweise)[ \t]*:|\b(?:Gehalt an Zusatzstoffen|Einsatzempfehlung|Fütterungsempfehlung|Fütterungshinweise?|Fütterungsanleitung|Fütterung|Futtermenge|Tagesration|Feeding(?: guide| instructions?)?|Analytische Bestandteile|Zusatzstoffe|Feuchtegehalt|Lagerungshinweise?|Mindestens haltbar bis|MHD|Feeding recommendation|Analytical constituents|Additives|Best before|Conseils d[’']utilisation|Constituants analytiques|Additifs|Istruzioni per l[’']uso)\b/i;
    for (const match of text.matchAll(heading)) {
      const start = match.index + match[0].length;
      let body = text.slice(start, start + MAX_COMPOSITION_CHARS).split(nextSection, 1)[0].trim();
      if (/^[zt]usammensetzung\b/i.test(match[0])) {
        // Bei nebeneinander gedruckten Sprachen kann die französische Typzeile
        // zwischen einer deutschen Zutat und ihrem prozentualen Anteil landen.
        body = body.replace(/[ \t]+aliment\s+(?:complet|compl[ée]mentaire)\s+pour\s+(?:chats|chiens)(?:\s+adultes?)?(?=\s*\(\s*\d+(?:[,.]\d+)?\s*%\s+davon\b)/gi, "");
      }
      if (/^(?:siehe|keine|see)\b|^s\./i.test(body) || !/\p{L}{2,}/u.test(body)) continue;
      if (/\p{L}[^:;,/\n]{0,40}(?:[,;]|[ \t]\/)\s*\p{L}|\d[ \t]*%/u.test(body)) {
        return `${match[0].trim()} ${body}`.replace(/\s+/g, " ");
      }
    }
    return null;
  }

  function needsCompositionCrop(text) {
    return FEEDING_TABLE_HEADING.test(text) && /\b(?:Körpergewicht|body weight|lichaamsgewicht)\b/i.test(text)
      && !compositionEvidence(text);
  }

  function compositionCropHint(text) {
    const listed = text.match(MULTILINGUAL_COMPOSITION);
    if (listed && /,\s*\p{L}/u.test(listed[2])) return `${listed[1]}\nDE ${listed[2]}`;
    return compositionEvidence(text) ?? "";
  }

  function postalAddressEvidence(text) {
    // Eine PLZ braucht erkennbaren Adresskontext. Ein Zahlenwert vor einer Einheit oder
    // Zutatenbezeichnung kann sonst wie eine PLZ aussehen.
    return text.match(/(?:\b(?:DE?|FR?|AT|PL|NL|BE|CH)[ -]+|(?:\b\p{L}[\p{L}-]*(?:straße|str\.|weg|platz)|\b(?:rue|avenue)\b[^,\n]{2,55})[ \t]+\d+[a-z]?[ \t]*,?[ \t]+)\d{5}[ \t]+[A-ZÄÖÜ][\p{L}-]{2,}(?![\p{L}\p{N}/])/u)?.[0] ?? null;
  }

  function structuredEvidence(ruleId, text) {
    if (ruleId === "art15_002" || ruleId.startsWith("art17_005_")) {
      return text.match(/^\p{L}[\p{L}\p{N} .&'’-]{2,65}[ \t]+(?:N\.?V\.?|B\.?V\.?)[ \t]*\n[^\n]{3,70}\n(?:NL[- \t]+)?\d{4}[ \t]+[A-Z]{2}[ \t]+\p{L}[^\n]{1,40}/mu)?.[0] ?? postalAddressEvidence(text);
    }
    if (ruleId === "art15_001") {
      return text.match(DIET_DECLARATION)?.[0] ?? text.match(EXTRA_FEED_PATTERN)?.[0] ?? text.match(SPLIT_FEED_PATTERN)?.[0] ?? text.match(/\bAlleinfutter[ \t]+für\b/i)?.[0] ?? null;
    }
    if (ruleId === "art15_005") return percentageEvidence(text, MOISTURE_NAME);
    if (ruleId.startsWith("art17_004_")) {
      const fields = moistureConflict(declaredMoisture(text), moistureHints(text)) ? ANALYTICAL_NAME : `${ANALYTICAL_NAME}|${MOISTURE_NAME}`;
      return percentageEvidence(text, fields);
    }
    if (ruleId === "art16_003" || ruleId.startsWith("art17_001_")) {
      return text.match(/\bfür\s+(?:alle\s+)?(?:Wildvögel|Legehennen|Aufzuchtkälber|(?:Süßwasser)?Zierfische|Wasserschildkröten(?:[ \t]+und[ \t]+Echsen)?)\b/i)?.[0] ?? null;
    }
    if (ruleId.startsWith("art17_003_")) return compositionEvidence(text);
    return null;
  }

  const LOT_LABEL = /\b(?:chargen?(?:[ \t-]*(?:nummer|nr))?|los(?:[ \t-]*(?:nummer|nr))?|(?:zulassungsnummer|kennnummer|bezugsnr\.?)\s+der\s+partie|partie(?:[ \t-]*(?:nummer|nr))?|lot(?:[ \t]+(?:no|number(?=[ \t]*[:#\n])))?|batch(?:[ \t]+(?:number|no))?|L(?=[ \t]*:)|^L(?=[ \t]+[A-Z0-9]))\b\.?[ \t]*(?:[:#\-–][ \t]*\n?[ \t]*|\n[ \t]*)?/gim;
  const LOT_SEGMENT = String.raw`(?=[A-Za-z0-9./-]*\d)[A-Za-z0-9]+(?:[./-][A-Za-z0-9]+)*`;
  const LOT_VALUE = new RegExp(String.raw`^(?:[A-Z]{1,5}[ \t]+)?${LOT_SEGMENT}(?:[ \t]+${LOT_SEGMENT})*(?:[ \t]+[A-Z]{1,5}(?=[ \t]*(?:[;,.\n]|$)))?`);
  const IMPRINT_REFERENCE = /\b(?:mhd|mindestens\s+haltbar\s+bis|chargen[ -]*(?:nr\.?|nummer))(?:\s*\/\s*chargen[ -]*(?:nr\.?|nummer))?\s*:?\s*(?:s\.|siehe)?\s*aufdruck\b/i;

  const LOT_PRINT_FIELD = String.raw`chargen?(?:[ \t-]*(?:nr\.?|nummer))?|los(?:[ \t-]*(?:nr\.?|nummer))?|bezugs(?:nummer|nr\.?)\s+der\s+partie|lot[ \t]+(?:no\.?|number)|batch(?:[ \t]+(?:no\.?|number))?`;
  const DATE_PRINT_FIELD = String.raw`mhd|mindestens\s+haltbar\s+bis|best\s+before(?:\s+end)?|expiry\s+date`;
  const PRINT_FIELD = String.raw`(?:${LOT_PRINT_FIELD}|${DATE_PRINT_FIELD})`;
  const PRINT_REFERENCE = new RegExp(String.raw`\b(${PRINT_FIELD})(?:[ \t]*(?:[,/]|und\b|and\b)[ \t]*(${PRINT_FIELD}))?[ \t:.]*\n?[ \t]*(?:siehe|s\.|see)\s+(aufdruck|stempel|(?:behälter|packungs)?boden|(?:container|packaging)\s+(?:bottom|base)|imprint|stamp)\b`, "gi");

  function imprintReference(text, isLot) {
    const fieldPattern = new RegExp(String.raw`^(?:${isLot ? LOT_PRINT_FIELD : DATE_PRINT_FIELD})$`, "i");
    for (const [evidence, first, second, printedPlace] of text.matchAll(PRINT_REFERENCE)) {
      if (!fieldPattern.test(first) && !fieldPattern.test(second || "")) continue;
      const rawPlace = printedPlace.toLowerCase();
      const place = /bottom|base/.test(rawPlace) ? "Behälterboden" : rawPlace === "imprint" ? "Aufdruck"
        : rawPlace === "stamp" ? "Stempel" : rawPlace[0].toUpperCase() + rawPlace.slice(1);
      return { evidence: evidence.replace(/\s+/g, " "), place };
    }
    return null;
  }

  const EXPIRY_MARKER = String.raw`(?:${DATE_PRINT_FIELD}|mindesthaltbar\s+bis|verwendbar\s+bis|haltbar\s+bis|BBD|BBE|EXP)`;
  const EXPLICIT_EXPIRY = new RegExp(String.raw`\b${EXPIRY_MARKER}(?:[ \t]+Ende)?[ \t:]*\n?[ \t]*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{1,2}[./-]\d{4})\b(?![./-]\d)`, "gi");

  function declaredExpiry(text) {
    const dates = new Map();
    const invalid = new Set();
    for (const [evidence, rawDate] of text.matchAll(EXPLICIT_EXPIRY)) {
      const parts = rawDate.split(/[./-]/);
      const hasDay = parts.length === 3;
      const [rawDay, rawMonth, rawYear] = !hasDay ? ["0", ...parts]
        : parts[0].length === 4 ? [...parts].reverse() : parts;
      const year = Number(rawYear) + (rawYear.length === 2 ? 2000 : 0);
      const month = Number(rawMonth);
      const day = Number(rawDay);
      const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
      if (year < 1000 || !daysInMonth || (hasDay && (day < 1 || day > daysInMonth))) {
        invalid.add(evidence);
        continue;
      }
      const key = `${year}-${month}-${day}`;
      if (!dates.has(key)) dates.set(key, { month: `${year}-${month}`, day, evidence });
    }
    const valid = [...dates.values()];
    const conflict = new Set(valid.map(date => date.month)).size > 1
      || new Set(valid.filter(date => date.day).map(date => date.day)).size > 1;
    return {
      evidence: (valid.find(date => date.day) ?? valid[0])?.evidence,
      review: conflict || invalid.size ? [...valid.map(date => date.evidence), ...invalid].join(" / ") : null,
      note: conflict ? "Unterschiedliche Haltbarkeitsdaten im Prüftext. Bitte Originaletikett prüfen."
        : "Kein gültiges Kalenderdatum für die erkannte Angabe. Bitte Originaletikett prüfen.",
    };
  }

  // Ein einzelnes "L" ist sonst keine Losangabe (10 L 50 …); direkt hinter einem Datum schon: "MHD 20.12.2026 L 123456".
  const DATED_LOT = new RegExp(String.raw`\b\d{1,2}[./-](?:\d{1,2}[./-])?\d{2,4}[ \t]+(L)[ \t]+(${LOT_SEGMENT}(?:[ \t]+${LOT_SEGMENT})*)`);

  // Steht die Losnummer-Überschrift ohne Wert da, folgt in der nächsten Zeile oft ein anderes Feld
  // (MHD …, NETTO 800 g): dessen Name darf nicht als Code gelten. Ein Code wie "NET12345" bleibt erlaubt.
  const NEIGHBOR_FIELD = /^(?:mhd|exp|bbd|best[ \t]+before|mindestens|netto\w*|net|inhalt|gewicht|hersteller|vertrieb|zusammensetzung|analytische|feuchte\w*|tierart)(?![A-Za-z0-9])/i;

  function declaredLots(text) {
    const codes = new Map();
    const keyFor = code => code.replace(/[ \t]+/g, " ");
    for (const label of text.matchAll(LOT_LABEL)) {
      const code = text.slice(label.index + label[0].length).match(LOT_VALUE)?.[0];
      if (!code || /^\d$/.test(code) || NEIGHBOR_FIELD.test(code)) continue;
      const key = keyFor(code);
      if (!codes.has(key)) codes.set(key, `${label[0].trim()} ${code}`);
    }
    for (const [, marker, code] of text.matchAll(new RegExp(DATED_LOT.source, "g"))) {
      const key = keyFor(code);
      if (!/^\d$/.test(code) && !codes.has(key) && !codes.has(`${marker} ${key}`)) {
        codes.set(key, `${marker} ${code}`);
      }
    }
    return [...codes.values()];
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
    return IMPRINT_REFERENCE.test(text) && !declaredLots(text).length && !possibleLotCode(text);
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
    const lots = lotRule ? declaredLots(text) : [];
    if (lots.length > 1) {
      return { rule, status: "unclear", matchedText: lots.join(" / "),
               matchedLanguage: null, confidence: 0.3,
               note: "Unterschiedliche Partie-/Losnummern im Prüftext. Bitte den Aufdruck am Originaletikett prüfen." };
    }
    const expiryRule = rule.id === "art16_002" || rule.id.startsWith("art17_002_");
    const expiry = expiryRule ? declaredExpiry(text) : null;
    if (expiry?.review) {
      return { rule, status: "unclear", matchedText: expiry.review,
               matchedLanguage: null, confidence: 0.3, note: expiry.note };
    }
    const reference = lotRule || expiryRule ? imprintReference(text, lotRule) : null;
    const operatorRule = rule.id === "art15_002" || rule.id.startsWith("art17_005_");
    const moisture = rule.id === "art15_005" ? declaredMoisture(text) : [];
    const humidityHints = rule.id === "art15_005" ? moistureHints(text) : [];
    if (moistureConflict(moisture, humidityHints)) {
      return { rule, status: "unclear", matchedText: [...moisture, ...humidityHints].join(" / "),
               matchedLanguage: null, confidence: 0.3,
               note: "Widersprüchliche Feuchtewerte erkannt. Bitte am Originalfoto prüfen." };
    }
    if (!moisture.length && humidityHints.length) {
      return { rule, status: "probablyFound", matchedText: humidityHints[0],
               matchedLanguage: null, confidence: 0.7,
               note: "Feuchtewert aus Zusatzlesung. Bitte am Originalfoto bestätigen." };
    }
    const netQuantity = rule.id === "art15_003";
    const netAmounts = netQuantity ? declaredNetAmounts(text) : [];
    if (netAmountConflict(netAmounts)) {
      return { rule, status: "unclear", matchedText: netAmounts.map(amount => amount.evidence).join(" / "),
               matchedLanguage: null, confidence: 0.3,
               note: "Unterschiedliche Nettomengen im Prüftext. Bitte die Packungsangabe am Originaletikett prüfen." };
    }
    const evidence = lotRule ? lots[0]
      : expiry?.evidence ?? moisture[0] ?? (netQuantity ? netAmounts.map(amount => amount.evidence).join(" / ") || null
        : structuredEvidence(rule.id, text));
    const po = lotRule && !evidence ? possibleLotCode(text) : null;
    const hasNumericEvidence = netQuantity || rule.id.startsWith("art17_004_");
    const packageHint = netQuantity && !evidence
      ? text.split("\n").find(line => line.startsWith(OCR_AMOUNT_HINT))
        || text.match(PACK_COUNT)?.[0] || text.match(AMOUNT_LINE)?.[0].trim()
      : null;
    let best = evidence ? { text: evidence, language: "de", weight: 1, languagePriority: 0 } : null;
    const hint = po || packageHint || (!evidence ? reference?.evidence : null);
    if (hint) best = { text: hint, language: "de", weight: 0.7, languagePriority: 0 };
    for (const p of positive) {
      if (rule.id === "art15_001" && p.patternType === "keyword" && normalizeText(p.patternValue) === "milk replacer"
          && !/^[ \t]*(?:(?:calf|lamb|kid)[ \t]+)?milk replacer(?:[ \t]+for[ \t]+[^\n]+)?[ \t]*$/im.test(text)) continue;
      // Allgemeine Zahlenmuster können Futterrationen, einzelne Ziffern oder Fragmente erfassen.
      const barePostalCode = operatorRule && p.patternValue === String.raw`\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+\b`;
      if (p.patternType === "regex" && (hasNumericEvidence || barePostalCode
          || (lotRule && p.confidenceWeight >= 0.85))) continue;
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
      const imprint = reference || ((lotRule || expiryRule) && IMPRINT_REFERENCE.test(text));
      if (imprint && !po) {
        const location = reference?.place ?? "Aufdruck";
        notes.push(`Verweis auf ${location} erkannt. Bitte ${location} separat fotografieren oder den Wert im Prüftext ergänzen.`);
      }
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

  const RENAL_PURPOSE = /\bUnterstützung\s+der\s+Nierenfunktion\s+bei\s+(?:akuter\s+und\s+)?chronischer\s+Niereninsuffizienz\b|\bsupport\s+of\s+renal\s+function\s+in\s+(?:the\s+)?case\s+of\s+(?:acute\s+and\s+)?chronic\s+renal\s+insufficiency\b/i;
  const DIGESTION_PURPOSE = /\bAusgleich\s+unzureichender\s+Verdauung\b|\bcompensation\s+for\s+maldigestion\b/i;
  const STRUVITE_DISSOLUTION = /\bAuflösung\s+von\s+Struvitsteinen\b|\bdissolution\s+of\s+struvite\s+stones\b/i;
  const STRUVITE_RECURRENCE = /\bVerringerung\s+von\s+Struvitsteinrezidiven\b|\breduction\s+of\s+struvite\s+stone\s+recurrence\b/i;
  const INTOLERANCE_PURPOSE = /\b(?:Minderung|Verringerung)\s+von\s+Ausgangs?erzeugnis\s*[-‐‑–]\s+und\s+Nährstoffintoleranz(?:en|erscheinungen)\b|\breduction\s+of\s+ingredient\s+and\s+nutrient\s+intolerances\b/i;
  const DIET_PURPOSES = [
    RENAL_PURPOSE,
    /\bVerringerung\s+(?:der\s+|von\s+)?Oxalsteinbildung\b|\breduction\s+of\s+oxalate\s+stone\s+formation\b/i,
    DIGESTION_PURPOSE,
    INTOLERANCE_PURPOSE,
    /\bLinderung\s+(?:(?:akuter|von)\s+)?Resorptionsstörungen\s+des\s+Darms\b|\breduction\s+of\s+(?:acute\s+)?intestinal\s+absorptive\s+disorders\b/i,
    STRUVITE_DISSOLUTION,
    STRUVITE_RECURRENCE,
  ];
  function dietPurposeMatch(text, pattern) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags + "g"))) {
      const before = text.slice(Math.max(0, match.index - 50), match.index).split(/\n[ \t]*\n/).pop();
      const end = match.index + match[0].length;
      const after = text.slice(end, end + 28).split(/\n[ \t]*\n/, 1)[0];
      if (/\b(?:nicht|not|never)(?:\s+(?:zur|zum|für|for|intended|geeignet|suitable))*\s*$/i.test(before)
          || /^\s*(?:nicht\s+geeignet|ungeeignet|not\s+suitable|not\s+intended)\b/i.test(after)) continue;
      return match;
    }
    return null;
  }

  const DIET_DURATION_AMOUNT = String.raw`(?:\d{1,3}|ein(?:e[rmn]?)?|zwei|drei|vier|fünf|sechs|sieben|acht|zwölf|one|two|three|four|six|twelve)`;
  const DIET_DURATION = new RegExp(String.raw`\b(?:(?:(?:empfohlene\s+)?(?:Fütterungsdauer|Dauer\s+der\s+Fütterung)|recommended\s+(?:length|period)\s+of\s+(?:time|use))[\s:“”"]*(?:zunächst\s+|initially\s+)?(?:bis\s+zu\s+|up\s+to\s+)?|zunächst\s+bis\s+zu\s+|initially\s+up\s+to\s+)(?:${DIET_DURATION_AMOUNT}(?:\s*(?:bis|to|[-–])\s*${DIET_DURATION_AMOUNT})?\s+(?:Tag(?:e[n]?)?|Woche[n]?|Monat(?:e[n]?)?|days?|weeks?|months?)|lebenslang|for\s+life)\b`, "gi");
  const DIET_DURATION_FOLLOWUP = /\b(?:wenn\s+(?:die\s+)?Anzeichen\s+von\s+Intoleranzen\s+verschwinden|if\s+signs\s+of\s+intolerance\s+disappear)\b[^.!?;]{0,125}?\b(?:bis\s+zu\s+(?:einem|1)\s+Jahr|up\s+to\s+(?:one|1)\s+year)\b|\b(?:bei\s+chronischer\s+Insuffizienz\s+der\s+Bauchspeicheldrüse|in\s+case\s+of\s+chronic\s+pancreatic\s+insufficiency)\s*[, ]*\s*(?:lebenslang|for\s+life)\b/gi;
  const DIET_ADVICE = /\bvor\s+(?:der\s+)?(?:Verwendung|Fütterung|Anwendung|Verlängerung)[^.!?;]{0,130}?\b(?:den\s+)?Rat\s+(?:eines|einer)\s+(?:Tierarzt(?:es)?|Tierärztin|Fütterungsexpert(?:en|in)|Fachmanns)\s+einzuholen\b|\b(?:it\s+is\s+recommended\s+(?:that\s+)?(?:a\s+)?(?:veterinarian[’']s|feeding\s+expert[’']s)\s+opinion\s+be\s+sought|consult\s+(?:a|your)\s+(?:veterinarian|feeding\s+expert))\s+before\s+(?:use|feeding|extending)(?:\s+(?:or|and)\s+(?:before\s+)?extending\b)?\b/gi;

  const DIET_SPECIES = /^\s+(?:für\s+(?:(?:ausgewachsene|adulte|erwachsene)\s+)?(?:Hunde|Katzen)|for\s+(?:adult\s+)?(?:dogs|cats)|pour\s+(?:chiens|chats))\b/i;
  const DIET_PURPOSE_ANCHOR = /\b(?:Zur[ \t]+Unterstützung[ \t]+der[ \t]+Nierenfunktion|Zum[ \t]+Ausgleich[ \t]+unzureichender[ \t]+Verdauung|Zur[ \t]+Auflösung[ \t]+von[ \t]+Struvitsteinen|Zur[ \t]+Verringerung[ \t]+von[ \t]+Struvitsteinrezidiven)\b/i;

  function needsDietDeclaration(text) {
    return !text.match(DIET_DECLARATION) && !!dietPurposeMatch(text, DIET_PURPOSE_ANCHOR);
  }

  function dietDeclarationHint(text) {
    for (const match of text.matchAll(DIET_DECLARATION)) {
      const species = text.slice(match.index + match[0].length, match.index + match[0].length + 80).match(DIET_SPECIES);
      if (species) return match[0] + species[0];
    }
    return "";
  }

  function dietPurposeHint(text, primary) {
    return DIET_PURPOSES.filter(pattern => !dietPurposeMatch(primary, pattern))
      .map(pattern => dietPurposeMatch(text, pattern)?.[0].replace(/\s+/g, " "))
      .filter(Boolean).join(" / ");
  }

  const ANALYSIS_HEADING = /\b(?:Analytische (?:Bestandteile|Inhaltsstoffe)|Analytical (?:constituents|components)|Constituants analytiques)\b[ \t:]*/gi;
  const NEXT_LABEL_SECTION = /\n[ \t]*\n|\b(?:Zusatzstoffe|Additives|Additifs|Fütterungsempfehlung|Feeding (?:recommendation|instructions)|Zusammensetzung|Composition|Mindestens haltbar bis|MHD)\b/i;

  const SPLIT_CALCIUM_LINE = /^[^\p{L}\p{N}\n]*um[ \t]+\S+[ \t]+Phosphor[ \t]+\S+/iu;
  const OCR_CALCIUM_HINT = "OCR-Nachprüfung Calcium: ";
  const CALCIUM_LINE_VALUE = new RegExp(String.raw`^(?:[\p{L}\p{P}]{1,4}\s+)?(${DECIMAL})[ \t]*%[ \t]*[,;]?[ \t]*Phosphor[ \t:]+(${DECIMAL})[ \t]*%`, "iu");

  function needsSplitCalcium(text) {
    if (!text.match(DIET_DECLARATION) || !dietPurposeMatch(text, RENAL_PURPOSE)) return false;
    const sections = analyticalSections(text);
    return sections.some(section => /\bCalci-[ \t]*\n/i.test(section)
      && section.split("\n").some(line => SPLIT_CALCIUM_LINE.test(line)))
      && analyticalAmounts(sections, "Calcium|Kalzium").length === 0;
  }

  function matchingSplitCalcium(first, second) {
    const a = first.match(CALCIUM_LINE_VALUE);
    const b = second.match(CALCIUM_LINE_VALUE);
    if (!a || !b || amountNumber(a[1]) !== amountNumber(b[1]) || amountNumber(a[2]) !== amountNumber(b[2])) return "";
    return `${OCR_CALCIUM_HINT}${a[1]} %`;
  }

  function analyticalSections(text) {
    return [...text.matchAll(ANALYSIS_HEADING)].map(match =>
      text.slice(match.index + match[0].length, match.index + match[0].length + 1800).split(NEXT_LABEL_SECTION, 1)[0]);
  }

  function dietField(id, titleDe, legalBasis, evidence, note, status = evidence ? "found" : "unclear") {
    return {
      rule: { id, titleDe, legalBasis, severity: "critical" },
      status,
      matchedText: evidence || null,
      matchedLanguage: null,
      confidence: status === "found" ? 1 : status === "probablyFound" ? 0.7 : 0.3,
      note: status === "found" ? null : note,
    };
  }

  function analyticalAmounts(sections, names) {
    const massUnit = String.raw`(?:%(?![\p{L}\p{N}/])|(?:mg|g)[ \t]*\/[ \t]*kg\b)`;
    const value = String.raw`(${DECIMAL})[ \t]*(${massUnit})`;
    const named = new RegExp(String.raw`\b(?:${names})\b[ \t:;=]*${value}`, "giu");
    const wrapped = new RegExp(String.raw`\b(?:${names})\b[ \t:;=]*\n[ \t]*${value}(?=[ \t]*(?:[,;.\n]|$))`, "giu");
    const preceding = new RegExp(String.raw`(?:^|[,;][ \t]+)\s*(${value}[ \t]+(?:${names})\b)(?![ \t:;=]*\d)`, "gimu");
    const matches = new Map();
    for (const section of sections) {
      const direct = [...section.matchAll(named), ...section.matchAll(wrapped)];
      const values = direct.length ? direct : [...section.matchAll(preceding)].map(match => match.slice(1));
      for (const [evidence, amount, unit] of values) {
        const ambiguousDecimal = /^[1-9]\d*\.\d{3}$/.test(amount);
        const gramsPerKg = ambiguousDecimal ? null : amountNumber(amount) * (unit === "%" ? 10 : /^mg/i.test(unit) ? 0.001 : 1);
        const key = gramsPerKg === null ? evidence : gramsPerKg.toPrecision(12);
        if (!matches.has(key)) matches.set(key, { evidence: evidence.replace(/\s+/g, " "), gramsPerKg });
      }
    }
    return [...matches.values()];
  }

  const ALTERNATE_ANALYSIS_BASIS = /\b(?:Trockenmasse|Trockensubstanz|dry matter)\b|(?:%|\b(?:mg|g)\s*\/\s*kg)\s+(?:TS|TM|DM)\b|\b(?:bezogen auf|normiert auf|bei|based on|at|Basis:)\s*\d+(?:[,.]\d+)?\s*%\s*(?:Feuchte(?:gehalt)?|Feuchtigkeit(?:sgehalt)?|moisture|water content)\b/i;
  const PHOSPHOR_NAMES = "Phosphor|phosphorus|phosphore";
  const CRUDE_PROTEIN_NAMES = "Rohprotein|Rohproteln|crude protein";
  const DIET_MINERALS = [
    ["calcium", "Calcium", "Calcium|Kalzium"],
    ["phosphor", "Phosphor", PHOSPHOR_NAMES],
    ["kalium", "Kalium", "Kalium|potassium"],
    ["natrium", "Natrium", "Natrium|sodium"],
  ];
  const STRUVITE_MINERALS = [
    ...DIET_MINERALS,
    ["magnesium", "Magnesium", "Magnesium|magnésium"],
    ["chlorid", "Chlorid", "Chloride?|chlorures?"],
    ["schwefel", "Schwefel", "Schwefel|sul(?:f|ph)ur|soufre"],
  ];
  const FREE_WATER = /\bWasser\s+zur\s+freien\s+Aufnahme\s+anbieten\b|\b(?:fresh\s+)?water\s+should\s+be\s+available\s+at\s+all\s+times\b/i;
  const formatDietNumber = value => value.toLocaleString("de-DE", { maximumFractionDigits: 3, useGrouping: false });

  function dietAmountsAt12Percent(text, sections, legalBasis, prefix, fields) {
    const ruleSource = `${legalBasis} · VO (EG) Nr. 152/2009, Anhang III`;
    const moistureValues = new Set(sections.flatMap(declaredMoisture).map(moistureValue));
    const [moisture] = moistureValues;
    const ordinaryBasis = !ALTERNATE_ANALYSIS_BASIS.test(text)
      && !moistureConflict(declaredMoisture(text), moistureHints(text));
    return fields.map(([id, title, names]) => {
      const values = analyticalAmounts(sections, names);
      const value = values.length === 1 ? values[0] : null;
      // Feuchte und Gehalt müssen aus demselben beschrifteten Analyseabschnitt stammen.
      const sameSection = sections.some(section =>
        declaredMoisture(section).length === 1 && analyticalAmounts([section], names).length === 1);
      const canConvert = ordinaryBasis && moistureValues.size === 1 && moisture >= 0 && moisture < 100
        && value?.gramsPerKg != null && value.gramsPerKg <= (100 - moisture) * 10 && sameSection;
      const result = canConvert ? formatDietNumber(value.gramsPerKg * 88 / (100 - moisture)) : null;
      return dietField(`art18_${prefix}_12pct_${id}`, `${title} rechnerisch bei 12 % Feuchte`, ruleSource,
        result === null ? null : `${result} g/kg (aus „${value.evidence}“ und ${formatDietNumber(moisture)} % Feuchte)`,
        result === null ? "Feuchte, Gehalt oder Bezugsbasis im selben Analyseabschnitt nicht eindeutig."
          : "Berechnet aus den Etikettangaben. Ausgangswerte und Bezugsbasis am Original prüfen. Die zutreffende Anforderung ist fachlich zu prüfen.",
        result === null ? "unclear" : "probablyFound");
    });
  }

  function dietMineralFields(text, sections, minerals, prefix, legalBasis) {
    const calciumHints = new Map();
    for (const line of text.split("\n")) {
      if (!line.startsWith(OCR_CALCIUM_HINT)) continue;
      const amount = line.slice(OCR_CALCIUM_HINT.length).match(new RegExp(String.raw`^(${DECIMAL})[ \t]*%$`));
      if (amount) calciumHints.set(amountNumber(amount[1]), line);
    }
    return minerals.map(([id, label, names]) => {
      const ruleId = `art18_${prefix}_${id}`;
      const values = analyticalAmounts(sections, names);
      if (id === "calcium" && calciumHints.size) {
        const conflicting = calciumHints.size > 1 || (values.length > 0
          && [...calciumHints.keys()].some(hint => values.some(value => value.gramsPerKg === null || Math.abs(value.gramsPerKg - hint * 10) > 1e-8)));
        if (conflicting || !values.length) {
          const evidence = [...values.map(value => value.evidence), ...calciumHints.values()];
          return dietField(ruleId, label, legalBasis, evidence.join(" / "),
            conflicting ? "Widersprüchliche Zusatzlesungen. Bitte am Originaletikett prüfen."
              : "Zusatzlesung eines getrennt gedruckten Gehalts. Bitte am Originaletikett bestätigen.",
            conflicting ? "unclear" : "probablyFound");
        }
      }
      const ambiguous = values.some(value => value.gramsPerKg === null);
      return dietField(ruleId, label, legalBasis, values.map(value => value.evidence).join(" / "),
        values.length > 1 ? "Widersprüchliche Gehalte im Prüftext. Bitte Originaletikett prüfen."
          : ambiguous ? "Dezimal- oder Tausendertrennzeichen im Prüftext nicht eindeutig."
          : "Kein eindeutig zugeordneter Gehalt unter den analytischen Bestandteilen erkannt.",
        values.length === 1 && !ambiguous ? "found" : "unclear");
    });
  }

  const PROTEIN_SOURCE = String.raw`(?:ausgewählte\s+)?(?:Proteinquellen?|Eiweißquellen?|protein sources?)`;
  const CARBOHYDRATE_SOURCE = String.raw`(?:ausgewählte\s+)?(?:Kohlenhydrat(?:quellen?|auellen?)|carbohydrate sources?)`;
  const DIET_SOURCE_HEADING = new RegExp(String.raw`\b(?:${PROTEIN_SOURCE}|${CARBOHYDRATE_SOURCE})\b[ \t]*[:;]`, "i");

  function dietSourceEvidence(text, label) {
    const heading = new RegExp(String.raw`\b(?:${label})\b[ \t]*(?:[:;][ \t]*\n?|\n)[ \t]*`, "i");
    for (const block of text.split(/\n[ \t]*\n/)) {
      const match = block.match(heading);
      if (!match) continue;
      const start = match.index + match[0].length;
      const body = block.slice(start, start + 300).split(ANALYSIS_HEADING, 1)[0]
        .split(NEXT_LABEL_SECTION, 1)[0].split(DIET_SOURCE_HEADING, 1)[0].trim();
      if (/\p{L}{3}/u.test(body) && !/^(?:keine|nicht|siehe|see|not)\b/i.test(body)) {
        return `${match[0].trim()} ${body}`.replace(/\s+/g, " ");
      }
    }
    return null;
  }

  function renalDietFields(text, legalBasis) {
    const sourceEvidence = dietSourceEvidence(text, PROTEIN_SOURCE);
    const sections = analyticalSections(text);
    return [
      dietField("art18_renal_protein", "Proteinquellen", legalBasis, sourceEvidence,
        "Keine ausdrücklich genannten Proteinquellen im Prüftext erkannt."),
      ...dietMineralFields(text, sections, DIET_MINERALS, "renal", legalBasis),
      ...dietAmountsAt12Percent(text, sections, legalBasis, "renal", [
        ["phosphorus", "Phosphor", PHOSPHOR_NAMES],
        ["protein", "Rohprotein", CRUDE_PROTEIN_NAMES],
      ]),
      dietField("art18_renal_water", "Hinweis zur freien Wasseraufnahme", legalBasis, text.match(FREE_WATER)?.[0],
        "Kein eindeutiger Hinweis zur freien Wasseraufnahme im Prüftext erkannt."),
    ];
  }

  function struviteFields(text, legalBasis, dissolution, recurrence) {
    const sections = analyticalSections(text);
    const urinaryEffect = /\b(?:harnsäuernde\s+Eigenschaften|urine\s+acidifying\s+properties|Eigenschaften\s+zur\s+Bildung\s+eines\s+an\s+Struvit\s+untersättigten\s+Harns|urine\s+undersaturating\s+properties)\b/gi;
    const recurringEffect = /\b(?:harnuntersättigende|metastabilisierende)\s+Eigenschaften\s+(?:in\s+Bezug\s+auf|für)\s+Struvit\b/gi;
    const positiveClaim = pattern => [...text.matchAll(pattern)].find(match =>
      !/\b(?:keine?|ohne|nicht|no|without)\s*$/i.test(text.slice(Math.max(0, match.index - 20), match.index)))?.[0];
    const general = positiveClaim(urinaryEffect);
    const recurrenceEvidence = [positiveClaim(recurringEffect), general].filter(Boolean).join(" / ");
    const effects = [];
    if (dissolution) {
      effects.push(dietField("art18_struvite_dissolution_effect", "Eigenschaften zur Auflösung von Struvitsteinen",
        `${legalBasis}, Eintrag 17`, general, "Kein eindeutiger Hinweis auf harnuntersättigende oder harnsäuernde Eigenschaften erkannt."));
    }
    if (recurrence) {
      effects.push(dietField("art18_struvite_recurrence_effect", "Eigenschaften zur Verringerung von Struvitsteinrezidiven",
        `${legalBasis}, Eintrag 18`, recurrenceEvidence, "Kein eindeutiger Hinweis auf die geforderten Eigenschaften erkannt."));
    }
    const source = `${legalBasis}, ${dissolution && recurrence ? "Einträge 17 und 18" : dissolution ? "Eintrag 17" : "Eintrag 18"}`;
    return [
      ...effects,
      ...dietMineralFields(text, sections, STRUVITE_MINERALS, "struvite", source),
      ...dietAmountsAt12Percent(text, sections, source, "struvite", [
        ["magnesium", "Magnesium", "Magnesium|magnésium"],
      ]),
      dietField("art18_struvite_water", "Hinweis zur freien Wasseraufnahme", source, text.match(FREE_WATER)?.[0],
        "Kein eindeutiger Hinweis zur freien Wasseraufnahme im Prüftext erkannt."),
    ];
  }

  function dietRuleResults(text) {
    const article = "Art. 18 VO (EG) Nr. 767/2009";
    const annex = "Anhang Teil B VO (EU) 2020/354";
    const purposes = new Map();
    for (const pattern of DIET_PURPOSES) {
      const match = dietPurposeMatch(text, pattern);
      if (match) purposes.set(pattern, match[0].replace(/\s+/g, " "));
    }
    const dogOrCat = [...text.matchAll(DIET_DECLARATION)].some(match =>
      DIET_SPECIES.test(text.slice(match.index + match[0].length, match.index + match[0].length + 80)));
    const renal = dogOrCat && purposes.has(RENAL_PURPOSE);
    const digestion = dogOrCat && purposes.has(DIGESTION_PURPOSE);
    const dissolution = dogOrCat && purposes.has(STRUVITE_DISSOLUTION);
    const recurrence = dogOrCat && purposes.has(STRUVITE_RECURRENCE);
    const intolerance = dogOrCat && purposes.has(INTOLERANCE_PURPOSE);
    const extendedAdvice = renal || dissolution || recurrence || intolerance;
    const durations = [...new Set([...text.matchAll(DIET_DURATION), ...text.matchAll(DIET_DURATION_FOLLOWUP)]
      .sort((a, b) => a.index - b.index)
      .map(([wording]) => wording.replace(/\s+/g, " ")))];
    const advice = [...text.matchAll(DIET_ADVICE)].map(([wording]) => wording.replace(/\s+/g, " "));
    const vetAdvice = advice.find(wording => /Tierarzt|Tierärztin|veterinarian/i.test(wording)
      && /Verlängerung|extending/i.test(wording)
      && /\b(?:vor\s+(?:der\s+)?(?:Verwendung|Anwendung|Fütterung)|before\s+(?:use|feeding))\b/i.test(wording));
    const extra = [];
    if (renal) extra.push(...renalDietFields(text, `${annex}, Eintrag 10`));
    if (dissolution || recurrence) extra.push(...struviteFields(text, annex, dissolution, recurrence));
    if (digestion) {
      extra.push(dietField("art18_digestible_diet", "Hinweis auf leichtverdauliche Ernährung", `${annex}, Eintrag 19`,
        text.match(/\bleichtverdauliche\s+Ernährung\b|\bhighly\s+digestible\s+diet\b/i)?.[0],
        "Kein eindeutiger Hinweis auf leichtverdauliche Ernährung im Prüftext erkannt."));
    }
    if (intolerance) {
      const source = `${annex}, Eintrag 13`;
      extra.push(
        dietField("art18_intolerance_protein", "Ausgewählte Proteinquellen", source,
          dietSourceEvidence(text, PROTEIN_SOURCE), "Proteinquellen und gegebenenfalls deren Behandlung bei Zusatz am Etikett prüfen."),
        dietField("art18_intolerance_carbohydrates", "Ausgewählte Kohlenhydratquellen", source,
          dietSourceEvidence(text, CARBOHYDRATE_SOURCE), "Kohlenhydratquellen und gegebenenfalls deren Behandlung bei Zusatz am Etikett prüfen."),
      );
    }
    return [
      dietField("art18_purpose", "Besonderer Ernährungszweck", `${article} Buchst. b · ${annex}`,
        [...purposes.values()].join(" / "), "Kein Ernährungszweck aus der hinterlegten Liste im Prüftext erkannt. Bitte Deklaration am Etikett prüfen."),
      dietField("art18_duration", "Empfohlene Fütterungsdauer", `${article} Buchst. b · ${annex}`,
        durations.join(" / "), durations.length > 1 ? "Mehrere Zeitangaben erkannt. Bedingungen und Zuordnung zum Ernährungszweck prüfen."
          : "Keine zuordenbare Fütterungsdauer im Prüftext erkannt.",
        durations.length > 1 ? "probablyFound" : durations.length === 1 ? "found" : "unclear"),
      dietField("art18_advice", "Hinweis auf fachlichen Rat",
        renal ? `${article} Buchst. c · ${annex}, Eintrag 10` : `${article} Buchst. c`,
        vetAdvice || advice[0], extendedAdvice
          ? "Den Tierarzthinweis für Verwendung und Verlängerung der Fütterungsdauer prüfen."
          : "Kein zuordenbarer Beratungshinweis im Prüftext erkannt.",
        (extendedAdvice ? vetAdvice : advice[0]) ? "found" : "unclear"),
      ...extra,
      dietField("art18_review", "Weitere Angaben zum Ernährungszweck", annex, null,
        "Zweckabhängige Pflichtangaben, Nährstoffvorgaben und die Eignung der Fütterungsdauer am Etikett fachlich prüfen."
          + (renal ? " Bei Nierendiät auch die zutreffende Variante in Eintrag 10, zugesetzte essentielle Fettsäuren und gegebenenfalls Lanthancarbonat prüfen." : "")
          + (dissolution || recurrence ? " Bei Struvitdiät auch den Magnesiumhöchstwert und den Nachweis der angegebenen Harneigenschaften prüfen." : "")
          + (intolerance ? " Bei Futtermittelintoleranzen auch die Kombination der ernährungsphysiologischen Merkmale und bedingte Angaben prüfen." : "")
          + (digestion ? " Beim Ausgleich unzureichender Verdauung auch die leichtverdaulichen Ausgangsquellen und gegebenenfalls deren Behandlung prüfen." : "")),

    ];
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
    const dietary = ocrText.match(DIET_DECLARATION) !== null;
    if (dietary) ruleResults.push(...dietRuleResults(ocrText));
    return { feedType, ruleResults, overallStatus: overallStatus(ruleResults), dietary };
  }

  return {
    openDatabase, loadFeedTypes, loadRules, loadDatabaseInfo,
    searchFeedMaterials, detectFeedType, check, needsPackageAmount, packageAmountHint, declaredNetAmount,
    matchNetHeading: text => text.match(NET_HEADING),
    matchFeedingTableHeading: text => text.match(FEEDING_TABLE_HEADING),
    needsCompositionCrop, compositionCropHint,
    matchMoistureReading: text => text.match(new RegExp(MOISTURE_READING, "iu")),
    needsMoistureCrop: text => declaredMoisture(text).length === 1, moistureCropHint,
    needsDietDeclaration, dietDeclarationHint, dietPurposeHint, needsSplitCalcium, matchingSplitCalcium,
    matchSplitCalciumLine: text => text.match(SPLIT_CALCIUM_LINE),
    matchDietPurposeAnchor: text => dietPurposeMatch(text, DIET_PURPOSE_ANCHOR),
    needsImprintLot, matchingImprintLot, MIN_OCR_LENGTH,
  };
})();

// Für Unit-Tests unter Node (im Browser ohne Wirkung).
if (typeof module !== "undefined" && module.exports) module.exports = Labeling;
