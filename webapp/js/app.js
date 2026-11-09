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

  async function backgroundUpdate() {
    try {
      const res = await DataUpdate.checkForUpdates(dataState.hashes);
      if (res.updated.length) {
        const fresh = await DataUpdate.loadLocal();
        await applyBuffers(fresh.buffers);
        dataState = {
          source: fresh.source, lastUpdate: fresh.lastUpdate, hashes: fresh.hashes,
          updateNote: `Daten aktualisiert (Stand: ${formatDate(res.generatedAt) || "unbekannt"}).`,
        };
        populateSingleInputs();
        toast(dataState.updateNote, "ok", true);
      } else {
        dataState.updateNote = "Daten sind auf dem aktuellen Stand.";
      }
    } catch (e) {
      // Offline oder Manifest nicht erreichbar → lokaler Stand bleibt aktiv.
      dataState.updateNote = "Update-Prüfung nicht möglich (offline?) – lokaler Stand wird verwendet.";
    }
    renderStatus();
  }

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

  function setupLabeling() {
    const sel = $("#l-feedtype");

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

    async function readLabelPhoto(worker, file) {
      const output = { text: true, blocks: true };
      const { data } = await worker.recognize(file, {}, output);
      const primary = Ocr.textFromResult(data);
      const checkWeight = Labeling.needsPackageAmount(primary);
      const checkImprint = Labeling.needsImprintLot(primary);
      if (!checkWeight && !checkImprint) return primary;

      let text = primary;
      try {
        if (checkWeight) {
          await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
          const retry = await worker.recognize(file, {}, output);
          const hint = Labeling.packageAmountHint(primary, Ocr.textFromResult(retry.data));
          if (hint) text += `\n${hint}`;
        }
        if (checkImprint) {
          const lot = await readImprintLot(worker, file, output);
          if (lot) text += `\n${lot}`;
        }
      } catch {
        // Der bereits gelesene Text bleibt bei einem fehlgeschlagenen Zusatzlauf erhalten.
      } finally {
        await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
      }
      return text;
    }

    async function runOcr(files) {
      if (!files.length) return;
      const status = $("#l-ocr-status");
      status.className = "ocr-status busy";
      try {
        status.textContent = "Texterkennung wird gestartet …";
        const worker = await Tesseract.createWorker("deu", 1, TESSERACT_CONFIG);
        // Canvas-Eingaben haben keine DPI-Information – fester Wert
        // verhindert, dass Tesseract die Auflösung falsch schätzt.
        await worker.setParameters({ user_defined_dpi: "300" });
        let allText = "";
        for (let i = 0; i < files.length; i++) {
          status.textContent = `OCR läuft … Bild ${i + 1}/${files.length}`;
          allText += (allText ? "\n\n" : "") + await readLabelPhoto(worker, files[i]);
        }
        await worker.terminate();
        $("#l-text").value = ($("#l-text").value.trim() ? $("#l-text").value + "\n\n" : "") + allText;
        status.className = "ocr-status";
        status.textContent = `OCR abgeschlossen (${files.length} Bild${files.length > 1 ? "er" : ""}) – Text bitte kurz prüfen.`;
      } catch (e) {
        status.className = "ocr-status error";
        status.textContent = "OCR-Fehler: " + e.message;
      }
    }

    for (const id of ["#l-files", "#l-camera"]) {
      $(id).addEventListener("change", async (ev) => {
        const files = [...ev.target.files];
        await runOcr(files);
        ev.target.value = "";   // dasselbe Bild später erneut wählbar
      });
    }

    $("#l-clear").addEventListener("click", () => {
      $("#l-text").value = "";
      $("#l-result").hidden = true;
      $("#l-text").focus();
    });

    $("#l-check").addEventListener("click", () => {
      const text = $("#l-text").value.trim();
      const resultBox = $("#l-result");
      const overall = $("#l-overall");
      const rulesBox = $("#l-rules");
      resultBox.hidden = false;

      let feedType = null;
      let detectionNote = "";
      if (sel.value === "auto") {
        const det = Labeling.detectFeedType(text, feedTypes);
        if (!det) {
          overall.className = "banner warn";
          overall.textContent = "Futtermitteltyp konnte nicht eindeutig erkannt werden – bitte manuell auswählen.";
          rulesBox.innerHTML = "";
          $("#l-counts").innerHTML = "";
          return;
        }
        feedType = det.feedType;
        detectionNote = ` (automatisch erkannt: ${feedType.nameDe}, ${Math.round(det.confidence * 100)} %)`;
      } else {
        feedType = feedTypes.find(f => f.id === sel.value);
      }

      const rules = Labeling.loadRules(feedType.id);
      const result = Labeling.check(text, feedType, rules);
      const o = OVERALL[result.overallStatus];
      overall.className = "banner " + o.cls;
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
      resultBox.scrollIntoView({ block: "start", behavior: "smooth" });
    });
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
        <h3>Automatische Updates</h3>
        <p>Datenquelle: ${escapeHtml(dataState.source)}</p>
        ${dataState.lastUpdate ? `<p>Letztes Update: ${escapeHtml(formatDate(dataState.lastUpdate))}</p>` : ""}
        ${dataState.updateNote ? `<p>${escapeHtml(dataState.updateNote)}</p>` : "<p>Update-Prüfung läuft …</p>"}
        <p class="meta">Beim Start wird das Manifest aus dem FeedLabelCheck-Data-Repo geprüft;
          geänderte Dateien werden per SHA256 verifiziert und lokal (IndexedDB) gespeichert.
          Ohne Internet läuft die App mit dem letzten Stand weiter.</p>
      </div>`;
  }

  init();
})();
