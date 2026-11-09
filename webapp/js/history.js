/*
 * history.js – lokaler Prüfverlauf für den Kennzeichnungs-Check.
 *
 * Ein Eintrag besteht aus Text, Futtermitteltyp, letztem Prüfergebnis und
 * den unveränderten Originalfotos. Alles bleibt im Browser (IndexedDB,
 * eigene Datenbank – getrennt vom Fachdaten-Speicher in data-update.js).
 *
 * Aufbewahrung: unmarkierte Einträge werden 14 Tage ab Erfassung
 * (createdAt) aufbewahrt und danach samt Fotos gelöscht. "Behalten" schützt
 * den ganzen Eintrag, bis die Markierung entfernt oder der Eintrag
 * manuell gelöscht wird. Nach dem Entfernen der Markierung gilt wieder die
 * Frist ab Erfassung.
 *
 * Die Logik ist von der Speicherung getrennt (createMemoryStore für Tests,
 * createIdbStore im Browser) und hat keine DOM-Abhängigkeiten.
 */
"use strict";

const LabelHistory = (() => {

  const RETENTION_DAYS = 14;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // ── Aufbewahrungsfrist ────────────────────────────────────────
  const expiresAt = (entry) => entry.createdAt + RETENTION_DAYS * DAY_MS;

  /** Abgelaufen, sobald 14 Tage seit der Erfassung vergangen sind (und nicht markiert). */
  const isExpired = (entry, now) => !entry.keep && now >= expiresAt(entry);

  /** Verbleibende ganze oder angebrochene Tage bis zur Löschung (mindestens 0). */
  const daysLeft = (entry, now) => Math.max(0, Math.ceil((expiresAt(entry) - now) / DAY_MS));

  function defaultId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // ── Speicher im Arbeitsspeicher (Tests, Ausweichlösung) ───────
  function createMemoryStore() {
    const entries = new Map();
    const photos = new Map();
    const copyEntry = (e) => ({ ...e, photos: (e.photos || []).map(p => ({ ...p })) });
    return {
      persistent: false,
      async save({ entry, photos: newPhotos = [] }) {
        entries.set(entry.id, copyEntry(entry));
        for (const p of newPhotos) photos.set(p.id, { ...p });
      },
      /** Atomar: frisch lesen, mutate(entry) anwenden, schreiben. null, wenn der Eintrag fehlt. */
      async update(id, mutate, newPhotos = []) {
        const cur = entries.get(id);
        if (!cur) return null;
        const entry = copyEntry(cur);
        mutate(entry);
        entries.set(id, copyEntry(entry));
        for (const p of newPhotos) photos.set(p.id, { ...p });
        return entry;
      },
      /** Löscht Eintrag samt Fotos nur, wenn predicate(frischer Eintrag) wahr ist. */
      async deleteEntryIf(id, predicate) {
        const cur = entries.get(id);
        if (!cur || !predicate(copyEntry(cur))) return false;
        entries.delete(id);
        for (const [pid, p] of photos) if (p.entryId === id) photos.delete(pid);
        return true;
      },
      async getEntry(id) { const e = entries.get(id); return e ? copyEntry(e) : null; },
      async listEntries() { return [...entries.values()].map(copyEntry); },
      async getPhotos(entryId) {
        return [...photos.values()].filter(p => p.entryId === entryId).map(p => ({ ...p }));
      },
      async deleteEntry(id) {
        entries.delete(id);
        for (const [pid, p] of photos) if (p.entryId === id) photos.delete(pid);
      },
      async deleteOrphanPhotos() {
        let n = 0;
        for (const [pid, p] of photos) if (!entries.has(p.entryId)) { photos.delete(pid); n++; }
        return n;
      },
      _countPhotos: () => photos.size,
    };
  }

  // ── Speicher in IndexedDB ─────────────────────────────────────
  function createIdbStore(idb, dbName = "feedlabelcheck-history") {
    let dbPromise = null;
    const open = () => dbPromise ||= new Promise((resolve, reject) => {
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("entries", { keyPath: "id" });
        db.createObjectStore("photos", { keyPath: "id" }).createIndex("entryId", "entryId");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const done = (tx) => new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Transaktion abgebrochen"));
    });
    const request = (req) => new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return {
      persistent: true,
      async save({ entry, photos = [] }) {
        const db = await open();
        const tx = db.transaction(["entries", "photos"], "readwrite");
        const finished = done(tx);
        try {
          tx.objectStore("entries").put(entry);
          for (const p of photos) tx.objectStore("photos").put(p);
        } catch (e) {
          // Eine synchrone Ausnahme (z. B. DataCloneError) bricht die Transaktion nicht ab:
          // ohne abort() bliebe der Eintrag ohne die genannten Fotos stehen.
          try { tx.abort(); } catch { /* bereits beendet */ }
          await finished.catch(() => {});
          throw e;
        }
        await finished;
      },
      /**
       * Atomar in EINER Transaktion: frisch lesen, mutate(entry) anwenden, schreiben.
       * Transaktionen über Tabs/Fenster hinweg werden von IndexedDB serialisiert, so
       * überschreibt ein langsamer Vorgang keine inzwischen anderswo gespeicherten Änderungen.
       */
      async update(id, mutate, photos = []) {
        const db = await open();
        const tx = db.transaction(["entries", "photos"], "readwrite");
        const finished = done(tx);
        let result = null;
        let failure = null;
        const req = tx.objectStore("entries").get(id);
        req.onsuccess = () => {
          const entry = req.result;
          if (!entry) return;                      // gelöscht: keine verwaisten Fotos anlegen
          try {
            mutate(entry);
            tx.objectStore("entries").put(entry);
            for (const p of photos) tx.objectStore("photos").put(p);
            result = entry;
          } catch (e) {
            failure = e;
            try { tx.abort(); } catch { /* bereits beendet */ }
          }
        };
        try { await finished; } catch (e) { throw failure || e; }
        return result;
      },
      /** Löscht Eintrag samt Fotos nur, wenn predicate(frischer Eintrag) wahr ist. */
      async deleteEntryIf(id, predicate) {
        const db = await open();
        const tx = db.transaction(["entries", "photos"], "readwrite");
        const finished = done(tx);
        let deleted = false;
        const req = tx.objectStore("entries").get(id);
        req.onsuccess = () => {
          const entry = req.result;
          if (!entry || !predicate(entry)) return;
          deleted = true;
          tx.objectStore("entries").delete(id);
          const keys = tx.objectStore("photos").index("entryId").getAllKeys(id);
          keys.onsuccess = () => keys.result.forEach(k => tx.objectStore("photos").delete(k));
        };
        await finished;
        return deleted;
      },
      async getEntry(id) {
        const db = await open();
        return (await request(db.transaction("entries").objectStore("entries").get(id))) || null;
      },
      async listEntries() {
        const db = await open();
        return request(db.transaction("entries").objectStore("entries").getAll());
      },
      async getPhotos(entryId) {
        const db = await open();
        return request(db.transaction("photos").objectStore("photos").index("entryId").getAll(entryId));
      },
      async deleteEntry(id) {
        const db = await open();
        const tx = db.transaction(["entries", "photos"], "readwrite");
        tx.objectStore("entries").delete(id);
        const idxReq = tx.objectStore("photos").index("entryId").getAllKeys(id);
        idxReq.onsuccess = () => idxReq.result.forEach(k => tx.objectStore("photos").delete(k));
        await done(tx);
      },
      /**
       * Entfernt Fotos ohne Eintrag. Eintrags-IDs lesen und Verwaiste löschen geschieht in
       * EINER Transaktion über beide Speicher: ein anderer Tab, der gleichzeitig einen Eintrag
       * samt Fotos anlegt, kann so nie zwischen Lesen und Löschen dazwischenkommen.
       */
      async deleteOrphanPhotos() {
        const db = await open();
        const tx = db.transaction(["entries", "photos"], "readwrite");
        const finished = done(tx);
        let count = 0;
        const keysReq = tx.objectStore("entries").getAllKeys();
        keysReq.onsuccess = () => {
          const ids = new Set(keysReq.result);
          // Schlüssel-Cursor über den Index: liefert entryId + Foto-ID, ohne die Blobs zu laden
          const cur = tx.objectStore("photos").index("entryId").openKeyCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            if (!ids.has(c.key)) { tx.objectStore("photos").delete(c.primaryKey); count++; }
            c.continue();
          };
        };
        await finished;
        return count;
      },
    };
  }

  // ── Dienst ────────────────────────────────────────────────────
  /**
   * @param store  createMemoryStore() oder createIdbStore(indexedDB)
   * @param opts   { now: () => ms, newId: () => string }
   */
  function create(store, { now = Date.now, newId = defaultId } = {}) {

    async function startEntry({ text = "", feedType = "auto" } = {}) {
      const t = now();
      const entry = {
        id: newId(), createdAt: t, updatedAt: t,
        text, feedType, keep: false,
        photos: [], thumb: null, lastCheck: null,
      };
      await store.save({ entry });
      return entry;
    }

    /**
     * Ändert Text, Futtermitteltyp oder Prüfergebnis; "Behalten" nur über setKeep.
     * Ein gespeichertes Ergebnis gilt nur für die geprüften Eingaben: ändern sich Text
     * oder Futtermitteltyp, ohne dass ein neues Ergebnis mitgegeben wird, wird es verworfen.
     */
    async function update(id, patch) {
      return store.update(id, (entry) => {
        const inputsChanged = ("text" in patch && patch.text !== entry.text)
          || ("feedType" in patch && patch.feedType !== entry.feedType);
        for (const k of ["text", "feedType", "lastCheck"]) if (k in patch) entry[k] = patch[k];
        if (inputsChanged && !("lastCheck" in patch)) entry.lastCheck = null;
        entry.updatedAt = now();
      });
    }

    async function setKeep(id, keep) {
      return store.update(id, (entry) => {
        entry.keep = !!keep;
        entry.updatedAt = now();
      });
    }

    /**
     * Legt Originalfotos unverändert (als Blob/File) beim Eintrag ab.
     * makeThumb(file) darf eine kleine Vorschau liefern (oder null).
     */
    async function addPhotos(id, files, { makeThumb } = {}) {
      // Langsames (Vorschaubilder) zuerst und ohne Eintrag in der Hand; der Eintrag wird erst
      // im atomaren Schritt frisch gelesen, damit parallele Änderungen (Text, "Behalten",
      // andere Tabs) nicht überschrieben werden.
      const records = [];
      for (const file of files) {
        const thumb = makeThumb ? await makeThumb(file).catch(() => null) : null;
        records.push({
          id: newId(), entryId: id, blob: file, thumb: thumb || null,
          name: file.name || "Foto", type: file.type || "", size: file.size ?? 0, addedAt: now(),
        });
      }
      return store.update(id, (entry) => {
        for (const rec of records) {
          entry.photos.push({ id: rec.id, name: rec.name, type: rec.type, size: rec.size, addedAt: rec.addedAt });
          if (!entry.thumb && rec.thumb) entry.thumb = rec.thumb;
        }
        entry.updatedAt = now();
      }, records);
    }

    const get = (id) => store.getEntry(id);

    async function photos(id) {
      const list = await store.getPhotos(id);
      return list.sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id));
    }

    /** Neueste Erfassung zuerst. */
    async function list() {
      return (await store.listEntries()).sort((a, b) => b.createdAt - a.createdAt);
    }

    const remove = (id) => store.deleteEntry(id);

    /** Löscht abgelaufene unmarkierte Einträge samt Fotos (und verwaiste Fotos). */
    async function purgeExpired() {
      const t = now();
      const removed = [];
      for (const e of await store.listEntries()) {
        // erneut gegen den frischen Stand prüfen: "Behalten" in einem anderen Tab gewinnt
        if (await store.deleteEntryIf(e.id, (fresh) => isExpired(fresh, t))) removed.push(e.id);
      }
      await store.deleteOrphanPhotos();
      return removed;
    }

    return { startEntry, update, setKeep, addPhotos, get, photos, list, remove, purgeExpired };
  }

  return {
    RETENTION_DAYS, DAY_MS, expiresAt, isExpired, daysLeft,
    createMemoryStore, createIdbStore, create,
  };
})();

// Für Unit-Tests unter Node (im Browser ohne Wirkung).
if (typeof module !== "undefined" && module.exports) module.exports = LabelHistory;
