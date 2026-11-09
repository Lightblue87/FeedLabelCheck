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
      async deleteOrphanPhotos() {
        const db = await open();
        const ids = new Set((await request(db.transaction("entries").objectStore("entries").getAllKeys())));
        const all = await request(db.transaction("photos").objectStore("photos").getAll());
        const orphans = all.filter(p => !ids.has(p.entryId));
        if (!orphans.length) return 0;
        const tx = db.transaction("photos", "readwrite");
        orphans.forEach(p => tx.objectStore("photos").delete(p.id));
        await done(tx);
        return orphans.length;
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

    /** Ändert Text, Futtermitteltyp oder Prüfergebnis; "Behalten" nur über setKeep. */
    async function update(id, patch) {
      const entry = await store.getEntry(id);
      if (!entry) return null;
      for (const k of ["text", "feedType", "lastCheck"]) if (k in patch) entry[k] = patch[k];
      entry.updatedAt = now();
      await store.save({ entry });
      return entry;
    }

    async function setKeep(id, keep) {
      const entry = await store.getEntry(id);
      if (!entry) return null;
      entry.keep = !!keep;
      entry.updatedAt = now();
      await store.save({ entry });
      return entry;
    }

    /**
     * Legt Originalfotos unverändert (als Blob/File) beim Eintrag ab.
     * makeThumb(file) darf eine kleine Vorschau liefern (oder null).
     */
    async function addPhotos(id, files, { makeThumb } = {}) {
      const entry = await store.getEntry(id);
      if (!entry) return null;
      const records = [];
      for (const file of files) {
        const thumb = makeThumb ? await makeThumb(file).catch(() => null) : null;
        const t = now();
        const rec = {
          id: newId(), entryId: id, blob: file, thumb: thumb || null,
          name: file.name || "Foto", type: file.type || "", size: file.size ?? 0, addedAt: t,
        };
        records.push(rec);
        entry.photos.push({ id: rec.id, name: rec.name, type: rec.type, size: rec.size, addedAt: t });
        if (!entry.thumb && thumb) entry.thumb = thumb;
      }
      entry.updatedAt = now();
      await store.save({ entry, photos: records });
      return entry;
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
        if (isExpired(e, t)) { await store.deleteEntry(e.id); removed.push(e.id); }
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
