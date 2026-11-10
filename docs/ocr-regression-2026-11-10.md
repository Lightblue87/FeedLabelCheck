# OCR-Recovery-Tests: Mehrsprachige Futteretiketten (10.11.2026)

## Anlass und fachliche Grenzen

Für die Pavo-WeightLift-Verpackung wurden dem Projekt zwei echte Fotos sowie der stark fragmentierte OCR-Text zur Verfügung gestellt. Im ursprünglichen Zustand konnte die Etikettenprüfung elf Pflichtangaben nicht finden. **Kein OCR-Treffer ist kein Nachweis eines Kennzeichnungsverstoßes.**

Für technische Tests außerhalb des Browsers wurde lokal **Tesseract 5.5.0 mit deutschem Sprachmodell**, PSM 6, auf ausgewählte Bildausschnitte angewendet. Die PWA verwendet Tesseract.js; Ergebnisse sind deshalb **nicht** automatisch identisch. Die Originalfotos werden **nicht in das öffentliche Repository übernommen**.

## Beobachtungen bei echten Pavo-Fotos

| Bildbereich | Vollbild / ursprünglicher OCR-Text | Skalierter Nahbereich (lokal) | Ergebnis |
| --- | --- | --- | --- |
| Mehrsprachige Zutatenliste | Vollbild-OCR las hauptsächlich die Fütterungstabelle; deutsche Zutatenliste fehlte | Landschaftsfoto 1536×864: x=7,5–93 %, y=11–52 %, Faktor 2 | Deutsche Zeile `DE Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid` erkannt |
| Tschechische Analyse | Nutzer-OCR stark fragmentiert | Hochkantfoto 864×1536: x=5–75 %, y=25–68 %, Faktor 2,5 | `Hruby protein 16,5%` und `Fosfor 0,40%` unter weiteren Rohwerten lesbar |
| Vollbild nur hochskaliert / zu breiter Oberstreifen | Gemischte Sprachzeilen oder Unterdrückung kleiner Textzeilen | Nicht ausreichend | Enge statt pauschaler Vollbild-Nachlesung verwenden |

Die zusätzliche OCR darf nur **nachweislich gelesene Textfragmente** übernehmen. Keine Produktdatenbankwerte als vermeintlich aus dem Bild erkannte Etikettenwerte ausgeben. Insbesondere wird die tschechische Tabelle **nicht automatisch als deutsche Rechtskonformität** bewertet.

## Zusätzliche unabhängige Testmuster

Drei öffentlich zugängliche Referenzmuster für funktionale Regressionen:

1. [Pavo WeightLift – Produktdaten und Fütterungstabelle](https://www.pavo.net/horsefeed/essentials-allround/pavo-weightlift/): mehrere Gewichtsgruppen, Zutaten und prozentuale Analyse
2. [AGROBS Nagermenü – Heimtier-Ergänzungsfutter](https://www.agrobs.de/de/nagermenue-p3086/): deutschsprachige Zusammensetzung, zweispaltige Analytik und Vitamin-/Spurenelementlisten
3. [AGROBS Kraftpaket – Pferde-Ergänzungsfutter](https://www.agrobs.de/de/kraftpaket-p3057/): analytische Gehalte und Fütterungsempfehlung

Aus den **Layouttypen** wurden eigenständige, künstliche Prüfbilder angelegt und lokal mit Tesseract überprüft. Diese simulieren die beiden häufigen Probleme, sind aber **keine echten Herstelleretiketten**:

- **Zweisprachige Zweispalten-Tabelle:** Vollbild-OCR vermischt `Zusammensetzung` und `Composition` sowie `Rohprotein` und `Crude protein` auf derselben Zeile. Getrennte linke/rechte Ausschnitte lesen diese Felder separat.
- **Dichtes Zusatzstoffverzeichnis:** Mengen und Einheiten werden teilweise gelesen, einzelne Kennnummern aber falsch (`3b603` kann z. B. als `36603` erscheinen). Daher niemals allein wegen OCR einen Zusatzstoff mit legalem Eintrag gleichsetzen.

**Testquellen sind Hinweise für Regressionstests, keine juristisch verifizierte Deklaration des konkret fotografierten Produkts.** Produktrezepturen können sich ändern.

## Umsetzung in PR #54

- `webapp/js/ocr.js`: `shouldRecoverText`, `hasMixedLanguageColumns`, `recoveryRegions` und `recoveredEvidence` bestimmen wenige überlappende, hochskalierte Bildbereiche und übernehmen nur belastbare Zusatzbelege (u. a. DE-Zutatenlisten und erkannte analytische Tabellen).
- `webapp/js/app.js`: Direkt nach der ersten Foto-OCR bei Bedarf höchstens drei Zusatzläufe; Stopp nach dem ersten verwertbaren Zusatzbeleg, keine neuen Sprachpakete. Zusatzlesung wird als nachzuprüfender OCR-Wert kenntlich gemacht.
- `tests/js/ocr-recovery.test.mjs`: Bildregionen, gemischte Spalten, Zutaten, analytische Gehalte und Nichtübernahme unzusammenhängender Zahlenwerte.
- `tests/js/conformity-status.test.mjs`: Elf fehlende OCR-Treffer dürfen keine elf Rechtsverstöße ergeben.
- `.github/workflows/test-js.yml`: PWA-JavaScript-Tests bei Pull Requests ausführen.

## Grenzen und Abnahmebedingungen

- Verbesserte lokale OCR-Beispiele sind **kein vollständig bestandener iPhone-End-to-End-Test**. Prüfe Pavo-Fotos in Safari/PWA auf realem iPhone; überprüfe Wartezeit, Browser-Speicher, Offline-Updates und die Wiederverwendung alter Originalfotos.
- Die neuen Region-Heuristiken müssen auf mindestens einem weiteren **echten** mehrsprachigen Heimtier- und einem Nutztier-Etikett anhand der sichtbaren Originalfelder gemessen werden.
- Weder aus tschechischen Analysebezeichnungen noch aus abgeschnittenen Tabelleneinträgen dürfen unbelegte deutsche Pflichtangaben generiert werden.
- Bei widersprechenden Werten in mehreren Ansichten muss die Prüfung `unklar` bleiben. Zulassung und verbindliche Grenzwerte bleiben separate Fachprüfung.
- **Kein Merge ohne ausdrückliche Freigabe.**

## Nachbesserung nach Durchsicht (10.11.2026)

- **Vergrößerung auf großen Fotos:** Die Skalierung der Nachlese-Ausschnitte wird nach Pixelfläche begrenzt (12 Mio. Pixel) statt nach Kantenlänge. Bei Fotos in Handygröße (4032×3024, 3024×4032) liegt die Vergrößerung damit bei 1,5- bis 1,8-fach statt bei 0,8- bis 1,3-fach. Der Speicherverbrauch auf dem iPhone ist damit höher und noch nicht gemessen.
- **Überschrift der Zutatenzeile:** Liegt die Überschrift „Zusammensetzung / Composition / …“ nicht im Ausschnitt, wird die bereits im Haupttext gelesene Überschrift verwendet. Ohne gelesene Überschrift wird weiterhin nichts übernommen.
- **Status `auffaellig`:** Der Text-Check erzeugt ihn nicht mehr. Die Anzeige bleibt für ältere Verlaufseinträge erhalten.

## Deutsche Textteile bei mehrsprachigen Etiketten (10.11.2026)

Auf der Pavo-WeightLift-Rückseite steht jede Angabe in zehn bis zwölf Sprachen („Samenstelling / Komposition / Composition / …“, „Slank paard / Mageres Pferd / Lean horse“, „NL …“, „DE …“). Die Zusammensetzungskarte zeigte deshalb die ganze Überschrift mit allen Sprachen („Compasicäo/Sloden!/: Luzerne, …“) als Beleg.

- `Ocr.germanView(text)` liefert eine Sicht auf den Text, in der nur die deutschen Teile stehen: Zeilen mit anderem Sprachkürzel entfallen, sobald eine „DE …“-Zeile vorhanden ist; aus „A / B / C“ wird das eindeutig deutsche Segment gewählt (Wortliste, Umlaute brechen nur Gleichstände); eine deutsche Überschrift („Komposition“, „Zusammensetzung“) wird mit der „DE“-Zutatenzeile zusammengeführt.
- Die Prüfung läuft auf dieser Sicht. Das Textfeld und der Verlauf behalten den OCR-Text unverändert, die Prüfung nennt den Filter („geprüft wurden nur die deutschen Textteile“).
- Zeilen ohne eindeutiges deutsches Segment bleiben unverändert. Zeilen mit nur zwei Segmenten werden nur bei deutlichem Vorsprung und ohne deutsche Treffer im anderen Segment gekürzt („Tag / Nacht“ bleibt).
- Grenze: Das Segment wird an der Zeile gewählt. Absätze, die über Zeilenumbrüche mit „ / “ weiterlaufen, werden nur zeilenweise gekürzt. Der Filter ersetzt nicht die Prüfung, ob ein deutscher Text auf der Verpackung steht.
