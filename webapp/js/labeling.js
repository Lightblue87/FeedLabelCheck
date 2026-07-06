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
  const DIRECT_LEGAL_TERMS = new Set([
    "einzelfuttermittel", "mischfuttermittel", "alleinfuttermittel",
    "allein-futtermittel", "alleinfutter", "diat alleinfuttermittel",
    "diaet alleinfuttermittel", "erganzungsfuttermittel", "ergaenzungsfuttermittel",
    "erganzungsfutermittel", "ergaenzungsfutermittel", "erganzungsfuttermitel",
    "ergaenzungsfuttermitel", "erganzungsfutter", "mineralfuttermittel",
    "mineral-futtermittel", "milchaustauscher", "milch-austauscher",
  ]);

  function normalizeText(text) {
    return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function containsPhrase(phrase, text) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(phrase)}([^a-z0-9]|$)`, "i");
    return re.test(text);
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
        const matched = ft.keywordsDe.filter(kw => {
          const nk = normalizeText(kw);
          if (!nk) return false;
          if (DIRECT_LEGAL_TERMS.has(nk)) return containsPhrase(nk, normalized);
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
    const normalized = normalizeText(ocrText);
    const candidates = rankedCandidates(normalized, feedTypes);
    const best = candidates[0];
    if (!best) return null;
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
    const idx = normText.indexOf(normalizeText(keyword));
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

  function checkRule(rule, text, normText) {
    const positive = rule.patterns.filter(p => !p.isNegativePattern);
    const negative = rule.patterns.filter(p => p.isNegativePattern);

    if (!positive.length) {
      return { rule, status: "notCheckable", matchedText: null, matchedLanguage: null,
               confidence: 0, note: "Keine Prüfmuster hinterlegt." };
    }

    const hasNegativeMatch = negative.some(p => matchPattern(p, text, normText) !== null);

    let best = null;
    for (const p of positive) {
      const m = matchPattern(p, text, normText);
      if (m !== null) {
        const prio = languagePriority(p.patternLanguage);
        if (!best || prio < best.languagePriority
            || (prio === best.languagePriority && p.confidenceWeight > best.weight)) {
          best = { text: m, language: p.patternLanguage, weight: p.confidenceWeight, languagePriority: prio };
        }
      }
    }

    if (hasNegativeMatch) {
      return { rule, status: "unclear", matchedText: best?.text ?? null,
               matchedLanguage: best?.language ?? null, confidence: 0.3,
               note: "Ausschlussmuster erkannt – manuelle Prüfung empfohlen." };
    }

    if (!best) {
      const note = rule.severity === "critical"
        ? "Pflichtangabe wurde im Text nicht gefunden. Bitte Etikett manuell prüfen."
        : "Angabe wurde im Text nicht gefunden. Bitte Etikett manuell prüfen.";
      return { rule, status: "missing", matchedText: null, matchedLanguage: null,
               confidence: 0, note };
    }

    const status = best.weight >= 0.85 ? "found" : "probablyFound";
    const notes = [];
    if (best.language !== "de") notes.push(`Hinweis wurde in ${languageName(best.language)} gefunden.`);
    if (status === "probablyFound") notes.push("Indirekter Treffer erkannt – Etikett bitte manuell bestätigen.");
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
    searchFeedMaterials, detectFeedType, check, MIN_OCR_LENGTH,
  };
})();
