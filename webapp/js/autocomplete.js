/*
 * autocomplete.js – Eigenes Vorschlags-Dropdown für Texteingaben
 * (Kennnummer/Stoffname in Einzel- und Batch-Prüfung).
 *
 * Ersetzt die nativen <datalist>-Vorschläge: iOS Safari (auch als
 * installierte PWA) zeigt datalist-Einträge praktisch nicht an, sodass
 * auf dem iPhone keine Auswahl möglich war. Dieses Dropdown funktioniert
 * in allen Browsern gleich: Liste unter dem Feld, filtert beim Tippen,
 * bedienbar per Tippen/Klick und Pfeiltasten + Enter.
 */
"use strict";

const Autocomplete = (() => {

  const MAX_ITEMS = 40;

  /**
   * Filtert Optionen zu einer Eingabe: Treffer am Wortanfang zuerst,
   * dann Teilstring-Treffer; ohne Eingabe die ersten MAX_ITEMS.
   * (Pur gehalten, damit sie unter Node testbar ist.)
   */
  function filterOptions(options, query, max = MAX_ITEMS) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return options.slice(0, max);
    const starts = [];
    const contains = [];
    for (const option of options) {
      const index = option.toLowerCase().indexOf(q);
      if (index === 0) {
        starts.push(option);
        if (starts.length >= max) break;
      } else if (index > 0 && contains.length < max) {
        contains.push(option);
      }
    }
    return starts.concat(contains).slice(0, max);
  }

  /**
   * Hängt das Dropdown an ein Eingabefeld.
   * getOptions wird bei jedem Öffnen aufgerufen und liefert die aktuelle
   * Optionsliste (bleibt so auch nach Daten-Updates frisch).
   */
  function attach(input, getOptions) {
    if (input.dataset.acAttached) return;
    input.dataset.acAttached = "1";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("spellcheck", "false");

    const wrap = document.createElement("div");
    wrap.className = "ac-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const list = document.createElement("ul");
    list.className = "ac-list";
    list.hidden = true;
    wrap.appendChild(list);

    let items = [];
    let active = -1;

    function close() {
      list.hidden = true;
      list.innerHTML = "";
      items = [];
      active = -1;
    }

    function select(value) {
      input.value = value;
      close();
      // change-Listener (z. B. Live-Prüfung) sollen die Auswahl mitbekommen
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function setActive(index) {
      const lis = list.children;
      if (active >= 0 && lis[active]) lis[active].classList.remove("active");
      active = index;
      if (active >= 0 && lis[active]) {
        lis[active].classList.add("active");
        lis[active].scrollIntoView({ block: "nearest" });
      }
    }

    function open() {
      items = filterOptions(getOptions(), input.value);
      if (!items.length) { close(); return; }
      list.innerHTML = "";
      items.forEach(value => {
        const li = document.createElement("li");
        li.textContent = value;
        li.addEventListener("click", () => select(value));
        list.appendChild(li);
      });
      active = -1;
      list.hidden = false;
      list.scrollTop = 0;
    }

    // pointerdown auf der Liste darf dem Input nicht den Fokus nehmen,
    // sonst schließt blur das Dropdown, bevor der Klick ankommt.
    list.addEventListener("pointerdown", e => e.preventDefault());
    // Fallback für Browser ohne Pointer Events (ältere iOS-Versionen)
    list.addEventListener("mousedown", e => e.preventDefault());

    input.addEventListener("input", open);
    input.addEventListener("focus", open);
    input.addEventListener("blur", () => close());
    input.addEventListener("keydown", e => {
      if (list.hidden) {
        if (e.key === "ArrowDown") { open(); e.preventDefault(); }
        return;
      }
      switch (e.key) {
        case "ArrowDown": setActive(Math.min(active + 1, items.length - 1)); e.preventDefault(); break;
        case "ArrowUp":   setActive(Math.max(active - 1, 0)); e.preventDefault(); break;
        case "Enter":     if (active >= 0) { select(items[active]); e.preventDefault(); } else close(); break;
        case "Escape":    close(); break;
        case "Tab":       close(); break;
      }
    });
  }

  return { attach, filterOptions, MAX_ITEMS };
})();

// Für Unit-Tests unter Node (im Browser ohne Wirkung).
if (typeof module !== "undefined" && module.exports) module.exports = Autocomplete;
