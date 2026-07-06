# FeedLabelCheck – Web-App

Browser-Portierung der FeedLabelCheck-App. Alle Prüfungen laufen vollständig
clientseitig – es wird kein Server benötigt und keine Daten verlassen den Browser.

## Funktionen

| Funktion | Entspricht (iOS/Desktop) | Umsetzung |
|---|---|---|
| **Einzelprüfung** | `EinzelpruefungWidget` / `SingleCheckView` | Port von `laves_eval.py` nach JavaScript (`js/eval.js`): Tierart-/Alters-/Kategorie-Filter, Synonym-Deduplizierung, Grenzwert-Bewertung |
| **Batch-Prüfung** | `BatchCheckView` | Mehrere Laborwerte gleichzeitig gegen die Grenzwerte |
| **Kennzeichnungs-Check** | `LabelingCheckService` + `LabelingFeedTypeDetector` | 1:1-Port der Regel-/Mustersuche und Futtermitteltyp-Erkennung (`js/labeling.js`); OCR lokal per [tesseract.js](https://github.com/naptha/tesseract.js) (Deutsch) |
| **Futtermittel-Suche** | `FeedMaterialLookupService` | Volltextsuche im EU-Katalog (VO 68/2013) und der DLG-Positivliste |
| **Datenstatus** | `DataStatusView` | Versions- und Regelübersicht, Update-Status |
| **Auto-Update** | `DataDownloadService` + `AppUpdateCoordinator` | `js/data-update.js`: prüft beim Start `manifest-v2.json` aus dem Data-Repo, lädt nur geänderte Dateien, verifiziert SHA256 + Größe (Web Crypto API) und speichert sie in IndexedDB; offline läuft die App mit dem letzten Stand weiter |

Die Kennzeichnungsregeln kommen unverändert aus `labeling.sqlite` und werden im
Browser per [sql.js](https://github.com/sql-js/sql.js) (SQLite als WebAssembly) gelesen.

## Installation als App (PWA)

Die Web-App ist eine installierbare PWA (Manifest + Service Worker, App-Shell
und CDN-Bibliotheken werden gecacht → läuft nach dem ersten Besuch komplett offline):

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

- Scan-Verlauf mit Foto-Speicherung (iOS-spezifisch, Fotos bleiben im Browser ohnehin lokal)
- Live-Kamera-Erkennung (VisionKit); stattdessen Foto-Upload mit OCR
