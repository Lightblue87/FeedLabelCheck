/* app.js – UI-Verdrahtung der FeedLabelCheck-Web-App. */
"use strict";

(() => {
  const $ = (sel) => document.querySelector(sel);

  let additives = [];
  let idx = null;
  let feedTypes = [];
  let dbInfo = null;
  let dataState = null;   // { source, lastUpdate, hashes, updateNote }

  // ── Navigation ────────────────────────────────────────────────
  const VIEWS = ["check", "labeling", "materials", "status"];

  function showView(name, { push = true } = {}) {
    if (!VIEWS.includes(name)) name = "check";
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === `view-${name}`));
    document.querySelectorAll("#tabs .tab").forEach(b =>
      b.setAttribute("aria-selected", String(b.dataset.view === name)));
    const view = $(`#view-${name}`);
    $("#view-title").textContent = view.dataset.title;
    $("#view-sub").textContent = view.dataset.sub;
    if (push && location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
    window.scrollTo(0, 0);
  }

  document.querySelectorAll("#tabs .tab").forEach(btn =>
    btn.addEventListener("click", () => showView(btn.dataset.view)));
  window.addEventListener("hashchange", () => showView(location.hash.slice(1), { push: false }));

  // Einzelwert / Mehrere Werte
  function showSub(name) {
    const seg = $("#check-seg");
    seg.dataset.active = name;
    seg.querySelectorAll("button").forEach(b =>
      b.setAttribute("aria-selected", String(b.dataset.sub === name)));
    $("#tab-single").classList.toggle("active", name === "single");
    $("#tab-batch").classList.toggle("active", name === "batch");
  }
  document.querySelectorAll("#check-seg button").forEach(btn =>
    btn.addEventListener("click", () => showSub(btn.dataset.sub)));

  // Tab-Leiste ausblenden, solange die Bildschirmtastatur sichtbar ist:
  // Textfeld fokussiert UND der sichtbare Bereich deutlich kleiner als das
  // Fenster (Tastatur), nicht gezoomt. Rein fokusbasiert bliebe die Leiste
  // auf Android weg, wenn die Tastatur per Zurück-Geste geschlossen wird.
  const vv = window.visualViewport;
  function updateKeyboardState() {
    const typing = document.activeElement?.matches("input:not([type=file]), textarea");
    const shrunk = vv && vv.scale <= 1.01 && vv.height < window.innerHeight * 0.75;
    document.body.classList.toggle("kb", !!(typing && shrunk));
  }
  if (vv) vv.addEventListener("resize", updateKeyboardState);
  document.addEventListener("focusin", updateKeyboardState);
  document.addEventListener("focusout", () => setTimeout(updateKeyboardState, 0));

  showView(location.hash.slice(1), { push: false });

  const escapeHtml = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /** Kurzer Hinweis unten im Bild; "ok"-Meldungen blenden sich aus. */
  let toastTimer = null;
  function toast(text, cls = "info", autoHide = false) {
    const el = $("#loading");
    clearTimeout(toastTimer);
    el.className = "toast " + cls;
    el.textContent = text;
    el.hidden = false;
    if (autoHide) toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
  }

  // ── Initialisierung ───────────────────────────────────────────
  const SQLJS_CONFIG = {
    locateFile: f => `vendor/sql.js/${f}`,
  };
  const TESSERACT_CONFIG = {
    workerPath: "vendor/tesseract/worker.min.js",
    corePath: "vendor/tesseract/core",
    langPath: "vendor/tesseract/lang",
    workerBlobURL: false,
  };

  /** Baut alle Datenstrukturen aus den geladenen Datei-Puffern auf. */
  async function applyBuffers(buffers) {
    const rawAdditives = JSON.parse(new TextDecoder("utf-8").decode(buffers["zusatzstoffe.json"]));
    await Labeling.openDatabase(buffers["labeling.sqlite"], SQLJS_CONFIG);
    additives = LavesEval.loadAdditives(rawAdditives);
    idx = LavesEval.buildIndexes(additives);
    Ocr.setAdditiveCodes(additives.map(a => a.e_number));
    feedTypes = Labeling.loadFeedTypes();
    dbInfo = Labeling.loadDatabaseInfo();
  }

  async function init() {
    const loading = $("#loading");
    try {
      // 1. Sofort mit lokalem Stand starten (IndexedDB, sonst Bundle)
      const local = await DataUpdate.loadLocal();
      dataState = { source: local.source, lastUpdate: local.lastUpdate, hashes: local.hashes, updateNote: null };
      await applyBuffers(local.buffers);

      setupSingle();
      setupBatch();
      setupLabeling();
      setupMaterials();
      renderStatus();
      loading.hidden = true;

      // 2. Im Hintergrund auf neue Daten prüfen
      backgroundUpdate();
    } catch (e) {
      toast("Fehler beim Laden der Daten: " + e.message, "error");
    }
  }

  // Fachdaten: Prüfung beim Start und bei Rückkehr in die App (nach Drosselung). Ein Wechsel erhält die Eingaben.
  const DATA_CHECK_GAP_MS = 30 * 60 * 1000;
  let lastDataCheck = null;
  let dataChecking = false;

  /** Befüllt die datengetriebenen Eingabefelder neu und behält die gewählten Werte, soweit es sie weiter gibt. */
  function keepSelections(fn) {
    const ids = ["#s-category", "#s-species", "#s-age", "#s-unit", "#l-feedtype"];
    const saved = Object.fromEntries(ids.map(id => [id, $(id)?.value]));
    fn();
    const restore = id => {
      const el = $(id);
      if (el && saved[id] != null && [...el.options].some(o => o.value === saved[id])) el.value = saved[id];
    };
    restore("#s-category");
    refreshSpeciesForCategory();
    for (const id of ids.slice(1)) restore(id);
    updateContextSummary();
  }

  async function backgroundUpdate() {
    if (dataChecking) return;
    dataChecking = true;
    lastDataCheck = Date.now();
    try {
      const res = await DataUpdate.checkForUpdates(dataState.hashes);
      dataState.checkedAt = Date.now();
      dataState.published = res.generatedAt || dataState.published || null;
      if (res.updated.length) {
        const fresh = await DataUpdate.loadLocal();
        await applyBuffers(fresh.buffers);
        dataState = {
          ...dataState, source: fresh.source, lastUpdate: fresh.lastUpdate, hashes: fresh.hashes,
          updateNote: `Neuer Stand übernommen (veröffentlicht: ${formatDate(res.generatedAt) || "unbekannt"}). Bereits angezeigte Ergebnisse stammen noch vom vorherigen Stand und sind erneut zu prüfen.`,
        };
        keepSelections(populateSingleInputs);
        toast("Daten aktualisiert. Angezeigte Ergebnisse bitte erneut prüfen.", "ok", true);
      } else {
        dataState.updateNote = "Mit dem veröffentlichten Stand verglichen: keine neueren Inhalte.";
      }
    } catch (e) {
      // Offline oder Manifest nicht erreichbar → der letzte gültige Stand bleibt aktiv.
      dataState.checkedAt = Date.now();
      dataState.updateNote = "Abruf fehlgeschlagen (offline?) – der letzte gültige Stand bleibt aktiv.";
    } finally {
      dataChecking = false;
    }
    renderStatus();
  }

  // Rückkehr in die App: iOS-PWAs starten selten neu, ein Start-Check allein reicht nicht.
  function recheckDataOnReturn() {
    if (document.visibilityState !== "visible" || !dataState) return;
    if (PwaUpdate.dueForCheck(Date.now(), lastDataCheck, DATA_CHECK_GAP_MS)) backgroundUpdate();
  }
  document.addEventListener("visibilitychange", recheckDataOnReturn);
  window.addEventListener("online", recheckDataOnReturn);

  function formatDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleDateString("de-DE", { year: "numeric", month: "2-digit", day: "2-digit" });
  }

  // ── Einzelprüfung ─────────────────────────────────────────────
  function fillSelect(sel, items, selected) {
    sel.innerHTML = items.map(i =>
      `<option${i === selected ? " selected" : ""}>${escapeHtml(i)}</option>`).join("");
  }

  function currentAgeMonths() {
    const v = $("#s-age").value;
    const m = v.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  /** Zeigt die aktuelle Auswahl auch im zugeklappten Prüfkontext. */
  function updateContextSummary() {
    $("#ctx-sum").textContent = ["#s-category", "#s-species", "#s-age"]
      .map(s => $(s).value).filter(Boolean).join(" · ");
  }

  function refreshSpeciesForCategory() {
    const category = $("#s-category").value;
    const set = new Set(["Alle Tierarten"]);
    for (const a of additives) {
      if (category === "Alle Kategorien" || (a.extra.tierart_kategorie || null) === category) {
        for (const s of LavesEval.extractIndividualSpecies(
          a.species, category === "Alle Kategorien" ? null : category)) set.add(s);
      }
    }
    fillSelect($("#s-species"), [...set].sort(new Intl.Collator("de").compare), "Alle Tierarten");
    updateContextSummary();
  }

  /** Befüllt alle datengetriebenen Eingabefelder (auch nach einem Daten-Update). */
  function populateSingleInputs() {
    fillSelect($("#s-category"), ["Alle Kategorien", ...idx.allCategories], "Alle Kategorien");
    refreshSpeciesForCategory();
    fillSelect($("#s-age"), ["Kein Altersfilter", ...idx.ageOptions.map(m => `≤ ${m} Monate`)], "Kein Altersfilter");
    fillSelect($("#s-unit"), LavesEval.unitOptions(idx.allUnits), "mg/kg");
    updateContextSummary();
    // Eigenes Dropdown statt <datalist> – iOS Safari zeigt datalist-
    // Vorschläge nicht an. getOptions liest idx bei jedem Öffnen frisch.
    Autocomplete.attach($("#s-enumber"), () => idx.allENumbers);
    Autocomplete.attach($("#s-substance"), () => idx.allSubstances);

    const sel = $("#l-feedtype");
    sel.innerHTML = `<option value="auto">Automatisch erkennen</option>` +
      feedTypes.filter(f => f.id !== "all" && f.id !== "unknown")
        .map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.nameDe)}</option>`).join("");
  }

  /**
   * Stoff-Feld → Kennnummer-Feld ableiten. Automatisch gesetzte Nummern
   * werden wieder geleert, wenn zum geänderten Stoff keine eindeutige
   * Nummer ableitbar ist – sonst prüft "Alle prüfen" gegen die veraltete
   * Nummer statt gegen den neuen Stoff. Manuell eingegebene oder aus dem
   * Dropdown gewählte Nummern bleiben unangetastet.
   */
  function bindSubstanceDerivation(substanceInput, eNumberInput) {
    substanceInput.addEventListener("change", () => {
      const sub = substanceInput.value.trim();
      const e = sub ? LavesEval.deriveENumberForSubstance(idx, sub, {
        species: $("#s-species").value,
        ageMonths: currentAgeMonths(),
        tierartKategorie: $("#s-category").value,
      }) : null;
      if (e) {
        eNumberInput.value = e;
        eNumberInput.dataset.derived = "1";
      } else if (eNumberInput.dataset.derived) {
        eNumberInput.value = "";
        delete eNumberInput.dataset.derived;
      }
    });
    // Jede Nutzereingabe im Kennnummer-Feld macht den Wert "manuell"
    eNumberInput.addEventListener("input", () => { delete eNumberInput.dataset.derived; });
  }

  const RESULT_GLYPH = { ok: "✓", bad: "✕", warn: "!" };

  function setupSingle() {
    populateSingleInputs();

    $("#s-category").addEventListener("change", refreshSpeciesForCategory);
    $("#s-species").addEventListener("change", updateContextSummary);
    $("#s-age").addEventListener("change", updateContextSummary);

    bindSubstanceDerivation($("#s-substance"), $("#s-enumber"));

    // Form-Submit: "Los"/Enter auf der Tastatur löst die Prüfung aus
    $("#tab-single").addEventListener("submit", (e) => e.preventDefault());

    $("#s-check").addEventListener("click", () => {
      const out = $("#s-result");
      out.hidden = false;
      document.activeElement?.blur?.();
      const res = runCheck({
        eNumber: $("#s-enumber").value.trim(),
        substance: $("#s-substance").value.trim(),
        valueText: $("#s-value").value,
        unit: $("#s-unit").value,
        species: $("#s-species").value,
        ageMonths: currentAgeMonths(),
        category: $("#s-category").value,
      });
      out.className = "result " + res.cls;
      out.innerHTML = `<div class="res-ic" aria-hidden="true">${RESULT_GLYPH[res.cls] || "!"}</div>
        <div class="res-body"><div class="headline">${escapeHtml(res.lines[0])}</div>` +
        res.lines.slice(1).map(l => `<div>${escapeHtml(l)}</div>`).join("") + `</div>`;
      out.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  /** Gemeinsame Prüf-Logik für Einzel- und Batch-Prüfung. */
  function runCheck({ eNumber, substance, valueText, unit, species, ageMonths, category }) {
    if (!eNumber && !substance) {
      return { cls: "warn", lines: ["Bitte Kennnummer oder Stoff eingeben."] };
    }
    const val = parseFloat(String(valueText).replace(",", "."));
    if (Number.isNaN(val)) {
      return { cls: "warn", lines: ["Laborwert muss eine Zahl sein."] };
    }

    const recs = LavesEval.matchAdditiveRecords(idx, eNumber, {
      species, ageMonths, substanceQuery: substance, tierartKategorie: category,
    });

    if (!recs.length) {
      let allRecs;
      if (eNumber) {
        allRecs = additives.filter(a => (a.e_number || "").toUpperCase() === eNumber.toUpperCase());
      } else {
        allRecs = additives.filter(a => substance.toLowerCase() === (a.substance || "").toLowerCase());
      }
      const speciesList = [...new Set(allRecs
        .map(r => r.species)
        .filter(s => s && s !== "Alle Tierarten" && s !== species))].sort();
      return {
        cls: "warn",
        lines: [
          `⚠ Für die Tierart „${species}“ existiert kein Eintrag für ${eNumber || substance}.`,
          `Grenzwerte liegen vor für: ${speciesList.length ? speciesList.join(", ") : "–"}`,
        ],
      };
    }

    if (recs.length > 1) {
      return {
        cls: "warn",
        lines: [
          "Mehrdeutig – bitte genauer eingrenzen.",
          ...recs.map(r => [r.e_number, r.substance].filter(Boolean).join(" ")
            + ` → ${LavesEval.formatRange(r)}`),
        ],
      };
    }

    const { ok, msgs } = LavesEval.evaluateSingleValue(val, recs[0], unit);
    return { cls: ok === true ? "ok" : ok === false ? "bad" : "warn", lines: msgs };
  }

  // ── Batch ─────────────────────────────────────────────────────
  function renumberBatchRows() {
    document.querySelectorAll("#b-rows .b-row").forEach((row, i) => {
      row.querySelector(".b-num").textContent = `Wert ${i + 1}`;
    });
  }

  function addBatchRow({ focus = false } = {}) {
    const row = document.createElement("div");
    row.className = "b-row";
    row.innerHTML = `
      <div class="b-head">
        <span class="b-num"></span>
        <button type="button" class="b-del" aria-label="Zeile entfernen">✕</button>
      </div>
      <div class="b-fields">
        <label class="f">Kennnummer
          <input class="b-enumber" placeholder="z. B. 3b605" enterkeyhint="next">
        </label>
        <label class="f">Stoff
          <input class="b-substance" placeholder="z. B. Zinkoxid" enterkeyhint="next">
        </label>
        <label class="f f-val">Laborergebnis
          <span class="inline">
            <input class="b-value" inputmode="decimal" placeholder="Zahl" enterkeyhint="done">
            <select class="b-unit" aria-label="Einheit">${LavesEval.unitOptions(idx.allUnits)
              .map(u => `<option${u === "mg/kg" ? " selected" : ""}>${escapeHtml(u)}</option>`).join("")}</select>
          </span>
        </label>
      </div>
      <div class="b-result" hidden></div>`;
    row.querySelector(".b-del").addEventListener("click", () => {
      row.remove();
      if (!document.querySelector("#b-rows .b-row")) addBatchRow();
      renumberBatchRows();
      $("#b-summary").hidden = true;
    });
    $("#b-rows").appendChild(row);
    renumberBatchRows();
    Autocomplete.attach(row.querySelector(".b-enumber"), () => idx.allENumbers);
    Autocomplete.attach(row.querySelector(".b-substance"), () => idx.allSubstances);
    // Wie in der Einzelprüfung: gewählter Stoff leitet die Kennnummer ab
    bindSubstanceDerivation(row.querySelector(".b-substance"), row.querySelector(".b-enumber"));
    if (focus) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.querySelector(".b-enumber").focus({ preventScroll: true });
    }
  }

  function setupBatch() {
    addBatchRow();
    addBatchRow();
    $("#b-add").addEventListener("click", () => addBatchRow({ focus: true }));
    $("#b-check").addEventListener("click", () => {
      document.activeElement?.blur?.();
      const species = $("#s-species").value || "Alle Tierarten";
      const ageMonths = currentAgeMonths();
      const category = $("#s-category").value || "Alle Kategorien";
      const counts = { ok: 0, bad: 0, warn: 0 };
      document.querySelectorAll("#b-rows .b-row").forEach(row => {
        const eNumber = row.querySelector(".b-enumber").value.trim();
        const substance = row.querySelector(".b-substance").value.trim();
        const valueText = row.querySelector(".b-value").value;
        const unit = row.querySelector(".b-unit").value;
        const cell = row.querySelector(".b-result");
        row.classList.remove("ok", "bad", "warn");
        if (!eNumber && !substance && !valueText) { cell.hidden = true; return; }
        const res = runCheck({
          eNumber, substance, valueText, unit, species, ageMonths, category,
        });
        counts[res.cls] = (counts[res.cls] || 0) + 1;
        row.classList.add(res.cls);
        const pillText = res.cls === "ok" ? "KONFORM" : res.cls === "bad" ? "NICHT KONFORM" : "PRÜFEN";
        cell.hidden = false;
        cell.innerHTML = `<span class="status-pill ${res.cls}">${pillText}</span>${
          res.lines.map(l => `<div>${escapeHtml(l)}</div>`).join("")}`;
      });
      const total = counts.ok + counts.bad + counts.warn;
      const sum = $("#b-summary");
      sum.hidden = total === 0;
      sum.innerHTML = [
        ["ok", counts.ok, "konform"], ["bad", counts.bad, "nicht konform"], ["warn", counts.warn, "zu prüfen"],
      ].filter(([, n]) => n).map(([c, n, t]) => `<span class="chip ${c}">${n} ${t}</span>`).join("");
    });
  }

  // ── Kennzeichnungs-Check ──────────────────────────────────────
  const STATUS_LABELS = {
    found: "Gefunden", probablyFound: "Wahrscheinlich", missing: "Nicht erkannt",
    unclear: "Unklar", notCheckable: "Nicht prüfbar",
  };
  const OVERALL = {
    keineAuffaelligkeit: { cls: "ok", text: "Keine Auffälligkeit – alle Pflichtangaben gefunden." },
    unklar: { cls: "warn", text: "Unklar – einzelne Angaben bitte manuell prüfen." },
    auffaellig: { cls: "bad", text: "Pflichtangaben im Prüftext nicht erkannt – Etikett prüfen." },
    nichtPruefbar: { cls: "info", text: "Nicht prüfbar – zu wenig Text." },
  };

  const OVERALL_SHORT = {
    keineAuffaelligkeit: { cls: "ok", text: "Unauffällig" },
    unklar: { cls: "warn", text: "Unklar" },
    auffaellig: { cls: "bad", text: "Angaben nicht erkannt" },
    nichtPruefbar: { cls: "info", text: "Nicht prüfbar" },
  };

  function setupLabeling() {
    const sel = $("#l-feedtype");
    const textEl = $("#l-text");
    const DAY_MS = 24 * 60 * 60 * 1000;

    // ── Prüfverlauf (lokal, IndexedDB) ────────────────────────────
    let history = null;
    try {
      if (window.indexedDB) history = LabelHistory.create(LabelHistory.createIdbStore(indexedDB));
    } catch { history = null; }

    let current = null;         // Metadaten des geöffneten Eintrags (oder null)
    let viewEpoch = 0;          // zählt Wechsel des geöffneten Eintrags (Herkunft von OCR-Ergebnissen)
    let navSeq = 0;             // zählt Navigationen (Eintrag öffnen, Neuer Check): eine ältere, noch wartende verfällt
    let currentPhotos = [];     // Fotodatensätze des geöffneten Eintrags
    let photoUrls = [];
    let listUrls = [];
    const CURRENT_KEY = "flc-current-entry";
    const rememberCurrent = (id) => {
      try { id ? localStorage.setItem(CURRENT_KEY, id) : localStorage.removeItem(CURRENT_KEY); } catch { /* ohne Speicher */ }
    };
    const recalledCurrent = () => { try { return localStorage.getItem(CURRENT_KEY); } catch { return null; } };

    // Alle Schreibzugriffe laufen nacheinander (sonst überschreiben sich Text-,
    // Foto- und Ergebnis-Updates desselben Eintrags gegenseitig).
    let queue = Promise.resolve();
    const enqueue = (fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };

    const reportError = (what, e) => toast(`${what}: ${e?.message || e}`, "error", true);

    const retentionText = (e) => {
      if (e.keep) return "dauerhaft behalten";
      const d = LabelHistory.daysLeft(e, Date.now());
      return d <= 0 ? "Löschung heute" : d === 1 ? "Löschung in 1 Tag" : `Löschung in ${d} Tagen`;
    };

    /**
     * Legt beim ersten Inhalt (Text oder Foto) den Eintrag an. Nur innerhalb von enqueue aufrufen.
     * Der Eintrag wird nur dann zum angezeigten (current), wenn die Ansicht seit dem Start unverändert
     * ist; wurde inzwischen ein anderer Eintrag geöffnet oder neu begonnen, bleibt er für sich, und
     * die Ansicht wird nicht angetastet. Aufrufer verwenden deshalb den zurückgegebenen Eintrag.
     */
    async function ensureEntry({ text = textEl.value, feedType = sel.value } = {}) {
      if (!history) return null;
      if (current) return current;
      const epoch = viewEpoch;
      const entry = await history.startEntry({ text, feedType });
      if (epoch !== viewEpoch || current) return entry;
      current = entry;
      rememberCurrent(current.id);
      // Bittet den Browser, den Verlauf nicht bei Speichermangel zu räumen (Fotos!).
      try { navigator.storage?.persist?.(); } catch { /* optional */ }
      renderEntryBar();
      refreshHistoryCount();
      return entry;
    }

    // Nur lokal geänderten Text speichern: Ein unberührter Tab darf beim Ausblenden, Wechseln oder
    // "Neuer Check" nicht seinen (womöglich veralteten) Text über eine Korrektur aus einem anderen
    // Tab schreiben. textVersion zählt lokale Änderungen, savedVersion den zuletzt gesicherten Stand.
    let textVersion = 0;
    let savedVersion = 0;
    const markTextEdited = () => { textVersion++; };          // vor saveText() aufrufen
    const markTextLoaded = () => { savedVersion = textVersion; }; // Text stammt aus dem Speicher

    function saveText() {
      if (!history || textVersion === savedVersion) return;
      return enqueue(async () => {
        const text = textEl.value;
        const version = textVersion;          // beides im selben synchronen Schritt lesen
        if (version === savedVersion) return;
        if (!current && !text.trim()) { savedVersion = version; return; }
        const id = (await ensureEntry({ text })).id;
        const e = await history.update(id, { text });
        if (e && current?.id === id) current = e;
        savedVersion = Math.max(savedVersion, version);
      }).catch(e => reportError("Verlauf konnte nicht gespeichert werden", e));
    }

    /**
     * Sichert alle ungesicherten Änderungen des Editors, bevor die Ansicht gewechselt wird. Ein einzelnes
     * saveText() sichert nur den Stand beim Aufruf; was während des Wartens getippt wird, würde der Wechsel
     * überschreiben und trotzdem als gesichert gelten. Daher wiederholen, bis der Editor sauber ist.
     * @returns {Promise<boolean>} false, wenn inzwischen eine neuere Navigation begonnen wurde oder das
     *   Sichern nicht gelingt – dann darf die Ansicht nicht gewechselt werden (nichts geht verloren).
     */
    async function flushPendingEdits(nav) {
      if (!history) return true;
      for (let i = 0; i < 20; i++) {
        if (nav !== navSeq) return false;
        if (textVersion === savedVersion) return true;
        clearTimeout(textTimer);
        await saveText();
      }
      return nav === navSeq && textVersion === savedVersion;
    }

    let textTimer = null;
    textEl.addEventListener("input", () => {
      markTextEdited();
      clearTimeout(textTimer);
      textTimer = setTimeout(saveText, 400);
    });
    sel.addEventListener("change", () => {
      if (!history) return;
      const idAtEvent = current?.id ?? null;
      const epoch = viewEpoch;
      const feedType = sel.value;
      enqueue(async () => {
        // Wird der Eintrag gerade erst angelegt (current noch leer), gilt der danach vorhandene
        // Eintrag derselben Ansicht; ohne Eintrag greift die Auswahl beim Anlegen (ensureEntry).
        const id = idAtEvent ?? (epoch === viewEpoch ? (current?.id ?? null) : null);
        if (!id) return;
        const e = await history.update(id, { feedType });
        if (e && current?.id === id) current = e;
      }).catch(e => reportError("Verlauf konnte nicht gespeichert werden", e));
    });
    // iOS beendet PWAs ohne Vorwarnung: ausstehende Eingabe beim Ausblenden sofort sichern.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { clearTimeout(textTimer); saveText(); }
      else purge();
    });

    // ── Fotos ─────────────────────────────────────────────────────
    async function makeThumb(file) {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 192 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close?.();
      return new Promise(res => c.toBlob(b => res(b), "image/jpeg", 0.7));
    }

    /** Legt die unveränderten Originale beim Eintrag ab (bevor die OCR startet). */
    function attachPhotos(files) {
      if (!history) return Promise.resolve(null);
      // Zu welchem Eintrag gehört die Aufnahme? Beim Auswählen festhalten, nicht erst beim Ausführen:
      // die Warteschlange kann hängen, während der Nutzer bereits einen anderen Eintrag geöffnet hat.
      const originId = current?.id ?? null;
      const originEpoch = viewEpoch;
      return enqueue(async () => {
        // Noch kein Eintrag: ist die Ansicht inzwischen gewechselt, bekommt die Aufnahme einen eigenen
        // Eintrag, statt in den (neuen, fremden) Eintrag der jetzigen Ansicht zu geraten.
        const id = originId ?? (originEpoch === viewEpoch
          ? (await ensureEntry()).id
          : (await history.startEntry({ text: "", feedType: "auto" })).id);
        const updated = await history.addPhotos(id, files, { makeThumb });
        if (current?.id === id) {            // nur in die Ansicht übernehmen, wenn derselbe Eintrag noch offen ist
          if (updated) current = updated;
          await refreshPhotos();
        }
        refreshHistoryCount();
        return id;
      }).catch(e => {
        reportError("Fotos konnten nicht im Verlauf gespeichert werden", e);
        return originId ?? current?.id ?? null;   // der Eintrag, zu dem die Aufnahme gehört (falls schon angelegt)
      });
    }

    async function refreshPhotos() {
      photoUrls.forEach(u => URL.revokeObjectURL(u));
      photoUrls = [];
      const box = $("#l-photos");
      const id = history && current ? current.id : null;
      const loaded = id ? await history.photos(id) : [];
      if ((current?.id ?? null) !== id) return;     // Ansicht inzwischen gewechselt: das Neuere zeichnet
      currentPhotos = loaded;
      box.hidden = currentPhotos.length === 0;
      box.innerHTML = currentPhotos.length
        ? `<span class="photos-label">Originalfotos (${currentPhotos.length}) – antippen zum Vergleichen</span>`
          + currentPhotos.map((p, i) => {
            const url = URL.createObjectURL(p.thumb || p.blob);
            photoUrls.push(url);
            return `<button type="button" class="photo" data-i="${i}" aria-label="Originalfoto ${i + 1} von ${currentPhotos.length} öffnen"><img src="${url}" alt=""></button>`;
          }).join("")
        : "";
    }
    $("#l-photos").addEventListener("click", (ev) => {
      const btn = ev.target.closest(".photo");
      if (btn) openViewer(Number(btn.dataset.i), btn);
    });

    // ── Foto-Betrachter ───────────────────────────────────────────
    let viewerIndex = 0;
    let viewerUrl = null;
    let viewerOpener = null;
    const viewer = $("#viewer");

    function showViewerPhoto(i) {
      const n = currentPhotos.length;
      viewerIndex = (i + n) % n;
      if (viewerUrl) URL.revokeObjectURL(viewerUrl);
      viewerUrl = URL.createObjectURL(currentPhotos[viewerIndex].blob);
      $("#viewer-img").src = viewerUrl;
      $("#viewer-stage").classList.remove("zoomed");
      $("#viewer-count").textContent = `Foto ${viewerIndex + 1} von ${n}`;
      $("#viewer-prev").disabled = $("#viewer-next").disabled = n < 2;
    }
    function openViewer(i, opener) {
      if (!currentPhotos.length) return;
      viewerOpener = opener || null;
      $("#viewer-text").value = textEl.value;
      viewer.hidden = false;
      document.body.classList.add("noscroll");
      showViewerPhoto(i);
      $("#viewer-close").focus();
    }
    function closeViewer() {
      viewer.hidden = true;
      document.body.classList.remove("noscroll");
      if (viewerUrl) URL.revokeObjectURL(viewerUrl);
      viewerUrl = null;
      $("#viewer-img").removeAttribute("src");
      viewerOpener?.focus?.();
    }
    $("#viewer-close").addEventListener("click", closeViewer);
    $("#viewer-prev").addEventListener("click", () => showViewerPhoto(viewerIndex - 1));
    $("#viewer-next").addEventListener("click", () => showViewerPhoto(viewerIndex + 1));
    $("#viewer-stage").addEventListener("click", () => $("#viewer-stage").classList.toggle("zoomed"));
    $("#viewer-text").addEventListener("input", (ev) => {
      textEl.value = ev.target.value;
      textEl.dispatchEvent(new Event("input"));
    });
    let swipeX = null;
    $("#viewer-stage").addEventListener("touchstart", (ev) => { swipeX = ev.touches.length === 1 ? ev.touches[0].clientX : null; }, { passive: true });
    $("#viewer-stage").addEventListener("touchend", (ev) => {
      if (swipeX === null || $("#viewer-stage").classList.contains("zoomed")) return;
      const dx = ev.changedTouches[0].clientX - swipeX;
      swipeX = null;
      if (Math.abs(dx) > 60 && currentPhotos.length > 1) showViewerPhoto(viewerIndex + (dx < 0 ? 1 : -1));
    });
    document.addEventListener("keydown", (ev) => {
      if (viewer.hidden) return;
      if (ev.key === "Escape") { closeViewer(); return; }
      if (ev.key === "ArrowLeft" && ev.target.id !== "viewer-text") showViewerPhoto(viewerIndex - 1);
      if (ev.key === "ArrowRight" && ev.target.id !== "viewer-text") showViewerPhoto(viewerIndex + 1);
      if (ev.key === "Tab") {   // Fokus bleibt im Dialog
        const f = [...viewer.querySelectorAll("button:not([disabled]), textarea")];
        const first = f[0], last = f[f.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
    });

    // ── Leiste, Liste, Aktionen ───────────────────────────────────
    function renderEntryBar() {
      const bar = $("#l-entry-bar");
      bar.hidden = !current;
      if (!current) return;
      $("#l-entry-info").textContent = `Im Verlauf gespeichert · ${retentionText(current)}`;
      $("#l-keep").setAttribute("aria-pressed", String(!!current.keep));
    }

    async function refreshHistoryCount() {
      if (!history) return;
      const n = (await history.list()).length;
      const badge = $("#l-history-count");
      badge.hidden = n === 0;
      badge.textContent = n;
    }

    function setHistoryOpen(open) {
      $("#l-history").hidden = !open;
      $("#l-flow").hidden = open;
      $("#l-history-toggle").setAttribute("aria-expanded", String(open));
      $("#l-history-label").textContent = open ? "Zurück" : "Verlauf";
      if (open) renderHistory();
      window.scrollTo(0, 0);
    }
    $("#l-history-toggle").addEventListener("click", () =>
      setHistoryOpen($("#l-history").hidden));

    const fmtDate = (t) => new Date(t).toLocaleString("de-DE",
      { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

    async function renderHistory() {
      listUrls.forEach(u => URL.revokeObjectURL(u));
      listUrls = [];
      const list = $("#l-history-list");
      $("#l-history-hint").textContent =
        `Einträge werden ${LabelHistory.RETENTION_DAYS} Tage ab Erfassung aufbewahrt; „Behalten“ schützt einen Eintrag samt Fotos. Alles bleibt auf diesem Gerät.`;
      const items = await history.list();
      if (!items.length) {
        list.innerHTML = `<div class="empty">Noch keine Einträge. Sobald Sie ein Etikett fotografieren oder Text einfügen, wird die Prüfung hier gespeichert.</div>`;
        return;
      }
      list.innerHTML = items.map(e => {
        const thumbUrl = e.thumb ? URL.createObjectURL(e.thumb) : null;
        if (thumbUrl) listUrls.push(thumbUrl);
        const preview = e.text.replace(/\s+/g, " ").trim().slice(0, 110) || "(kein Text)";
        const n = e.photos.length;
        const status = e.lastCheck && OVERALL_SHORT[e.lastCheck.overall];
        return `<article class="hist-item${e.keep ? " kept" : ""}${current?.id === e.id ? " open" : ""}" data-id="${escapeHtml(e.id)}">
          <button type="button" class="hist-open" data-act="open">
            <span class="hist-thumb">${thumbUrl ? `<img src="${thumbUrl}" alt="">` : `<span aria-hidden="true">Aa</span>`}</span>
            <span class="hist-main">
              <span class="hist-title">${escapeHtml(fmtDate(e.createdAt))}${status ? ` <span class="status-pill ${status.cls}">${escapeHtml(status.text)}</span>` : ""}</span>
              <span class="hist-preview">${escapeHtml(preview)}</span>
              <span class="hist-meta">${n === 0 ? "ohne Foto" : n === 1 ? "1 Foto" : `${n} Fotos`} · ${escapeHtml(retentionText(e))}</span>
            </span>
          </button>
          <div class="hist-actions">
            <button type="button" class="keep" data-act="keep" aria-pressed="${!!e.keep}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/></svg>
              <span>Behalten</span>
            </button>
            <button type="button" class="del" data-act="delete">Löschen</button>
          </div>
        </article>`;
      }).join("");
    }

    $("#l-history-list").addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      const id = btn.closest(".hist-item").dataset.id;
      const act = btn.dataset.act;
      try {
        if (act === "open") {
          await openEntry(id);
        } else if (act === "keep") {
          const keep = btn.getAttribute("aria-pressed") !== "true";
          const e = await enqueue(() => history.setKeep(id, keep));
          if (e && current?.id === id) { current = e; renderEntryBar(); }
          await renderHistory();
        } else if (act === "delete") {
          if (!btn.dataset.armed) {           // zweiter Tipp bestätigt
            btn.dataset.armed = "1";
            btn.classList.add("armed");
            btn.textContent = "Wirklich löschen?";
            setTimeout(() => {
              if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = "Löschen"; }
            }, 4000);
            return;
          }
          await enqueue(() => history.remove(id));
          if (current?.id === id) resetCurrent();
          await renderHistory();
          refreshHistoryCount();
        }
      } catch (e) { reportError("Verlauf", e); }
    });

    $("#l-keep").addEventListener("click", async () => {
      if (!current) return;
      const id = current.id;
      const keep = !current.keep;
      try {
        const e = await enqueue(() => history.setKeep(id, keep));
        if (e && current?.id === id) { current = e; renderEntryBar(); }
      } catch (e) { reportError("Verlauf", e); }
    });

    function setFeedType(value) {
      sel.value = [...sel.options].some(o => o.value === value) ? value : "auto";
    }

    async function openEntry(id) {
      const nav = ++navSeq;
      if (!(await flushPendingEdits(nav))) return;   // offene Eingabe des bisherigen Eintrags sichern
      const e = await history.get(id);
      if (nav !== navSeq) return;              // inzwischen wurde etwas anderes angesteuert
      // Während des Ladens getippt: auch das noch beim bisherigen Eintrag sichern, bevor die Ansicht wechselt
      if (!(await flushPendingEdits(nav))) return;
      if (!e) { toast("Eintrag nicht mehr vorhanden.", "warn", true); await renderHistory(); return; }
      viewEpoch++;
      current = e;
      rememberCurrent(id);
      textEl.value = e.text;
      markTextLoaded();
      setFeedType(e.feedType);
      $("#l-result").hidden = true;
      $("#l-ocr-status").className = "ocr-status";
      $("#l-ocr-status").textContent = "Die Texterkennung (OCR, Deutsch) läuft lokal auf dem Gerät.";
      await refreshPhotos();
      if (nav !== navSeq) return;
      renderEntryBar();
      setHistoryOpen(false);
      if (e.lastCheck) runLabelCheck({ scroll: false, save: false });   // aktuelle Regeln, gleicher Text
    }

    function resetCurrent() {
      viewEpoch++;
      current = null;
      rememberCurrent(null);
      textEl.value = "";
      markTextLoaded();
      setFeedType("auto");
      $("#l-result").hidden = true;
      $("#l-ocr-status").className = "ocr-status";
      $("#l-ocr-status").textContent = "Die Texterkennung (OCR, Deutsch) läuft lokal auf dem Gerät.";
      refreshPhotos();
      renderEntryBar();
    }

    $("#l-new").addEventListener("click", async () => {
      const nav = ++navSeq;
      if (!(await flushPendingEdits(nav))) return;   // ein neueres Öffnen hat Vorrang; ungesichert: nicht wechseln
      resetCurrent();
      setHistoryOpen(false);
    });

    /** Abgelaufene Einträge samt Fotos löschen (Start und Wiederöffnen der App). */
    async function purge() {
      if (!history) return;
      try {
        const removed = await enqueue(() => history.purgeExpired());
        if (current && removed.includes(current.id)) {
          resetCurrent();
          toast("Der geöffnete Eintrag war abgelaufen und wurde gelöscht.", "warn", true);
        }
        if (removed.length) {
          refreshHistoryCount();
          if (!$("#l-history").hidden) renderHistory();
        }
      } catch { /* Bereinigung ist best effort */ }
    }

    // ── OCR ───────────────────────────────────────────────────────
    /** @returns {boolean} false, wenn der Text keinem Eintrag zugeordnet werden konnte und verworfen wurde */
    async function appendOcrText(targetId, ocrText, epoch) {
      const join = (old) => (old.trim() ? old + "\n\n" : "") + ocrText;
      const syncViewer = () => { if (!viewer.hidden) $("#viewer-text").value = textEl.value; };
      // Ohne Eintrag (Speichern fehlgeschlagen) gehört der Text nur zur Ansicht, in der er gestartet wurde.
      if (history && !targetId && epoch !== viewEpoch) return false;

      const showsTarget = !history || !targetId || current?.id === targetId;
      if (!history || !targetId || (showsTarget && textVersion !== savedVersion)) {
        // Kein Verlauf, kein Eintrag oder ungesicherte lokale Eingabe: an den sichtbaren Text anhängen
        // und speichern (die lokale Eingabe darf nicht verloren gehen).
        textEl.value = join(textEl.value);
        syncViewer();
        markTextEdited();
        saveText();
        return true;
      }
      // Sonst atomar an den zuletzt GESPEICHERTEN Text anhängen (eine Korrektur aus einem anderen Tab
      // bleibt erhalten, egal ob der Eintrag noch angezeigt wird) und die Anzeige daran angleichen.
      const e = await enqueue(() => history.appendText(targetId, ocrText));
      if (e && current?.id === targetId) {
        current = e;
        if (textVersion === savedVersion) {
          textEl.value = e.text;
          syncViewer();
          markTextLoaded();
        } else {
          // Der Nutzer hat während des Anhängens getippt: Anhang auch dort ergänzen und mitspeichern.
          textEl.value = join(textEl.value);
          syncViewer();
          markTextEdited();
          saveText();
        }
      }
      return true;
    }

    // ── Zusatzläufe der OCR (Packungsmenge, Aufdruck) ─────────────
    async function readImprintLot(worker, file, output) {
      const image = await createImageBitmap(file);
      const crop = document.createElement("canvas");
      try {
        // Die obere Fotozone separat lesen, damit der Fließtext den Aufdruck nicht überlagert.
        crop.width = image.width;
        crop.height = Math.max(1, Math.round(image.height * 0.43));
        crop.getContext("2d").drawImage(image, 0, 0, crop.width, crop.height, 0, 0, crop.width, crop.height);
      } finally {
        image.close();
      }
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
      const first = await worker.recognize(crop, {}, output);
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
      const second = await worker.recognize(crop, {}, output);
      return Labeling.matchingImprintLot(Ocr.textFromResult(first.data), Ocr.textFromResult(second.data));
    }

    async function readRotatedLabel(worker, file, original, output) {
      const image = await createImageBitmap(file);
      try {
        const canvas = document.createElement("canvas");
        const draw = (turn, scale) => {
          const width = Math.max(1, Math.round(image.width * scale));
          const height = Math.max(1, Math.round(image.height * scale));
          const swapsAxes = Math.abs(turn) === 1;
          canvas.width = swapsAxes ? height : width;
          canvas.height = swapsAxes ? width : height;
          const ctx = canvas.getContext("2d");
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate(turn * Math.PI / 2);
          ctx.drawImage(image, -width / 2, -height / 2, width, height);
        };

        // Drehungen verkleinert vergleichen. Nur die beste Drehung in Originalauflösung lesen.
        const scale = Math.min(1, 2100 / Math.max(image.width, image.height));
        let best = original;
        let turn = 0;
        for (const direction of [-1, 1, 2]) {
          draw(direction, scale);
          const { data } = await worker.recognize(canvas, {}, output);
          if (Ocr.orientationScore(data) > Ocr.orientationScore(best)) {
            best = data;
            turn = direction;
          }
        }
        if (!turn || !Ocr.isBetterOrientation(best, original)) return null;
        draw(turn, 1);
        let dataScale = 1;
        if (scale < 1) {
          const { data } = await worker.recognize(canvas, {}, output);
          if (Ocr.orientationScore(data) >= Ocr.orientationScore(best)) best = data;
          else {
            draw(turn, scale);
            dataScale = scale;
          }
        }
        return { input: canvas, data: best, turn, dataScale };
      } finally {
        image.close();
      }
    }

    async function readLabelCrop(worker, input, output, rect, mode, scale = 1, turn = 0) {
      const image = await createImageBitmap(input);
      try {
        const x = Math.max(0, rect.x);
        const y = Math.max(0, rect.y);
        const swapsAxes = Math.abs(turn) === 1;
        const sourceWidth = swapsAxes ? image.height : image.width;
        const sourceHeight = swapsAxes ? image.width : image.height;
        const width = Math.min(sourceWidth, rect.right) - x;
        const height = Math.min(sourceHeight, rect.bottom) - y;
        if (width < 1 || height < 1) return "";
        const crop = document.createElement("canvas");
        crop.width = Math.ceil(width * scale);
        crop.height = Math.ceil(height * scale);
        const ctx = crop.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        if (turn) {
          ctx.scale(crop.width / width, crop.height / height);
          ctx.translate(sourceWidth / 2 - x, sourceHeight / 2 - y);
          ctx.rotate(turn * Math.PI / 2);
          ctx.drawImage(image, -image.width / 2, -image.height / 2);
        } else {
          ctx.drawImage(image, x, y, width, height, 0, 0, crop.width, crop.height);
        }
        await worker.setParameters({ tessedit_pageseg_mode: mode });
        const result = await worker.recognize(crop, {}, output);
        return Ocr.textFromResult(result.data);
      } finally {
        image.close();
      }
    }

    async function readAmountNearHeading(worker, input, data, output, primary) {
      const region = Ocr.findTextRegion(data, Labeling.matchNetHeading);
      if (!region) return "";
      const { first, last } = region;
      const height = Math.max(1, first.y1 - first.y0);
      const rect = {
        x: first.x0 - height * 0.5,
        y: first.y0 - height * 0.5,
        right: last.x1 + height * 6,
        bottom: Math.max(0, first.y0 - height * 0.5) + height * 4,
      };
      const text = await readLabelCrop(worker, input, output, rect, Tesseract.PSM.SINGLE_BLOCK);
      if (Labeling.declaredNetAmount(text)) return text;
      if (!Labeling.matchNetHeading(primary)?.[0].includes("/")) return "";

      // Ein Ausschnitt an ganzen Bildpunkten vermeidet Neuabtastung der schmalen Ziffern.
      const exact = await readLabelCrop(worker, input, output, {
        x: Math.ceil(rect.x), y: Math.floor(rect.y),
        right: Math.ceil(rect.right) - 1, bottom: Math.floor(rect.bottom),
      }, Tesseract.PSM.SINGLE_BLOCK);
      return Labeling.declaredNetAmount(exact) ? exact : "";
    }

    async function readDietAbovePurpose(worker, input, data, output, primary) {
      const region = Ocr.findTextRegion(data, Labeling.matchDietPurposeAnchor);
      if (!region) return "";
      const { first, last } = region;
      const height = Math.max(1, first.y1 - first.y0);
      const top = Math.min(first.y0, last.y0);
      // Die Diätdeklaration steht auf diesen Etiketten unmittelbar über dem Zweck.
      const rect = {
        x: first.x0 - height,
        y: top - height * 2.7,
        right: last.x1 + height * 6.5,
        bottom: top + height * 0.1,
      };
      const heading = await readLabelCrop(worker, input, output, rect, Tesseract.PSM.SINGLE_LINE, 1.6);
      const declaration = Labeling.dietDeclarationHint(heading);
      if (!declaration) return "";

      const body = await readLabelCrop(worker, input, output, {
        ...rect, bottom: top + height * 12,
      }, Tesseract.PSM.SINGLE_BLOCK);
      const purpose = Labeling.dietPurposeHint(body, primary);
      return purpose ? `${declaration}\n${purpose}` : declaration;
    }

    async function readSplitCalcium(worker, input, data, output) {
      const region = Ocr.findTextRegion(data, Labeling.matchSplitCalciumLine);
      if (!region) return "";
      const { first, last } = region;
      const height = Math.max(1, last.y1 - last.y0);
      const top = Math.min(first.y0, last.y0);
      const read = (margin, scale) => readLabelCrop(worker, input, output, {
        x: first.x0 + height * margin,
        y: top - height * 0.35,
        right: last.x1 + height * (2 - margin),
        bottom: Math.max(first.y1, last.y1) + height * 0.35,
      }, Tesseract.PSM.SINGLE_LINE, scale);

      // Nur übernehmen, wenn beide Ausschnitte denselben Gehalt vor Phosphor zeigen.
      const firstRead = await read(0.25, 4);
      if (!firstRead) return "";
      const secondRead = await read(0.6, 3);
      return Labeling.matchingSplitCalcium(firstRead, secondRead);
    }

    async function readMoistureCrop(worker, file, rotated, output, primary) {
      const region = Ocr.findTextRegion(rotated.data, Labeling.matchMoistureReading);
      if (!region) return "";
      const { first, last } = region;
      const height = Math.max(1, first.y1 - first.y0);
      const top = Math.min(first.y0, last.y0);
      const bottom = Math.max(first.y1, last.y1);
      const reduced = rotated.dataScale < 1;
      const read = (x, y, right, lower) => readLabelCrop(worker, reduced ? file : rotated.input, output, {
        x: Math.round(x / rotated.dataScale), y: Math.round(y / rotated.dataScale),
        right: Math.round(right / rotated.dataScale), bottom: Math.round(lower / rotated.dataScale),
      }, Tesseract.PSM.SINGLE_LINE, 1, reduced ? rotated.turn : 0);
      // Boxen der verkleinerten OCR können in die Nachbarzeile ragen.
      const firstRead = reduced
        ? await read(first.x0 - height * 0.14, top - height * 0.01, last.x1 + height * 0.32, bottom - height * 0.08)
        : await read(first.x0 - height * 0.06, top - height * 0.1, last.x1 + height * 0.42, bottom + height * 0.16);
      if (!Labeling.matchMoistureReading(firstRead)) return "";
      const secondRead = await read(first.x0 - height * 0.11, top - height * 0.09,
        last.x1 + height * 0.02, bottom + height * 0.05);
      return Labeling.moistureCropHint(primary, firstRead, secondRead);
    }

    async function readCompositionAboveFeeding(worker, input, data, output) {
      const region = Ocr.findTextRegion(data, Labeling.matchFeedingTableHeading);
      if (!region) return "";
      const { first, last } = region;
      const height = Math.max(1, first.y1 - first.y0);
      if (first.y0 < height * 14) return "";
      const text = await readLabelCrop(worker, input, output, {
        x: Math.round(first.x0 - height * 2.6),
        y: Math.round(first.y0 * 0.18),
        right: Math.round(last.x1 + height * 18),
        bottom: Math.round(first.y0 * 0.67),
      }, Tesseract.PSM.SINGLE_BLOCK);
      return Labeling.compositionCropHint(text);
    }

    /**
     * Liest ein Foto; bei Hinweisen auf Packungsmenge oder Aufdruck folgen Zusatzläufe.
     * step(text) meldet den Fortschritt an die Statuszeile (die Zusatzläufe dauern am Handy spürbar),
     * warnings enthält fehlgeschlagene Zusatzläufe – der bereits gelesene Text bleibt erhalten.
     * @returns {{text: string, warnings: string[]}}
     */
    async function readLabelPhoto(worker, file, step) {
      const output = { text: true, blocks: true };
      let { data } = await worker.recognize(file, {}, output);
      let input = file;
      let rotated = null;
      const warnings = [];
      if (Ocr.needsOrientationCheck(data)) {
        step("Ausrichtung wird geprüft");
        try {
          rotated = await readRotatedLabel(worker, file, data, output);
          if (rotated) ({ input, data } = rotated);
        } catch (e) {
          warnings.push(`Ausrichtungsprüfung fehlgeschlagen (${e?.message || e})`);
        }
      }
      const primary = Ocr.textFromResult(data);
      const checkWeight = Labeling.needsPackageAmount(primary);
      const checkImprint = Labeling.needsImprintLot(primary);
      const checkDiet = Labeling.needsDietDeclaration(primary);
      const checkCalcium = Labeling.needsSplitCalcium(primary);
      const checkMoisture = rotated && Labeling.needsMoistureCrop(primary);
      const checkComposition = Labeling.needsCompositionCrop(primary);
      if (!checkWeight && !checkImprint && !checkDiet && !checkCalcium && !checkMoisture && !checkComposition) {
        return { text: primary, warnings };
      }

      let text = primary;
      try {
        if (checkWeight) {
          step("Zusatzprüfung Packungsmenge");
          const nearby = await readAmountNearHeading(worker, input, data, output, primary);
          if (nearby) {
            text += `\n\n${nearby}`;
          } else {
            await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
            const retry = await worker.recognize(input, {}, output);
            const hint = Labeling.packageAmountHint(primary, Ocr.textFromResult(retry.data));
            if (hint) text += `\n${hint}`;
          }
        }
        if (checkImprint) {
          step("Zusatzprüfung Aufdruck");
          const lot = await readImprintLot(worker, input, output);
          if (lot) text += `\n${lot}`;
        }
        if (checkDiet) {
          step("Zusatzprüfung Diätdeklaration");
          const declaration = await readDietAbovePurpose(worker, input, data, output, primary);
          if (declaration) text += `\n\n${declaration}`;
        }
        if (checkCalcium) {
          step("Zusatzprüfung Calciumgehalt");
          const calcium = await readSplitCalcium(worker, input, data, output);
          if (calcium) text += `\n\n${calcium}`;
        }
        if (checkMoisture) {
          step("Zusatzprüfung Feuchtegehalt");
          const moisture = await readMoistureCrop(worker, file, rotated, output, primary);
          if (moisture) text += `\n\n${moisture}`;
        }
        if (checkComposition) {
          step("Zusatzprüfung Zusammensetzung");
          const ingredients = await readCompositionAboveFeeding(worker, input, data, output);
          if (ingredients) text += `\n\n${ingredients}`;
        }
      } catch (e) {
        warnings.push(`Zusatzprüfung fehlgeschlagen (${e?.message || e})`);
      } finally {
        try { await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK }); } catch { /* Worker beendet */ }
      }
      return { text, warnings };
    }

    async function doOcr(files, targetId, epoch) {
      const status = $("#l-ocr-status");
      status.className = "ocr-status busy";
      let worker = null;
      try {
        status.textContent = "Texterkennung wird gestartet …";
        worker = await Tesseract.createWorker("deu", 1, TESSERACT_CONFIG);
        // Canvas-Eingaben haben keine DPI-Information – fester Wert
        // verhindert, dass Tesseract die Auflösung falsch schätzt.
        await worker.setParameters({ user_defined_dpi: "300" });
        let allText = "";
        const warnings = [];
        for (let i = 0; i < files.length; i++) {
          const label = `Bild ${i + 1}/${files.length}`;
          status.textContent = `OCR läuft … ${label}`;
          const photo = await readLabelPhoto(worker, files[i], (what) => {
            status.textContent = `OCR läuft … ${label} – ${what}`;
          });
          allText += (allText ? "\n\n" : "") + photo.text;
          for (const w of photo.warnings) warnings.push(`${label}: ${w}`);
        }
        const applied = await appendOcrText(targetId, allText, epoch);
        status.className = "ocr-status";
        status.textContent = applied
          ? `OCR abgeschlossen (${files.length} Bild${files.length > 1 ? "er" : ""}) – Text bitte kurz prüfen.`
            + (warnings.length ? ` Hinweis: ${warnings.join("; ")}. Der übrige Text wurde übernommen.` : "")
          : "OCR abgeschlossen, aber der Text wurde verworfen: Die Fotos konnten nicht gespeichert werden und es wurde inzwischen ein anderer Eintrag geöffnet.";
      } catch (e) {
        status.className = "ocr-status error";
        status.textContent = "OCR-Fehler: " + e.message
          + (targetId ? " – die Fotos sind im Verlauf gespeichert, Text kann manuell ergänzt werden." : "");
      } finally {
        try { await worker?.terminate(); } catch { /* bereits beendet */ }
      }
    }

    // Mehrere Auswahlen laufen nacheinander, nie parallel.
    let ocrQueue = Promise.resolve();
    const runOcr = (files, targetId, epoch) => (ocrQueue = ocrQueue.then(() => doOcr(files, targetId, epoch)));

    for (const id of ["#l-files", "#l-camera"]) {
      $(id).addEventListener("change", async (ev) => {
        const files = [...ev.target.files];
        if (!files.length) return;
        const epoch = viewEpoch;                      // Ansicht, zu der diese Aufnahme gehört
        const targetId = await attachPhotos(files);   // Originale zuerst sichern
        await runOcr(files, targetId, epoch);
        ev.target.value = "";   // dasselbe Bild später erneut wählbar
      });
    }

    $("#l-clear").addEventListener("click", () => {
      textEl.value = "";
      $("#l-result").hidden = true;
      markTextEdited();
      saveText();
      textEl.focus();
    });

    // ── Prüfung ───────────────────────────────────────────────────
    /** @returns {object|null} Kurzfassung des Ergebnisses (für den Verlauf) oder null */
    function runLabelCheck({ scroll = true, save = true } = {}) {
      const text = textEl.value.trim();
      const resultBox = $("#l-result");
      const overall = $("#l-overall");
      const rulesBox = $("#l-rules");
      resultBox.hidden = false;

      let feedType = null;
      let confidence = null;
      if (sel.value === "auto") {
        const det = Labeling.detectFeedType(text, feedTypes);
        if (!det) {
          overall.className = "banner warn";
          overall.textContent = "Futtermitteltyp konnte nicht eindeutig erkannt werden – bitte manuell auswählen.";
          rulesBox.innerHTML = "";
          $("#l-counts").innerHTML = "";
          return null;
        }
        feedType = det.feedType;
        confidence = det.confidence;
      } else {
        feedType = feedTypes.find(f => f.id === sel.value);
      }

      const rules = Labeling.loadRules(feedType.id);
      const result = Labeling.check(text, feedType, rules);
      const o = OVERALL[result.overallStatus];
      overall.className = "banner " + o.cls;
      const typeName = result.dietary && ["complete_feed", "complementary_feed"].includes(feedType.id)
        ? `Diät-${feedType.nameDe}` : feedType.nameDe;
      const detectionNote = confidence === null ? "" : ` (automatisch erkannt: ${typeName}, ${Math.round(confidence * 100)} %)`;
      overall.textContent = o.text + detectionNote;

      const tally = {};
      for (const r of result.ruleResults) tally[r.status] = (tally[r.status] || 0) + 1;
      $("#l-counts").innerHTML = Object.keys(STATUS_LABELS).filter(k => tally[k])
        .map(k => `<span class="chip ${k}">${tally[k]} ${STATUS_LABELS[k]}</span>`).join("");

      rulesBox.innerHTML = result.ruleResults.map(r => `
        <div class="rule-card ${r.status}">
          <h4>${escapeHtml(r.rule.titleDe)}
            <span class="status-pill ${r.status}">${STATUS_LABELS[r.status]}</span></h4>
          <div class="meta">${escapeHtml(r.rule.legalBasis)} · ${escapeHtml(r.rule.severity)}</div>
          ${r.matchedText ? `<div class="match">${escapeHtml(r.matchedText)}</div>` : ""}
          ${r.note ? `<div class="meta" style="margin-top:6px">${escapeHtml(r.note)}</div>` : ""}
        </div>`).join("");
      if (scroll) resultBox.scrollIntoView({ block: "start", behavior: "smooth" });

      const summary = { overall: result.overallStatus, counts: tally, feedType: feedType.id, at: Date.now() };
      if (save && history && (current || text)) {
        // Das Ergebnis gehört zu genau diesen Eingaben und diesem Eintrag. Die Schreibwarteschlange
        // kann blockiert sein (z. B. Fotospeicherung): beim Ausführen darf weder ein später
        // getippter Text noch ein inzwischen geöffneter anderer Eintrag betroffen sein.
        const checkedText = textEl.value;
        const checkedType = sel.value;
        const checkedId = current?.id ?? null;
        const checkVersion = textVersion;
        const unsavedAtCheck = textVersion !== savedVersion;
        enqueue(async () => {
          const id = checkedId ?? (await ensureEntry({ text: checkedText, feedType: checkedType })).id;
          // Den geprüften Stand nur als Eingabe speichern, wenn er in diesem Tab ungesichert war und der
          // Editor seither unverändert ist; sonst nie einen neueren Autosave oder eine fremde Korrektur
          // überschreiben. Das Ergebnis wird nur angehängt, wenn die gespeicherten Eingaben dazu passen.
          const writeInputs = unsavedAtCheck && textVersion === checkVersion && sel.value === checkedType;
          const e = await history.applyCheck(id, { text: checkedText, feedType: checkedType, lastCheck: summary, writeInputs });
          if (writeInputs) savedVersion = Math.max(savedVersion, checkVersion);
          if (e && current?.id === id) current = e;
        }).catch(e => reportError("Verlauf konnte nicht gespeichert werden", e));
      }
      return summary;
    }

    $("#l-check").addEventListener("click", () => runLabelCheck());

    // ── Start: abgelaufene Einträge löschen, Entwurf wiederherstellen ──
    if (!history) {
      $("#l-history-toggle").hidden = true;
      $("#l-new").hidden = true;
    } else {
      (async () => {
        await purge();
        refreshHistoryCount();
        const id = recalledCurrent();
        if (id && await history.get(id).catch(() => null)) await openEntry(id).catch(() => {});
      })();
    }
  }

  // ── Futtermittel-Suche ────────────────────────────────────────
  const MATERIALS_HINT = `<div class="empty">Name oder Nummer eingeben – mindestens 2 Zeichen.</div>`;

  function setupMaterials() {
    let timer = null;
    $("#m-results").innerHTML = MATERIALS_HINT;
    $("#m-query").addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const q = $("#m-query").value.trim();
        const box = $("#m-results");
        if (q.length < 2) { box.innerHTML = MATERIALS_HINT; return; }
        const { eu, dlg } = Labeling.searchFeedMaterials(q);
        const cards = [];
        for (const m of eu) {
          cards.push(`<div class="material-card">
            <h4><span class="num">${escapeHtml(m.catalog_number)}</span>${escapeHtml(m.name_de)}</h4>
            <div class="meta">EU-Katalog (VO 68/2013) · ${escapeHtml(m.chapter_name_de)}</div>
            ${m.description_de ? `<p>${escapeHtml(m.description_de)}</p>` : ""}
            ${m.mandatory_declarations_de ? `<p><span class="label">Pflichtangaben:</span> ${escapeHtml(m.mandatory_declarations_de)}</p>` : ""}
            ${m.restrictions_de ? `<p><span class="label">Einschränkungen:</span> ${escapeHtml(m.restrictions_de)}</p>` : ""}
          </div>`);
        }
        for (const m of dlg) {
          cards.push(`<div class="material-card">
            <h4><span class="num">${escapeHtml(m.number)}</span>${escapeHtml(m.name_de)}</h4>
            <div class="meta">DLG-Positivliste · ${escapeHtml(m.group_name_de)}</div>
            ${m.description_de ? `<p>${escapeHtml(m.description_de)}</p>` : ""}
            ${m.labeling_de ? `<p><span class="label">Kennzeichnung:</span> ${escapeHtml(m.labeling_de)}</p>` : ""}
            ${m.requirements_de ? `<p><span class="label">Anforderungen:</span> ${escapeHtml(m.requirements_de)}</p>` : ""}
          </div>`);
        }
        box.innerHTML = cards.length
          ? `<div class="result-count">${cards.length} Treffer</div>` + cards.join("")
          : `<div class="empty">Keine Treffer für „${escapeHtml(q)}“.</div>`;
      }, 250);
    });
  }

  // ── Datenstatus ───────────────────────────────────────────────
  function formatTime(ms) {
    return new Date(ms).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  const APP_UPDATE_TEXT = {
    current: "Die App ist auf dem aktuellen Stand.",
    updating: "Eine neue Version wird geladen. Die App lädt danach neu.",
    available: "Eine neue Version ist veröffentlicht, wurde aber noch nicht übernommen. „App-Dateien neu laden“ aktualisiert sofort.",
    offline: "Prüfung nicht möglich (offline?). Der laufende Stand bleibt aktiv.",
    unknown: "Der veröffentlichte Stand ist nicht ermittelbar (lokale Entwicklung oder noch keine Prüfung).",
  };

  function appUpdateHtml() {
    const info = PwaUpdate.info();
    return `<p>Stand: <code>${escapeHtml(info.running || "unbekannt")}</code></p>
      ${info.remote ? `<p>Veröffentlicht: <code>${escapeHtml(info.remote)}</code></p>` : ""}
      <p>${info.checkedAt ? `Zuletzt geprüft: ${escapeHtml(formatTime(info.checkedAt))}. ` : ""}${escapeHtml(APP_UPDATE_TEXT[info.result] || APP_UPDATE_TEXT.unknown)}</p>`;
  }

  function renderStatus() {
    $("#st-info").innerHTML = `
      <div class="card">
        <h3>Zusatzstoff-Datenbank</h3>
        <div class="tiles">
          <div class="tile"><b>${additives.length}</b><span>Datensätze</span></div>
          <div class="tile"><b>${idx.allENumbers.length}</b><span>Kennnummern</span></div>
          <div class="tile"><b>${idx.allSubstances.length}</b><span>Stoffe</span></div>
        </div>
      </div>
      <div class="card">
        <h3>Kennzeichnungs-Datenbank</h3>
        <div class="tiles">
          <div class="tile"><b>${escapeHtml(dbInfo.version)}</b><span>Version</span></div>
          <div class="tile"><b>${dbInfo.totalRuleCount}</b><span>Regeln</span></div>
        </div>
        <p class="meta">Rechtsgrundlage: ${escapeHtml(dbInfo.regulation)} (Stand ${escapeHtml(dbInfo.versionDate)})</p>
      </div>
      <div class="card">
        <h3>Fachdaten-Updates</h3>
        <p>Datenquelle: ${escapeHtml(dataState.source)}</p>
        ${dataState.published ? `<p>Veröffentlichter Stand: ${escapeHtml(formatDate(dataState.published))}</p>` : ""}
        ${dataState.lastUpdate ? `<p>Zuletzt übernommen: ${escapeHtml(formatDate(dataState.lastUpdate))}</p>` : ""}
        <p>${dataState.checkedAt ? `Zuletzt geprüft: ${escapeHtml(formatTime(dataState.checkedAt))}. ` : ""}${escapeHtml(dataState.updateNote || "Update-Prüfung läuft …")}</p>
        <p class="meta">Das Manifest aus dem FeedLabelCheck-Data-Repo wird beim Start und bei Rückkehr in die App geprüft
          (höchstens alle 30 Minuten). Geänderte Dateien werden per SHA256 verifiziert und lokal (IndexedDB) gespeichert.
          Ohne Internet läuft die App mit dem letzten gültigen Stand weiter.</p>
      </div>
      <div class="card">
        <h3>App-Version</h3>
        ${appUpdateHtml()}
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px">
          <button id="st-check-updates" type="button" class="btn">Jetzt nach Updates suchen</button>
          <button id="st-reset-app" type="button" class="btn">App-Dateien neu laden</button>
        </div>
        <p class="meta">„App-Dateien neu laden“ entfernt nur die zwischengespeicherten App-Dateien und lädt neu.
          Fachdaten, Prüfverlauf und Fotos bleiben erhalten.</p>
      </div>`;
  }

  // Schaltflächen im Tab „Daten“ (Delegation: renderStatus baut den Inhalt neu auf).
  $("#st-info").addEventListener("click", async event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.id === "st-check-updates") {
      button.disabled = true;
      await Promise.all([PwaUpdate.check("manuell", { force: true }), backgroundUpdate()]);
      renderStatus();
    } else if (button.id === "st-reset-app") {
      button.disabled = true;
      PwaUpdate.reset();
    }
  });

  let announcedAppUpdate = false;
  PwaUpdate.onChange(info => {
    if (info.result === "available" && !announcedAppUpdate) {
      announcedAppUpdate = true;
      toast("Neue App-Version verfügbar. Unter „Daten“ mit „App-Dateien neu laden“ aktualisieren.", "info");
    }
    if (additives.length) renderStatus();
  });

  init();
})();
