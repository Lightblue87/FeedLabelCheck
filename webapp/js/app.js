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

    /** Legt beim ersten Inhalt (Text oder Foto) den Eintrag an. Nur innerhalb von enqueue aufrufen. */
    async function ensureEntry() {
      if (!history) return null;
      if (!current) {
        current = await history.startEntry({ text: textEl.value, feedType: sel.value });
        rememberCurrent(current.id);
        // Bittet den Browser, den Verlauf nicht bei Speichermangel zu räumen (Fotos!).
        try { navigator.storage?.persist?.(); } catch { /* optional */ }
        renderEntryBar();
        refreshHistoryCount();
      }
      return current;
    }

    function saveText() {
      if (!history) return;
      return enqueue(async () => {
        const text = textEl.value;
        if (!current && !text.trim()) return;
        await ensureEntry();
        const e = await history.update(current.id, { text });
        if (e) current = e;
      }).catch(e => reportError("Verlauf konnte nicht gespeichert werden", e));
    }

    let textTimer = null;
    textEl.addEventListener("input", () => { clearTimeout(textTimer); textTimer = setTimeout(saveText, 400); });
    sel.addEventListener("change", () => {
      if (!history || !current) return;
      enqueue(async () => {
        const e = await history.update(current.id, { feedType: sel.value });
        if (e) current = e;
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
      return enqueue(async () => {
        await ensureEntry();
        current = await history.addPhotos(current.id, files, { makeThumb });
        await refreshPhotos();
        refreshHistoryCount();
        return current.id;
      }).catch(e => {
        reportError("Fotos konnten nicht im Verlauf gespeichert werden", e);
        return current?.id ?? null;   // der Eintrag, zu dem die Aufnahme gehört (falls schon angelegt)
      });
    }

    async function refreshPhotos() {
      photoUrls.forEach(u => URL.revokeObjectURL(u));
      photoUrls = [];
      const box = $("#l-photos");
      currentPhotos = history && current ? await history.photos(current.id) : [];
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
      try {
        const e = await enqueue(() => history.setKeep(current.id, !current.keep));
        if (e) { current = e; renderEntryBar(); }
      } catch (e) { reportError("Verlauf", e); }
    });

    function setFeedType(value) {
      sel.value = [...sel.options].some(o => o.value === value) ? value : "auto";
    }

    async function openEntry(id) {
      clearTimeout(textTimer);
      await saveText();                        // offene Eingabe des bisherigen Eintrags sichern
      const e = await history.get(id);
      if (!e) { toast("Eintrag nicht mehr vorhanden.", "warn", true); await renderHistory(); return; }
      viewEpoch++;
      current = e;
      rememberCurrent(id);
      textEl.value = e.text;
      setFeedType(e.feedType);
      $("#l-result").hidden = true;
      $("#l-ocr-status").className = "ocr-status";
      $("#l-ocr-status").textContent = "Die Texterkennung (OCR, Deutsch) läuft lokal auf dem Gerät.";
      await refreshPhotos();
      renderEntryBar();
      setHistoryOpen(false);
      if (e.lastCheck) runLabelCheck({ scroll: false, save: false });   // aktuelle Regeln, gleicher Text
    }

    function resetCurrent() {
      viewEpoch++;
      current = null;
      rememberCurrent(null);
      textEl.value = "";
      setFeedType("auto");
      $("#l-result").hidden = true;
      $("#l-ocr-status").className = "ocr-status";
      $("#l-ocr-status").textContent = "Die Texterkennung (OCR, Deutsch) läuft lokal auf dem Gerät.";
      refreshPhotos();
      renderEntryBar();
    }

    $("#l-new").addEventListener("click", async () => {
      clearTimeout(textTimer);
      await saveText();
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
      // Ohne Eintrag (Speichern fehlgeschlagen) gehört der Text nur zur Ansicht, in der er gestartet wurde.
      if (history && !targetId && epoch !== viewEpoch) return false;
      if (!history || !targetId || current?.id === targetId) {
        textEl.value = join(textEl.value);
        if (!viewer.hidden) $("#viewer-text").value = textEl.value;   // Betrachter ist gerade offen
        saveText();
        return true;
      }
      // Der Nutzer hat inzwischen einen anderen Eintrag geöffnet: Text gehört zum alten.
      await enqueue(async () => {
        const e = await history.get(targetId);
        if (e) await history.update(targetId, { text: join(e.text) });
      });
      return true;
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
        for (let i = 0; i < files.length; i++) {
          status.textContent = `OCR läuft … Bild ${i + 1}/${files.length}`;
          const { data } = await worker.recognize(files[i], {}, { text: true, blocks: true });
          allText += (allText ? "\n\n" : "") + Ocr.textFromResult(data);
        }
        const applied = await appendOcrText(targetId, allText, epoch);
        status.className = "ocr-status";
        status.textContent = applied
          ? `OCR abgeschlossen (${files.length} Bild${files.length > 1 ? "er" : ""}) – Text bitte kurz prüfen.`
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
      let detectionNote = "";
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
      if (scroll) resultBox.scrollIntoView({ block: "start", behavior: "smooth" });

      const summary = { overall: result.overallStatus, counts: tally, feedType: feedType.id, at: Date.now() };
      if (save && history && (current || text)) {
        // Das Ergebnis gehört zu genau diesen Eingaben und diesem Eintrag. Die Schreibwarteschlange
        // kann blockiert sein (z. B. Fotospeicherung): beim Ausführen darf weder ein später
        // getippter Text noch ein inzwischen geöffneter anderer Eintrag betroffen sein.
        const checkedText = textEl.value;
        const checkedType = sel.value;
        const checkedId = current?.id ?? null;
        const epoch = viewEpoch;
        enqueue(async () => {
          let id = checkedId;
          if (!id) {
            if (epoch !== viewEpoch) return;       // Ansicht wurde inzwischen gewechselt
            await ensureEntry();
            id = current.id;
          }
          const e = await history.update(id, { text: checkedText, feedType: checkedType, lastCheck: summary });
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
