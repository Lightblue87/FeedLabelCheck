/*
 * Unit-Tests für den lokalen Prüfverlauf (webapp/js/history.js):
 * Originalfotos, Textkorrektur, 14-Tage-Frist, "Behalten", Löschen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LabelHistory = require("../../webapp/js/history.js");

const DAY = LabelHistory.DAY_MS;
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

function setup() {
  const clock = { t: T0 };
  const store = LabelHistory.createMemoryStore();
  let n = 0;
  const history = LabelHistory.create(store, { now: () => clock.t, newId: () => `id${++n}` });
  return { clock, store, history };
}

const photoFile = (name, bytes) => new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
const bytesOf = async (blob) => [...new Uint8Array(await blob.arrayBuffer())];

test("Aufbewahrungsdauer beträgt 14 Tage", () => {
  assert.equal(LabelHistory.RETENTION_DAYS, 14);
});

test("mehrere Originalfotos werden unverändert abgelegt und wieder geöffnet", async () => {
  const { history } = setup();
  const e = await history.startEntry();
  const front = photoFile("vorne.jpg", [1, 2, 3, 4]);
  const back = photoFile("hinten.jpg", [9, 8, 7]);
  await history.addPhotos(e.id, [front]);
  await history.addPhotos(e.id, [back]);

  const entry = await history.get(e.id);
  assert.equal(entry.photos.length, 2);
  const photos = await history.photos(e.id);
  assert.deepEqual(photos.map(p => p.name), ["vorne.jpg", "hinten.jpg"]);
  assert.deepEqual(await bytesOf(photos[0].blob), [1, 2, 3, 4]);
  assert.deepEqual(await bytesOf(photos[1].blob), [9, 8, 7]);
  assert.equal(photos[0].type, "image/jpeg");
  assert.equal(photos[0].size, 4);
});

test("Vorschau des ersten Fotos wird am Eintrag gemerkt", async () => {
  const { history } = setup();
  const e = await history.startEntry();
  const thumbs = [new Blob(["t1"]), new Blob(["t2"])];
  let i = 0;
  await history.addPhotos(e.id, [photoFile("a.jpg", [1]), photoFile("b.jpg", [2])],
    { makeThumb: async () => thumbs[i++] });
  const entry = await history.get(e.id);
  assert.equal(await entry.thumb.text(), "t1");
});

test("Fehler bei der Vorschau verhindern das Speichern des Fotos nicht", async () => {
  const { history } = setup();
  const e = await history.startEntry();
  await history.addPhotos(e.id, [photoFile("a.jpg", [1])], { makeThumb: async () => { throw new Error("x"); } });
  assert.equal((await history.photos(e.id)).length, 1);
});

test("Textkorrektur und Prüfergebnis bleiben erhalten", async () => {
  const { history, clock } = setup();
  const e = await history.startEntry({ text: "Rohtext" });
  clock.t += 1000;
  await history.update(e.id, { text: "Korrigierter Text", feedType: "complementary_feed",
    lastCheck: { overall: "unklar", counts: { found: 3 }, at: clock.t } });
  const entry = await history.get(e.id);
  assert.equal(entry.text, "Korrigierter Text");
  assert.equal(entry.feedType, "complementary_feed");
  assert.equal(entry.lastCheck.overall, "unklar");
  assert.equal(entry.createdAt, T0, "Erfassungszeit bleibt unverändert");
  assert.equal(entry.updatedAt, T0 + 1000);
});

test("update ändert die Markierung nicht", async () => {
  const { history } = setup();
  const e = await history.startEntry();
  await history.update(e.id, { text: "x", keep: true });
  assert.equal((await history.get(e.id)).keep, false);
});

test("unmarkierte Einträge laufen nach 14 Tagen ab, davor nicht", async () => {
  const { history, clock } = setup();
  const e = await history.startEntry({ text: "x" });
  clock.t = T0 + 14 * DAY - 1;
  assert.deepEqual(await history.purgeExpired(), []);
  assert.ok(await history.get(e.id));
  clock.t = T0 + 14 * DAY;
  assert.deepEqual(await history.purgeExpired(), [e.id]);
  assert.equal(await history.get(e.id), null);
});

test("Ablauf wird ab Erfassung gerechnet, nicht ab letzter Änderung", async () => {
  const { history, clock } = setup();
  const e = await history.startEntry();
  clock.t = T0 + 13 * DAY;
  await history.update(e.id, { text: "spät korrigiert" });
  clock.t = T0 + 14 * DAY + 1;
  assert.deepEqual(await history.purgeExpired(), [e.id]);
});

test("beim Ablauf werden die Fotos zusammen mit dem Eintrag gelöscht", async () => {
  const { history, clock, store } = setup();
  const e = await history.startEntry();
  await history.addPhotos(e.id, [photoFile("a.jpg", [1]), photoFile("b.jpg", [2])]);
  assert.equal(store._countPhotos(), 2);
  clock.t = T0 + 15 * DAY;
  await history.purgeExpired();
  assert.equal(store._countPhotos(), 0);
  assert.deepEqual(await history.photos(e.id), []);
});

test("\"Behalten\" schützt Eintrag und Fotos vor der automatischen Löschung", async () => {
  const { history, clock, store } = setup();
  const e = await history.startEntry();
  await history.addPhotos(e.id, [photoFile("a.jpg", [1])]);
  await history.setKeep(e.id, true);
  clock.t = T0 + 400 * DAY;
  assert.deepEqual(await history.purgeExpired(), []);
  assert.ok(await history.get(e.id));
  assert.equal(store._countPhotos(), 1);
});

test("nach Aufheben der Markierung gilt wieder die Frist ab Erfassung", async () => {
  const { history, clock } = setup();
  const keepLong = await history.startEntry();
  await history.setKeep(keepLong.id, true);
  const young = await history.startEntry();
  await history.setKeep(young.id, true);

  clock.t = T0 + 20 * DAY;
  await history.setKeep(keepLong.id, false);          // älter als 14 Tage
  assert.deepEqual(await history.purgeExpired(), [keepLong.id]);

  clock.t = T0 + 5 * DAY;                              // (Uhr zurück: junger Eintrag)
  await history.setKeep(young.id, false);
  assert.deepEqual(await history.purgeExpired(), [], "unter 14 Tage bleibt erhalten");
});

test("manuelles Löschen entfernt Eintrag und Fotos, auch markierte", async () => {
  const { history, store } = setup();
  const e = await history.startEntry();
  await history.addPhotos(e.id, [photoFile("a.jpg", [1]), photoFile("b.jpg", [2])]);
  await history.setKeep(e.id, true);
  const other = await history.startEntry();
  await history.addPhotos(other.id, [photoFile("c.jpg", [3])]);

  await history.remove(e.id);
  assert.equal(await history.get(e.id), null);
  assert.equal(store._countPhotos(), 1, "Fotos anderer Einträge bleiben");
  assert.equal((await history.photos(other.id)).length, 1);
});

test("verwaiste Fotos werden bei der Bereinigung entfernt", async () => {
  const { history, store } = setup();
  await store.save({ entry: { id: "x", createdAt: T0, keep: false, photos: [] },
    photos: [{ id: "p", entryId: "gibt-es-nicht", blob: new Blob(["z"]), addedAt: T0 }] });
  assert.equal(store._countPhotos(), 1);
  await history.purgeExpired();
  assert.equal(store._countPhotos(), 0);
});

test("Liste: neueste Erfassung zuerst", async () => {
  const { history, clock } = setup();
  const a = await history.startEntry();
  clock.t += DAY;
  const b = await history.startEntry();
  clock.t += DAY;
  const c = await history.startEntry();
  assert.deepEqual((await history.list()).map(e => e.id), [c.id, b.id, a.id]);
});

test("Resttage: ab Erfassung, angebrochene Tage zählen voll", () => {
  const entry = { createdAt: T0, keep: false };
  assert.equal(LabelHistory.daysLeft(entry, T0), 14);
  assert.equal(LabelHistory.daysLeft(entry, T0 + 1000), 14);
  assert.equal(LabelHistory.daysLeft(entry, T0 + 13 * DAY + 1), 1);
  assert.equal(LabelHistory.daysLeft(entry, T0 + 14 * DAY), 0);
  assert.equal(LabelHistory.daysLeft(entry, T0 + 30 * DAY), 0);
});

test("Operationen auf unbekannte Einträge geben null zurück", async () => {
  const { history } = setup();
  assert.equal(await history.update("nope", { text: "x" }), null);
  assert.equal(await history.setKeep("nope", true), null);
  assert.equal(await history.addPhotos("nope", []), null);
});
