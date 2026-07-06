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
| **Datenstatus** | `DataStatusView` | Versions- und Regelübersicht der Datenbanken |

Die Kennzeichnungsregeln kommen unverändert aus `labeling.sqlite` und werden im
Browser per [sql.js](https://github.com/sql-js/sql.js) (SQLite als WebAssembly) gelesen.

## Starten

Statisches Hosting genügt (wegen `fetch` der Datendateien nicht per `file://` öffnen):

```bash
cd webapp
python3 -m http.server 8080
# → http://localhost:8080
```

Für GitHub Pages einfach das Verzeichnis `webapp/` als Pages-Quelle veröffentlichen.

## Daten aktualisieren

`data/zusatzstoffe.json` und `data/labeling.sqlite` sind Kopien der von der
CI-Pipeline (`.github/workflows/build-data.yml`) erzeugten Artefakte:

```bash
cp Data/zusatzstoffe.json webapp/data/
cp FeedLabelCheck/FeedLabelCheck/Resources/labeling.sqlite webapp/data/
```

Alternativ können die Fetch-URLs in `js/app.js` auf das öffentliche Daten-Repo
(`raw.githubusercontent.com/Lightblue87/FeedLabelCheck-Data/main/…`) zeigen.

## Nicht portiert

- Scan-Verlauf mit Foto-Speicherung (iOS-spezifisch, Fotos bleiben im Browser ohnehin lokal)
- Live-Kamera-Erkennung (VisionKit); stattdessen Foto-Upload mit OCR
- Automatischer Daten-Download mit SHA256-Verifikation (Web-App wird mit den Daten deployt)
