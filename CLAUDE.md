# FeedLabelCheck

## Auftrag und Arbeitsregeln

FeedLabelCheck unterstützt die Kontrolle von Futtermittel-Zusatzstoffen und Etiketten. Die PWA läuft als statische Website in `webapp/`. Sie prüft Laborwerte gegen hinterlegte Grenzwerte, sucht Angaben in Etikettentext und erschließt zwei Futtermittelkataloge. Die Ergebnisse unterstützen die manuelle Kontrolle. Halte in der Ausgabe erkennbar, welche Daten, Regeln und Annahmen zu einem Ergebnis geführt haben.

- Halte Laborwerte, Etikettentexte und Fotos lokal im Browser. Externe Abrufe dienen der Bereitstellung der App und dem Download von Fachdaten. Änderungen am Datenschutzmodell brauchen eine Produktentscheidung.
- Behandle fehlende oder widersprüchliche Angaben, nicht vergleichbare Einheiten und unvollständigen OCR-Text als eigene Zustände. Eine automatisch erkannte Angabe oder ein Treffer im Prüfmuster belegt für sich allein keine fachliche Konformität.
- Ändere Fachlogik, Datenverträge und Oberfläche in getrennt prüfbaren Schritten. Verwende vorhandene Module und Regressionstests. `laves_eval.py` und die Swift-Dienste sind Vergleichsreferenzen. Bei Abweichungen sind Daten, fachliche Vorgaben und konkrete Fälle maßgeblich.
- Das Design wird überarbeitet. PR #34 ist der laufende Entwurf für Navigation, sichtbaren gemeinsamen Prüfkontext, mobile Bedienung und Fotoaufnahme. Bestehende Tabs, CSS-Klassen und Entwurfsdetails sind Momentaufnahmen. Stimme UI-Änderungen mit diesem Branch ab und halte fachliche Fixes möglichst unabhängig vom Markup. [Designentwurf #34](https://github.com/Lightblue87/FeedLabelCheck/pull/34)
- Erzeuge oder aktualisiere Fachdaten über die Pipeline. Dokumentiere Änderungen an Quellen, Parsern, Schema, Manifest und Rückfallstand gemeinsam. Behandle Datenbank- und OCR-Inhalte als Eingaben und rendere sie sicher.

## Ausgangspunkt der Bestandsaufnahme

Geprüft am 9. November 2026. Basis ist `main` bei `b2039a8` (Merge von #33). GitHub Pages meldet für diesen Stand einen erfolgreichen Deploy. Der Entwurf #34 wurde getrennt anhand von `e60d4da` und seinem Diff betrachtet. Er ändert die Bedienoberfläche, während die zentralen Fachmodule unverändert bleiben. [Quellstand](https://github.com/Lightblue87/FeedLabelCheck/tree/b2039a8bf6c39d9bc7b8ca9e26d179569420534d) · [GitHub-Pages-Deploy](https://github.com/Lightblue87/FeedLabelCheck/actions/runs/28848756023)

## Architektur und vorhandene Funktionen

| Bereich | Einstieg und Verhalten |
| --- | --- |
| Oberfläche und Zustand | [`webapp/index.html`](webapp/index.html), [`style.css`](webapp/style.css), [`app.js`](webapp/js/app.js). Klassische Browser-Skripte ohne Build-Schritt oder Anwendungsserver. `init()` lädt lokale Daten, bindet die Eingaben und startet die Update-Prüfung. Eingaben und Ergebnisse leben überwiegend im DOM und im Arbeitsspeicher. |
| Einzel- und Batchprüfung | [`eval.js`](webapp/js/eval.js) lädt und indiziert `zusatzstoffe.json`, sucht nach Kennnummer oder Stoffname, berücksichtigt Tierart, Kategorie und Altersgrenze und vergleicht bei einem eindeutigen Treffer mit Min/Max. Beide Masken nutzen `runCheck()` aus `app.js`. Batch verwendet den Kontext der Einzelprüfung. [`autocomplete.js`](webapp/js/autocomplete.js) stellt ein eigenes Vorschlagsmenü bereit, weil die native Vorschlagsliste auf iOS im Projekt Probleme machte. |
| Etikett und OCR | Etikettentext lässt sich direkt eingeben oder aus mehreren Fotos mit lokal mitgeliefertem Tesseract (Deutsch) gewinnen. `app.js` hängt die Texte an das editierbare Feld an. [`ocr.js`](webapp/js/ocr.js) filtert Rauschzeilen, verbindet Silbentrennungen und korrigiert typische Lesefehler bei Zusatzstoffcodes. [`labeling.js`](webapp/js/labeling.js) lädt Futtermitteltypen, Regeln und Muster per `sql.js`/WASM. Automatische Typerkennung hat einen manuellen Ausweichpfad. Die Regelprüfung unterscheidet u. a. gefunden, wahrscheinlich, fehlend, unklar und nicht prüfbar. |
| Futtermittelsuche | `Labeling.searchFeedMaterials()` sucht nach Name oder Nummer in `feed_materials` und `dlg_feed_materials` aus `labeling.sqlite`. Die Abfragen liefern je Quelle bis zu 50 Treffer. |
| Datenstatus und Updates | [`data-update.js`](webapp/js/data-update.js) bevorzugt pro Datei IndexedDB und nutzt sonst `webapp/data/`. Im Hintergrund werden `files.json` und `labeling_db` aus `manifest-v2.json` geprüft. Neue Dateien werden nach SHA-256-Abgleich und, soweit angegeben, Größenprüfung gespeichert. Der Datenstatus zeigt Quelle, Regelversion und Update-Ergebnis. [Öffentliches Datenmanifest](https://github.com/Lightblue87/FeedLabelCheck-Data/blob/main/manifest-v2.json) |
| Installation und Offlinebetrieb | [`manifest.webmanifest`](webapp/manifest.webmanifest) definiert Startpfad, Bereich und Icons. [`sw.js`](webapp/sw.js) legt App-Dateien, Fallback-Daten, WASM und OCR-Sprachdaten beim Installieren in den Cache. Nach erfolgreichem Vorabladen funktionieren die Kernabläufe offline. Der Service Worker und der Fachdaten-Updater haben getrennte Lebenszyklen. |
| Datenpipeline und Auslieferung | [`build-data.yml`](.github/workflows/build-data.yml) lädt BVL-PDFs über `Data/bvl_update_pipeline.py`, baut JSON, SQLite und Manifest und veröffentlicht mit `FEEDLABELCHECK_DATA_REPO_TOKEN` in `Lightblue87/FeedLabelCheck-Data`. [`deploy-pages.yml`](.github/workflows/deploy-pages.yml) veröffentlicht `webapp/` bei Änderungen daran auf `main` oder nach manuellem Start. Der Pages-Workflow führt keine Tests aus. [Live-PWA](https://lightblue87.github.io/FeedLabelCheck/) |
| Weitere Plattformen | `FeedLabelCheck/FeedLabelCheck/` enthält die native Swift-App. `main.py`, `laves_eval.py` und `zusatzstoff_pruefung_widget.py` gehören zur Python-Desktop-App. Änderungen am gemeinsamen Datenformat können alle Plattformen betreffen. |

## Priorisierte Befunde

### P1 – Grenzwertprüfung kann ein falsches Konformitätsergebnis anzeigen

- `app.js` übergibt `#s-unit` und `.b-unit` weder an `runCheck()` noch an `LavesEval.evaluateSingleValue()`. Die Bewertung vergleicht den nackten Zahlenwert und zeigt die Einheit des Datensatzes an. Im Browser mit synthetischen Daten reproduziert. Beim Limit `10 mg/kg` wurden sowohl `10 mg/kg` als auch `10 g/kg` als konform angezeigt, auch im Batch mit `g/kg`.
- `runCheck()` verwendet `parseFloat()` mit Austausch des ersten Dezimalkommas. Im Browser wurde `10abc` als `10` bewertet. Prüfe das gesamte Eingabefeld auf eine zulässige endliche Zahl und decke Grenzfälle wie Dezimalkomma, Tausendertrennung, negative Werte und leere Felder mit Tests ab. Welche Schreibweisen und Werte zulässig sind, ist fachlich festzulegen.
- In den geprüften JSON-Dateien (1.105 gebündelte und 1.281 veröffentlichte Einträge) sind keine expliziten Einheiten in den vom Loader gelesenen Feldern gesetzt. Bei Datensätzen im `kennnummer`-Format mit Grenzwert setzt `eval.js` ersatzweise `mg/kg`. Kläre die Einheit aus Datenvertrag und Quelle. Rechne nur bestätigte, vergleichbare Einheiten um oder fordere die belegte Einheit. Die sichtbare Eingabe und die tatsächlich geprüfte Einheit müssen übereinstimmen.

### P1 – Fachdaten-Veröffentlichung unterbrochen, Aktualitätsanzeige zu optimistisch

- Das ausgelieferte `manifest-v2.json` stammt vom 17. August 2026. Die drei jüngsten sichtbaren Datenläufe (24. und 31. August, 7. September) sind fehlgeschlagen. Beim jüngsten Lauf scheiterte der Checkout des Daten-Repositories mit `Bad credentials`. Prüfe die Berechtigung des hinterlegten Secrets und bestätige nach einem erneuten Lauf Manifest, Dateien und Hashes im Ziel-Repository. [Letzter sichtbarer Lauf](https://github.com/Lightblue87/FeedLabelCheck/actions/runs/34099972889) · [Datenmanifest](https://github.com/Lightblue87/FeedLabelCheck-Data/blob/main/manifest-v2.json)
- „Daten sind auf dem aktuellen Stand“ bedeutet in `backgroundUpdate()` lediglich, dass keine Änderungen heruntergeladen wurden. Auch ein altes oder unvollständiges Manifest kann diesen Status auslösen. Zeige Veröffentlichungsdatum und Ergebnis des letzten Abrufs getrennt an. Definiere fachlich, ab welchem Alter eine Warnung erscheint.

### P2 – Hintergrund-Updates können Datenstände oder Eingaben vermischen

- `DataUpdate.checkForUpdates()` schreibt jede verifizierte Datei einzeln. Scheitert die zweite Datei, kann der nächste Start eine neue mit einer alten Datei kombinieren. Hash und Größe prüfen die Übertragung. Lesbarkeit, Schema und Zusammengehörigkeit werden vor dem Speichern nicht geprüft. `Labeling.openDatabase()` schließt die bisherige Datenbank bereits vor dem Öffnen der neuen. Beim Start gibt es für vorhandene, aber unlesbare IndexedDB-Dateien keinen Ausweichpfad auf das Bundle.
- Nach einem erfolgreichen Datenupdate baut `populateSingleInputs()` Kategorie, Tierart, Alter, Einheit und Futtermitteltyp mit Standardwerten neu auf. Bereits eingegebene Werte und angezeigte Ergebnisse bleiben stehen. Ein Update kann damit mitten im Prüfvorgang den Kontext ändern. Eine per Stoffname abgeleitete Kennnummer wird zudem nur bei Änderung des Stoffnamens neu berechnet. Kläre, ob Datenwechsel erst zwischen Prüfungen aktiv werden oder laufende Eingaben und Ergebnisbezug erhalten bleiben sollen.
- Ziel für die technische Absicherung ist ein vollständig validierter Datenstand mit Rückfall auf die letzte lesbare Version. Teste einen Abbruch bei Datei zwei, beschädigte Daten, zwei offene Tabs und einen Update-Wechsel während einer Prüfung.

### P2 – Etikettenprüfung und OCR haben Grenzen bei unvollständigem Material

- Der Web-Check bewertet Textmuster. Ob alle relevanten Etikettflächen erfasst wurden, fließt nicht ein. Bei Text über der Mindestlänge kann ein fehlender kritischer Treffer schon zu „Auffällig“ führen. Einzelne Regeln ohne Prüfmuster können zugleich unprüfbar bleiben, obwohl die Zusammenfassung „alle Pflichtangaben gefunden“ meldet. Leite die Zusammenfassung aus den tatsächlich beurteilbaren Regeln ab und teste abgeschnittene, mehrteilige und mehrdeutige Etiketten.
- `setupLabeling()` in `app.js` startet je Dateiauswahl einen OCR-Worker. `terminate()` wird nur im Erfolgszweig erreicht. Mehrere Auswahlen können überlappen. Lege den Umgang mit Fehlern, Abbruch, Reihenfolge und wiederholter Auswahl fest. Sichere Fehlerbereinigung und manuelle Textkorrektur ab.
- Die Web-App hat keinen Scan-Verlauf mit Fotos, keinen strukturierten Abgleich zweier Deklarationen und keine automatische Bewertung der Fotoabdeckung. Die native App bietet Referenzcode, etwa `LabelCoverageAnalyzer.swift` und `LabelingControlComparisonService.swift`. PR #34 ergänzt einen Kamera-Dateieingang. Mobile Kameraaufnahme, komplexe Fotos und deren Lesbarkeit bleiben gesonderte Abnahmepunkte.

### P2 – Offline-DLG und Service-Worker-Updates

- Die mitgelieferte Datenbank enthält 602 EU-Katalogeinträge und 0 DLG-Einträge. Die heruntergeladene Datenbank aus dem August-Manifest enthält 602 EU- und 405 DLG-Einträge. Die Suche zeigt fehlende Quellen derzeit wie fehlende Treffer. Für eine vollständige DLG-Suche ab Erststart muss der gebündelte Stand DLG-Daten enthalten. Die Pipeline kann bei fehlendem DLG-PDF eine Datenbank ohne DLG erzeugen.
- `sw.js` löscht bei Aktivierung alle Caches derselben Origin, deren Name nicht mit der aktuellen Versionskennung beginnt. Im Browser wurde ein fremder Test-Cache entfernt. Begrenze Cache-Suche und Bereinigung auf FeedLabelCheck, besonders bei weiteren Projekten unter `lightblue87.github.io`.
- `controllerchange` lädt bei einem App-Update automatisch neu. Der aktive Formular- und OCR-Zustand ist flüchtig. Definiere, wann ein Reload zulässig ist und wie eine begonnene Prüfung einen Versionswechsel übersteht.

## Lokal starten und Änderungen prüfen

```bash
# Aus dem Repository-Stamm
node --test tests/js/*.mjs
python3 -m pytest -q tests/
python3 -m http.server 8080 --bind 127.0.0.1 --directory webapp
```

- Öffne `http://localhost:8080/`. Für eine Vorschau unter einem Unterpfad starte den Server ohne `--directory webapp` und öffne `/webapp/`. Halte lokale URLs relativ, damit die App unter `/FeedLabelCheck/` auf Pages funktioniert. Teste den Service Worker über HTTPS oder localhost.
- Aktualisiere beim Ändern ausgelieferter Dateien die Cache-Version und bei neuen Ressourcen die Vorabladeliste in `sw.js`. Prüfe mit einem frischen und einem bestehenden Browserprofil, getrennt für App-Update und Daten-Update. Offline nach der ersten vollständigen Installation erneut öffnen, einschließlich Katalog, Kennzeichnung und OCR. Prüfe bei Änderungen an der mobilen Bedienung zusätzlich Safari im iOS-Homescreen-Modus und Chrome auf Android.
- Ergänze bei Fachänderungen konkrete Fälle für Einzel und Batch mit identischem Prüfkontext, Grenzwerte, Einheiten, Mehrdeutigkeit und Quellenangaben. Sichere Kennzeichnungsänderungen mit Soll-Ergebnissen und zulässigen Testetiketten ab. Der vorhandene Python-Test `tests/test_webapp_js.py` ruft dieselben Node-Tests auf. Die Pages-Auslieferung hat aktuell kein eigenes Test-Gate.
- Befund vom 9. November: 20 Node-Tests bestanden. `pytest` meldete 247 bestanden und 3 wegen fehlender lokaler Trainingsdaten übersprungen. Lokaler Chromium-Test auf `main`: Einzel- und Batch-Eingaben, EU-Suche sowie Offline-Neustart mit OCR eines synthetischen Etiketts und anschließender Kennzeichnungsprüfung liefen. Geprüft wurden weder echte Mobilgeräte noch reale Etikettenfotos. Den Entwurf #34 habe ich per Diff geprüft. Seine Laufzeitprüfungen stehen in der PR-Beschreibung.

## Offene Produktentscheidungen

1. **Grenzwerte.** Welche Einheiten und Bezugsgrößen sind verbindlich, und aus welcher Quelle kommt die bestätigte Einheit pro Grenzwert? Soll die PWA zwischen freigegebenen Einheiten umrechnen oder pro Treffer nur die belegte Einheit zulassen?
2. **Datenbetrieb.** Wer pflegt das Veröffentlichungs-Secret, und wann ist ein Datenstand zu alt für einen unauffälligen Status? Soll die DLG-Liste schon beim ersten Offline-Start vollständig durchsuchbar sein?
3. **Etiketten.** Welche Futtermitteltypen und realen Etikettenfälle müssen für den nächsten Release zuverlässig funktionieren? Wann darf eine fehlende Angabe als „Auffällig“ gelten, wenn Etikettflächen fehlen oder der Text aus OCR stammt?
4. **Arbeitsstand.** Sollen Prüfentwürfe einen Reload lokal überstehen? Falls ein Verlauf gewünscht ist, welche Daten sollen gespeichert werden, wie lange, und gehören Fotos dazu?
