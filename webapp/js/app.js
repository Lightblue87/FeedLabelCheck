/* app.js – UI-Verdrahtung der FeedLabelCheck-Web-App. */
"use strict";

(() => {
  const $ = (sel) => document.querySelector(sel);

  let additives = [];
  let idx = null;
  let feedTypes = [];
  let dbInfo = null;
  let dataState = null;   // { source, lastUpdate, hashes, updateNote }

  // ── Tabs ──────────────────────────────────────────────────────
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $(`#tab-${btn.dataset.tab}`).classList.add("active");
    });
  });

  const escapeHtml = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
      loading.className = "banner error";
      loading.textContent = "Fehler beim Laden der Daten: " + e.message;
    }
  }

  async function backgroundUpdate() {
    const loading = $("#loading");
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
        loading.hidden = false;
        loading.className = "banner ok";
        loading.textContent = dataState.updateNote;
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
  }

  /** Befüllt alle datengetriebenen Eingabefelder (auch nach einem Daten-Update). */
  function populateSingleInputs() {
    fillSelect($("#s-category"), ["Alle Kategorien", ...idx.allCategories], "Alle Kategorien");
    refreshSpeciesForCategory();
    fillSelect($("#s-age"), ["Kein Altersfilter", ...idx.ageOptions.map(m => `≤ ${m} Monate`)], "Kein Altersfilter");
    fillSelect($("#s-unit"), idx.allUnits.length ? idx.allUnits : ["mg/kg"], "mg/kg");
    $("#dl-enumbers").innerHTML = idx.allENumbers.map(e => `<option value="${escapeHtml(e)}">`).join("");
    $("#dl-substances").innerHTML = idx.allSubstances.map(s => `<option value="${escapeHtml(s)}">`).join("");

    const sel = $("#l-feedtype");
    sel.innerHTML = `<option value="auto">Automatisch erkennen</option>` +
      feedTypes.filter(f => f.id !== "all" && f.id !== "unknown")
        .map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.nameDe)}</option>`).join("");
  }

  function setupSingle() {
    populateSingleInputs();

    $("#s-category").addEventListener("change", refreshSpeciesForCategory);

    // Stoff → E-Nummer ableiten
    $("#s-substance").addEventListener("change", () => {
      const sub = $("#s-substance").value.trim();
      if (!sub) return;
      const e = LavesEval.deriveENumberForSubstance(idx, sub, {
        species: $("#s-species").value,
        ageMonths: currentAgeMonths(),
        tierartKategorie: $("#s-category").value,
      });
      if (e) $("#s-enumber").value = e;
    });

    $("#s-check").addEventListener("click", () => {
      const out = $("#s-result");
      out.hidden = false;
      const res = runCheck({
        eNumber: $("#s-enumber").value.trim(),
        substance: $("#s-substance").value.trim(),
        valueText: $("#s-value").value,
        species: $("#s-species").value,
        ageMonths: currentAgeMonths(),
        category: $("#s-category").value,
      });
      out.className = "result " + res.cls;
      out.innerHTML = `<div class="headline">${escapeHtml(res.lines[0])}</div>` +
        res.lines.slice(1).map(l => `<div>${escapeHtml(l)}</div>`).join("");
    });
  }

  /** Gemeinsame Prüf-Logik für Einzel- und Batch-Prüfung. */
  function runCheck({ eNumber, substance, valueText, species, ageMonths, category }) {
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

    const { ok, msgs } = LavesEval.evaluateSingleValue(val, recs[0]);
    return { cls: ok === true ? "ok" : ok === false ? "bad" : "warn", lines: msgs };
  }

  // ── Batch ─────────────────────────────────────────────────────
  function addBatchRow() {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="b-id" list="dl-enumbers" placeholder="Kennnummer oder Stoff"></td>
      <td><input class="b-value" inputmode="decimal" placeholder="Wert" style="max-width:110px"></td>
      <td><select class="b-unit">${(idx.allUnits.length ? idx.allUnits : ["mg/kg"])
        .map(u => `<option${u === "mg/kg" ? " selected" : ""}>${escapeHtml(u)}</option>`).join("")}</select></td>
      <td class="b-result">–</td>
      <td><button class="b-del" title="Zeile entfernen">✕</button></td>`;
    tr.querySelector(".b-del").addEventListener("click", () => tr.remove());
    $("#b-rows").appendChild(tr);
  }

  function setupBatch() {
    addBatchRow();
    addBatchRow();
    $("#b-add").addEventListener("click", addBatchRow);
    $("#b-check").addEventListener("click", () => {
      const species = $("#s-species").value || "Alle Tierarten";
      const ageMonths = currentAgeMonths();
      const category = $("#s-category").value || "Alle Kategorien";
      document.querySelectorAll("#b-rows tr").forEach(tr => {
        const id = tr.querySelector(".b-id").value.trim();
        const valueText = tr.querySelector(".b-value").value;
        const cell = tr.querySelector(".b-result");
        if (!id && !valueText) { cell.textContent = "–"; return; }
        const isENumber = idx.allENumbers.includes(id.toUpperCase());
        const res = runCheck({
          eNumber: isENumber ? id : "",
          substance: isENumber ? "" : id,
          valueText, species, ageMonths, category,
        });
        const pillClass = res.cls;
        const pillText = res.cls === "ok" ? "KONFORM" : res.cls === "bad" ? "NICHT KONFORM" : "PRÜFEN";
        cell.innerHTML = `<span class="status-pill ${pillClass}">${pillText}</span>
          <div style="font-size:0.8rem;margin-top:4px">${escapeHtml(res.lines[0])}</div>`;
      });
    });
  }

  // ── Kennzeichnungs-Check ──────────────────────────────────────
  const STATUS_LABELS = {
    found: "Gefunden", probablyFound: "Wahrscheinlich", missing: "Fehlt",
    unclear: "Unklar", notCheckable: "Nicht prüfbar",
  };
  const OVERALL = {
    keineAuffaelligkeit: { cls: "ok", text: "Keine Auffälligkeit – alle Pflichtangaben gefunden." },
    unklar: { cls: "warn", text: "Unklar – einzelne Angaben bitte manuell prüfen." },
    auffaellig: { cls: "bad", text: "Auffällig – Pflichtangaben fehlen." },
    nichtPruefbar: { cls: "info", text: "Nicht prüfbar – zu wenig Text." },
  };

  function setupLabeling() {
    const sel = $("#l-feedtype");

    $("#l-files").addEventListener("change", async (ev) => {
      const files = [...ev.target.files];
      if (!files.length) return;
      const status = $("#l-ocr-status");
      try {
        const worker = await Tesseract.createWorker("deu", 1, TESSERACT_CONFIG);
        let allText = "";
        for (let i = 0; i < files.length; i++) {
          status.textContent = `OCR läuft … Bild ${i + 1}/${files.length}`;
          const { data } = await worker.recognize(files[i]);
          allText += (allText ? "\n\n" : "") + data.text;
        }
        await worker.terminate();
        $("#l-text").value = ($("#l-text").value.trim() ? $("#l-text").value + "\n\n" : "") + allText;
        status.textContent = `OCR abgeschlossen (${files.length} Bild${files.length > 1 ? "er" : ""}).`;
      } catch (e) {
        status.textContent = "OCR-Fehler: " + e.message;
      }
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

      rulesBox.innerHTML = result.ruleResults.map(r => `
        <div class="rule-card ${r.status}">
          <h4>${escapeHtml(r.rule.titleDe)}
            <span class="status-pill ${r.status}">${STATUS_LABELS[r.status]}</span></h4>
          <div class="meta">${escapeHtml(r.rule.legalBasis)} · ${escapeHtml(r.rule.severity)}</div>
          ${r.matchedText ? `<div class="match">${escapeHtml(r.matchedText)}</div>` : ""}
          ${r.note ? `<div class="meta" style="margin-top:4px">${escapeHtml(r.note)}</div>` : ""}
        </div>`).join("");
    });
  }

  // ── Futtermittel-Suche ────────────────────────────────────────
  function setupMaterials() {
    let timer = null;
    $("#m-query").addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const q = $("#m-query").value.trim();
        const box = $("#m-results");
        if (q.length < 2) { box.innerHTML = ""; return; }
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
        box.innerHTML = cards.length ? cards.join("")
          : `<p>Keine Treffer für „${escapeHtml(q)}“.</p>`;
      }, 250);
    });
  }

  // ── Datenstatus ───────────────────────────────────────────────
  function renderStatus() {
    $("#st-info").innerHTML = `
      <div class="material-card">
        <h4>Zusatzstoff-Datenbank</h4>
        <p>${additives.length} Datensätze · ${idx.allENumbers.length} Kennnummern · ${idx.allSubstances.length} Stoffe</p>
      </div>
      <div class="material-card">
        <h4>Kennzeichnungs-Datenbank</h4>
        <p>Version ${escapeHtml(dbInfo.version)} · ${dbInfo.totalRuleCount} Regeln</p>
        <p>Rechtsgrundlage: ${escapeHtml(dbInfo.regulation)} (Stand ${escapeHtml(dbInfo.versionDate)})</p>
      </div>
      <div class="material-card">
        <h4>Automatische Updates</h4>
        <p>Datenquelle: ${escapeHtml(dataState.source)}</p>
        ${dataState.lastUpdate ? `<p>Letztes Update: ${escapeHtml(formatDate(dataState.lastUpdate))}</p>` : ""}
        ${dataState.updateNote ? `<p>${escapeHtml(dataState.updateNote)}</p>` : "<p>Update-Prüfung läuft …</p>"}
        <p class="meta" style="color:var(--gray);font-size:0.8rem">Beim Start wird das Manifest aus dem
          FeedLabelCheck-Data-Repo geprüft; geänderte Dateien werden per SHA256 verifiziert und lokal
          (IndexedDB) gespeichert. Ohne Internet läuft die App mit dem letzten Stand weiter.</p>
      </div>`;
  }

  init();
})();
