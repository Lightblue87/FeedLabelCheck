# FeedLabelCheck – Web-App

Browser-Portierung der FeedLabelCheck-App. Alle Prüfungen laufen vollständig
clientseitig – es wird kein Server benötigt und keine Daten verlassen den Browser.

## Bedienung

App-Shell wie bei einer nativen App: kompakte App-Leiste oben, Navigation unten
in der Daumenzone (ab 900 px Breite als Seitenleiste), Hell-/Dunkelmodus folgt
dem System.

| Tab | Inhalt |
|---|---|
| **Grenzwerte** | Gemeinsamer *Prüfkontext* (Kategorie, Tierart, Alter) + Umschalter **Einzelwert** / **Mehrere Werte** (Batch als Karten statt Tabelle) |
| **Etikett** | Foto aufnehmen oder Bilder wählen → OCR → Text prüfen → Kennzeichnung prüfen. Jede Prüfung wird lokal im **Verlauf** gespeichert (siehe unten) |
| **Futtermittel** | Suche im EU-Katalog und der DLG-Positivliste |
| **Daten** | Datenstand, Update-Status, Hinweise |

Direktsprünge per Hash (`#check`, `#labeling`, `#materials`, `#status`); das
Manifest enthält dafür App-Shortcuts (Langdruck auf das Home-Bildschirm-Icon).

## Prüfverlauf (Etikett)

Jede Etikettprüfung wird automatisch als Entwurf lokal gespeichert (IndexedDB,
`js/history.js`) und nach App-Neustart wiederhergestellt:

- **Originalfotos** (Aufnahme und Upload) werden unverändert beim Eintrag abgelegt
  und lassen sich auch offline öffnen: Betrachter mit Foto und korrigierbarem Text
  nebeneinander, Blättern zwischen mehreren Fotos, Antippen zum Vergrößern.
- **Aufbewahrung:** Einträge werden 14 Tage ab Erfassung aufbewahrt und beim Start
  sowie beim Zurückkehren in die App samt Fotos gelöscht. **Behalten** schützt einen
  Eintrag samt Fotos, bis die Markierung entfernt oder der Eintrag manuell gelöscht
  wird; danach gilt wieder die Frist ab Erfassung.
- **Neuer Check** startet einen leeren Eintrag, der bisherige bleibt im Verlauf.
  Beim Öffnen eines Eintrags wird das Ergebnis mit den aktuellen Regeln neu berechnet.
- Alles bleibt auf dem Gerät. Ist IndexedDB nicht verfügbar (z. B. manche private
  Fenster), blendet die App den Verlauf aus und prüft wie bisher ohne Speicherung.

## Funktionen

| Funktion | Entspricht (iOS/Desktop) | Umsetzung |
|---|---|---|
| **Einzelprüfung** | `EinzelpruefungWidget` / `SingleCheckView` | Port von `laves_eval.py` nach JavaScript (`js/eval.js`): Tierart-/Alters-/Kategorie-Filter, Synonym-Deduplizierung, Grenzwert-Bewertung |
| **Batch-Prüfung** | `BatchCheckView` | Mehrere Laborwerte gleichzeitig gegen die Grenzwerte |
| **Kennzeichnungs-Check** | `LabelingCheckService` + `LabelingFeedTypeDetector` | 1:1-Port der Regel-/Mustersuche und Futtermitteltyp-Erkennung (`js/labeling.js`); OCR lokal per [tesseract.js](https://github.com/naptha/tesseract.js) (Deutsch) mit Nachbearbeitung (`js/ocr.js`): Konfidenz-Filter gegen Hintergrund-Rauschen, Zusammenführen von Silbentrennungen, Korrektur typischer Fehllesungen von Zusatzstoff-Codes wie `(33671)` → `(3a671)` |
| **Futtermittel-Suche** | `FeedMaterialLookupService` | Volltextsuche im EU-Katalog (VO 68/2013) und der DLG-Positivliste |
| **Datenstatus** | `DataStatusView` | Versions- und Regelübersicht, Update-Status |
| **Auto-Update** | `DataDownloadService` + `AppUpdateCoordinator` | `js/data-update.js`: prüft beim Start `manifest-v2.json` aus dem Data-Repo, lädt nur geänderte Dateien, verifiziert SHA256 + Größe (Web Crypto API) und speichert sie in IndexedDB; offline läuft die App mit dem letzten Stand weiter |

Die Kennzeichnungsregeln kommen unverändert aus `labeling.sqlite` und werden im
Browser per [sql.js](https://github.com/sql-js/sql.js) (SQLite als WebAssembly) gelesen.

## Installation als App (PWA)

Die Web-App ist eine installierbare PWA (Manifest + Service Worker, App-Shell
und lokal mitgelieferte Bibliotheken inkl. WASM/OCR-Sprachdaten werden gecacht
→ läuft nach dem ersten Besuch komplett offline):

- **iPhone/iPad**: Seite in Safari öffnen → Teilen-Menü → „Zum Home-Bildschirm".
  Die App startet dann im Vollbild mit eigenem Icon.
- **Laptop/Desktop**: In Chrome/Edge über das Install-Symbol in der Adressleiste
  („App installieren"); in jedem anderen Browser einfach als Website nutzen.

Voraussetzung ist HTTPS-Hosting (z. B. GitHub Pages) — Service Worker laufen
nur in sicheren Kontexten (oder auf `localhost`).

## Starten

Statisches Hosting genügt (wegen `fetch` der Datendateien nicht per `file://` öffnen):

```bash
cd webapp
python3 -m http.server 8080
# → http://localhost:8080
```

Für GitHub Pages einfach das Verzeichnis `webapp/` als Pages-Quelle veröffentlichen.

## Daten & Updates

Die App aktualisiert sich bei jedem Start selbst: `js/data-update.js` lädt
`manifest-v2.json` aus `Lightblue87/FeedLabelCheck-Data` (wöchentlich von der
CI-Pipeline `.github/workflows/build-data.yml` befüllt), vergleicht die
SHA256-Prüfsummen mit dem lokalen Stand, lädt nur geänderte Dateien, verifiziert
sie und legt sie in IndexedDB ab. Ohne Internet (oder wenn das Manifest nicht
erreichbar ist) läuft die App mit dem zuletzt gespeicherten bzw. mitgelieferten
Stand weiter.

`data/zusatzstoffe.json` und `data/labeling.sqlite` sind nur der Erststart-Fallback
und können gelegentlich mit den CI-Artefakten aufgefrischt werden:

```bash
cp Data/zusatzstoffe.json webapp/data/
cp FeedLabelCheck/FeedLabelCheck/Resources/labeling.sqlite webapp/data/
```

## Nicht portiert

- Live-Kamera-Erkennung (VisionKit); stattdessen Foto-Upload mit OCR
