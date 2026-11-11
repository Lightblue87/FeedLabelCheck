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

## Nachlese der Fütterungstabelle (10.11.2026)

Auf der Pavo-Rückseite kam die Fütterungstabelle zerstört an („FEEDING AD rgewicht / Body weig“, „Mageres eigh rweilg“). Die Nachlese kannte bisher nur Zutaten und Analyse.

- `Ocr.needsFeedingRecovery(text)`: Es gibt eine Fütterungsüberschrift (auch zerlesen wie „FEEDING AD …“) und ein Tabellenmerkmal („Körpergewicht“, „Body weight“, „Lichaamsgewicht“), aber weniger als drei deutsche Zeilen. Eine einzelne Fütterungsempfehlung („500 g pro Tag“) löst nichts aus.
- `recoveryRegions` stellt dann einen eigenen Ausschnitt der Tabelle voran (Querformat 8–72 % × 60–92 %, 2,5-fach; Hochformat 5–95 % × 45–98 %, 2-fach). Insgesamt bleiben es höchstens drei Ausschnitte.
- `germanView` behält Mengen am Zeilenende und das deutsche Teilwort der Einheit: „Slank paard / Mageres Pferd / Lean horse 0,5 kg/dag/Tag/day 1,0 kg/dag/Tag/day“ wird zu „Mageres Pferd 0,5 kg/Tag 1,0 kg/Tag“.
- `recoveredEvidence` übernimmt die Tabelle nur mit gelesener Überschrift (im Ausschnitt oder im Haupttext) und mindestens drei deutschen Zeilen mit Mengen je Tag.
- `app.js` liest nach einem Treffer weiter, solange die Fütterungstabelle fehlt.

Grenze: Die Ausschnittsgrenzen sind für das Pavo-Layout bestimmt. Auf anderen Layouts kann die Tabelle woanders liegen. Eine Messung auf dem iPhone steht aus.

## Zweispaltige Etiketten ohne Überschriftenpaar (10.11.2026)

Beispiel: animonda „Vom Feinsten Adult mit Pute + Kaninchen“ (Schale, Rückseite). Links stehen Deutsch und Französisch, rechts Niederländisch und Italienisch. Tesseract liefert das ganze Etikett als einen Block mit 40 Zeilen, und die Spalten kamen Zeile für Zeile vermischt an („Zusammensetzung: 65 % Fleisch und tierische Neben- Samenstelling: 65 % vlees en dierlijke bijproducten“). Die Belege der Karten waren dadurch Mischtext, zum Beispiel für Futtermittelart („© & € Alleinfuttermittel © Volledig diervoeder“) und Haltbarkeit („siehe zie opdruk“).

Ursache: `findColumnGutter` suchte die Spaltenlücke nur in einer Zeile, in der ein Wort mit „:“ von einer Abschnittsüberschrift gefolgt wird. Hier endet die linke Zeile mitten im Satz („Neben-“).

- `coverageGutter` (Ergänzung zu `findColumnGutter`): Die Lücke ist ein senkrechtes Band im mittleren Drittel, das höchstens 12 % der Zeilen überdecken (mindestens 0,6 Wörterhöhen breit). Beide Seiten brauchen mindestens sechs Zeilen und 35 % der Zeilen, und im Median mindestens vier Wörter je Zeile (Fließtext). Eine Tabelle aus Namens- und Wertespalte und einspaltiger Text werden deshalb nicht getrennt. Mindestens zwölf Zeilen mit Position sind nötig.
- Wirkung am echten Etikett: Futtermittelart „Alleinfuttermittel“, Zusammensetzung „65 % Fleisch und tierische Nebenerzeugnisse (Schwein, 25 % Pute, 8 % Kaninchen), Mineralstoffe“, Haltbarkeit „siehe Aufdruck“, jeweils ohne niederländischen Text.
- Grenze: Die Nettomenge („e100g“ in großer Schrift) wird nicht gelesen. Die Analytischen Bestandteile stehen als „Protein/Protéine/Eiwit/Proteine 11 %“ ohne Leerzeichen um die Schrägstriche und über Zeilenumbrüche hinweg (siehe nächster Abschnitt). Eine Messung auf dem iPhone steht aus.

## Analytische Bestandteile in mehrsprachiger Schreibweise (10.11.2026)

Auf dem animonda-Etikett laufen die Analytischen Bestandteile als Fließtext über mehrere Zeilen. Jeder Eintrag nennt den Namen in vier Sprachen, durch „/“ ohne Leerzeichen getrennt, danach den Wert; die Einträge trennt ein „+“ oder „«“. Ein Trennstrich bricht Wörter („Fett-“ + „gehalt/Teneur …“). Der Filter für deutsche Textteile (nur „ / “ mit Leerzeichen) griff dort nicht. Die Karte zeigte nur die Überschriftzeile, die Feuchte war „Wahrscheinlich“.

- `germanAnalysisBlock` in `webapp/js/ocr.js` erkennt den Block ab „Analytische Bestandteile/…“ bis zum nächsten Abschnitt (Zusatzstoffe, Fütterungsempfehlung, Inverkehrbringer, Leerzeile, höchstens 14 Zeilen), entfernt Rauschpräfixe („==“, „ZZ“), verbindet getrennte Wörter und liest jeden Eintrag bis zum Wert (`%`, `mg/kg`, `g/kg`).
- Pro Eintrag wird der deutsche Name aus einer Liste analytischer Namen gewählt (Rohprotein, Protein, Fettgehalt, Rohfaser, Rohasche, Feuchtigkeit, Taurin, Calcium, Phosphor …). Ein Eintrag ohne deutschen Namen oder ohne gelesenen Wert entfällt. Es braucht mindestens zwei Einträge und mindestens zwei Hinweise auf andere Sprachen im Block, sonst bleibt der Text unverändert.
- Ergebnis in der deutschen Sicht: „Analytische Bestandteile: Protein 11 %, Fettgehalt 5 %, Rohfaser 0,3 %, Rohasche 1,6 %, Feuchtigkeit 81 %.“ Die Karten „Analytische Bestandteile“ und „Feuchtegehalt“ sind damit „Gefunden“ statt „Wahrscheinlich“. Das Textfeld und der Verlauf behalten den OCR-Text.
- Grenze: Taurin 600 mg/kg steht auf dem Foto in der Zeile unter „Taurin/Taurine/“; sie wurde in der Vollbild-OCR nicht gelesen, der Eintrag entfällt dann. Die Namensliste kennt nur die gängigen deutschen Analysebegriffe, andere Namen entfallen. Der Fehler „33671“ statt „3a671“ im Zusatzstoffcode ist nicht Teil dieser Änderung.

## Zusatzstoffcodes ohne Klammer nach der Menge (10.11.2026)

Auf dem animonda-Etikett stehen die Kennnummern ohne Klammer direkt nach der Menge („200 IE 3a671, 1 mg 3b406, 11,4 mg 3b605, …“). Die OCR las „3a671“ als „33671“ und „3b605“ als „36605“ (Buchstabe als Ziffer). Die Korrektur gab es bisher nur für Codes in Klammern.

- `fixUnknownCodes` in `webapp/js/ocr.js` korrigiert jetzt auch einen unbekannten Code ohne Klammer, wenn er unmittelbar hinter einer Menge mit Einheit steht (`mg`, `g`, `µg`, `IE`/`JE`/`I.E.`, `IU`, `KBE`, `CFU`, auch verlesen wie „m0“, optional `/kg`). Der Code darf in der nächsten Zeile stehen („11,4 mg⏎36605“).
- Es gilt dieselbe Regel wie in Klammern: Korrigiert wird nur, wenn genau ein Buchstabe nach der Gruppenziffer eine bekannte Kennnummer ergibt. Bekannte Codes, Zahlen ohne Einheit davor („3 kg 33671 Stück“, „Artikel 33671“) und nicht eindeutige Kandidaten bleiben unverändert. In den echten Daten haben „33671“, „36605“ und „36503“ je genau einen Kandidaten.
- Grenze: Die Karte „Zusatzstoffe“ bleibt auf diesem Etikett „Wahrscheinlich“. Die Überschrift steht mehrsprachig („Ernährungsphysiologische Zusatzstoffe/Additifs nutritionnels/…“) und mit Lesefehler („Emnährungs…“), die Liste wird noch nicht als deutsche Zeile erkannt. Das wäre der nächste Schritt analog zu den Analytischen Bestandteilen.

## Zwei Lesungen je Foto, aufbereitete Kacheln und Vereinigung (10.11.2026)

Ausgangsbefund: Tesseract.js liest ohne weitere Angabe das ganze Foto als einen Textblock. Spalten werden dabei zeilenweise vermischt, und eine einzige Helligkeitsschwelle für das ganze Bild versagt bei ungleichmäßig beleuchteten, schräg oder gewölbt fotografierten Etiketten. Bei der Pavo-Rückseite blieben im Vollbild 103 sicher gelesene Buchstaben, mit Kacheln rund 1.730 (Maß: Buchstaben in Wörtern ab drei Buchstaben mit Sicherheit ab 75, `Ocr.linesQuality`).

Ablauf in `readLabelPhoto` (`webapp/js/app.js`):

1. Grundlesung mit Seitenaufteilung (Textblöcke, also spaltenweise). Danach wie bisher die Ausrichtungsprüfung.
2. Zweite Lesung als ein Block. Sie behält Zeilen über die ganze Breite, die die Seitenaufteilung zerschneidet (z. B. eine Anschrift unter zwei Spalten).
3. `Ocr.mergeTiles` vereinigt beide wortweise. Die Lesung mit mehr sicher gelesenem Text gibt Zeilen und Reihenfolge vor, die andere ergänzt und ersetzt. Die Seitenaufteilung führt nur bei mehr als 5 % Vorsprung: Sie zerschneidet gelegentlich Fließtext in Teilzeilen (Katzenfutter-Etikett aus der öffentlichen Stichprobe, dort ist die Blocklesung mit 347 gegen 214 Buchstaben klar besser).
4. Bei schwacher Lesung (Sicherheit unter 70 oder `shouldRecoverText`) folgen Kacheln aus `Ocr.tileGrid` (höchstens 3 × 3, 8 % Überlappung). Je Kachel: Beleuchtungsausgleich (`flattenIllumination`), Neigung messen (`estimateSkew`, ±6°) und gerade richten, lesen, Wortrahmen zurückrechnen (`unrotateBox`). Die Kacheln ersetzen die vereinigte Vollbild-Lesung nur bei deutlich mehr sicher gelesenem Text (Faktor 1,2 plus 30 Buchstaben).

Regeln der Vereinigung (`mergeTiles`), jeweils mit einem Fall aus den Testfotos:

- Dasselbe Wort: Rahmen decken sich waagerecht zur Hälfte, die Mitten liegen auf gleicher Höhe (0,4 Worthöhen). Liegen mehrere Wörter an der Stelle, gewinnt das gleich gelesene.
- Ersetzt wird nur bei mindestens zehn Punkten mehr Sicherheit und nicht weniger Zeichen („%“ ersetzt kein „11%“).
- Ein neues Wort muss sicher gelesen sein und in seiner eigenen Lesung auf der Höhe des Nachbarn liegen, entlang der Zeilenneigung (bei Kacheln der gemessene Winkel, bei ganzen Fotos der Median über die langen Zeilen der Lesung). Sonst zieht eine Lesung Wörter der Nachbarzeile herüber („(3b502)“ beim Carolina-Etikett).
- Zeilen derselben Lesung werden nie verbunden. Unsicher gelesene Zeichen ohne Buchstaben oder Ziffern sind kein Anker.
- Entartete Wortrahmen: Streifen unter fünf Bildpunkten entfallen. Ein Rahmen ab dem 2,4-Fachen der Zeilenhöhe wird auf die Zeile gestutzt, das Wort bleibt („max.“ mit Rahmen über zwei Zeilen). Ein Rahmen in Zeilenhöhe neben kleinen Tabellenwerten (Faktor 2) bleibt unverändert, sonst gingen einzeln stehende Zutaten verloren.
- Eine Zeile, die nur die spätere Lesung kennt, braucht zwei sicher gelesene Wörter.
- Reihenfolge: die der führenden Lesung. Eine Zeile rückt vor eine frühere, die waagerecht mit ihr überlappt und deutlich tiefer steht („Siehe Aufdruck“ stand vor „Kennnummer der Partie:“).
- An einer Innenkante abgeschnittene Wörter entfallen, die Nachbarkachel enthält sie ganz. Eine Zeile wird über die Naht fortgesetzt, auch ohne gemeinsames Wort (Tabelle „Name … Wert“).

Deutsche Sicht (`germanView`), zwei Ergänzungen:

- Nach der letzten fremdsprachigen Zeile eines sprachweisen Blocks („NL …“, „DE …“, „CZ …“) trennt eine Leerzeile den Abschnitt. Die Pavo-Zusammensetzung lief vorher in die bruchstückhaft gelesene Überschrift der Lagerungshinweise hinein.
- In `webapp/js/labeling.js` zählt eine Kennnummer direkt hinter der Menge („200 IE 3a671“) wie ein Stoffname. Vorher galt eine Liste nur aus Mengen und Kennnummern nicht als Zusatzstoffangabe, die Karte zeigte stattdessen „Taurin 600 mg/kg“ aus den Analytischen Bestandteilen.
- `germanAdditivesBlock`: „Ernährungsphysiologische Zusatzstoffe/Additifs nutritionnels/…/Additivi nutrizionali (/kg): 200 IE 3a671, …“ wird zu „Ernährungsphysiologische Zusatzstoffe (/kg): 200 IE 3a671, …“. Bedingung: vor dem Doppelpunkt stehen nur Übersetzungen der Überschrift, keine Mengen. „Zusatzstoffe/kg: …“ bleibt unverändert.

Vergleich im Browser (Chromium, normaler Foto-Upload, gleicher Datenstand), vorher = Stand `14504c5`:

| Etikett | Vorher | Nachher |
| --- | --- | --- |
| Pavo WeightLift, beide Nutzerfotos | 571 Zeichen, Zusammensetzung nicht gelesen, 27 s | 2.886 Zeichen, „Komposition: Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid“, 22 s |
| animonda Vom Feinsten | Anschrift ohne Straße, Taurin fehlt, Zusatzstoffe „Wahrscheinlich“ (nur Überschrift), 10 s | „animonda petcare gmbh Frankfurter Str. 31 49214 Bad Rothenfelde“, Taurin 600 mg/kg, Zusatzstoffe „Gefunden“ mit „200 IE 3a671, 1 Mg 3b406, 11,4 mg 3b605, 1,4 mg 3b503, 0,1 mg 3b202“, Überschrift „Nettomasse“, 19 s |
| Carolina Mineralfutter | alle Karten wie nachher, 13 s | unverändert vollständig, zusätzlich „Geeignet zur Herstellung gentechnikfreier Lebensmittel.“ zusammenhängend, 15 s |

Stichprobe mit zwölf öffentlichen Etikettenfotos von Open Pet Food Facts (je ein Foto, automatische Typwahl, vorher gegen nachher im Browser): Der Status aller Karten ist bei den drei Fotos mit erkanntem Futtermitteltyp gleich geblieben. Acht Fotos liefern mehr Text (zwei davon erstmals überhaupt: 26 → 854 und 0 → 750 Zeichen), drei etwas weniger (höchstens 46 Zeichen), eines gleich viel. Die Laufzeit je Foto lag bei 3 bis 47 s (vorher 2 bis 38 s); bei vier Fotos stieg sie auf das Doppelte oder mehr, bei sechs sank sie. Die Bilder bleiben außerhalb des Repositorys.

Grenzen:

- Laufzeit: Jedes Foto wird mindestens zweimal gelesen, bei schwacher Lesung kommen bis zu neun Kacheln dazu. Die Zeiten oben stammen aus Chromium auf einem Rechner. Auf dem iPhone ist die Laufzeit nicht gemessen.
- Die Nettomenge „e100g“ auf dem animonda-Etikett wird weiterhin nicht gelesen (große Schrift neben dem ℮-Zeichen).
- Beim Carolina-Etikett bleiben die eng gesetzten, zweizeiligen Einträge für Kupfer, Jod und Selen in beiden Lesungen fehlerhaft. Die Vereinigung verbindet sie nicht mehr falsch, liest sie aber auch nicht besser.
- Die Kacheln werden beim Carolina-Etikett ausgelöst, obwohl sie nichts beitragen (eine Zutat je Zeile gilt für `shouldRecoverText` als unvollständig). Das kostet Zeit, ändert aber das Ergebnis nicht.
- Tests: `tests/js/ocr-tiles.test.mjs` (konstruierte Wortrahmen und Graustufenbilder) und `tests/js/german-view.test.mjs`. Die Nutzerfotos bleiben außerhalb des Repositorys.

## Weitere Nutzerfotos: Drehung, Randspalten, Aufdrucke (10.11.2026)

Elf weitere Produkte aus 15 Nutzerfotos im normalen Foto-Upload geprüft (Chromium, vorher = `14504c5`): animonda Schale, IAMS, Purina Gourmet, Katzenmilch-Snack mit Aufdruckfoto, AlpenGrün Mash, AGROBS Seniormineral, Vitakraft, proCani, animonda Hundesnack, Kaufland-Dose, Lucky-Kitty. Die Fotos bleiben außerhalb des Repositorys.

Funde und Korrekturen:

- **Hochkant fotografierte Etiketten (IAMS, Purina, Vitakraft).** Mit der Seitenaufteilung als erster Lesung waren die Wörter durcheinander („Katzen, Alleinfuttermittel WEIL ausgewachsene NAPF JEDER“): Sie liest auch um 90° gedrehte Schrift, die Ausrichtungsprüfung griff dann nicht, und die hochkant stehenden Wortrahmen wurden als waagerechte Zeilen verarbeitet. Jetzt ist die Blocklesung wieder die erste Lesung, an ihr hängt die Ausrichtungsprüfung; die Seitenaufteilung folgt auf dem gedrehten Foto. `Ocr.uprightLines` lässt hochkant gelesene Zeilen der Seitenaufteilung weg.
- **Schmale Randspalte neben Fließtext (Lucky-Kitty, AlpenGrün Mash).** Ein Kasten mit Hersteller, Charge und Haltbarkeit oder eine Tabelle „Inhaltsstoffe“ neben dem Haupttext wurde zeilenweise angehängt. Folge: Partie „40233“ (die Postleitzahl hinter „Bezugsnummer der Partie:“), Hersteller „langsam anfüttern AGROBS GmbH & Co. KG“. `reorderSideColumns` in `webapp/js/ocr.js` erkennt eine Folge von Zeilen mit breiter Wortlücke an derselben Stelle und trennt sie: erst der linke Text, dann die Randspalte. Bedingungen: mindestens vier getrennte Zeilen, links Fließtext (Median mindestens vier Wörter), rechts überwiegend Text. Tabellen aus Name und Wert und Fütterungstabellen bleiben zusammen. Schließt eine weitere Folge an derselben Stelle an, genügen zwei Zeilen.
- **Schräger Aufdruck (MHD-Streifen am Karton, etwa 13° geneigt).** `estimateSkew` misst jetzt bis ±15°. Kacheln, die die Vollbild-Lesung nicht ersetzen, ergänzen sie: sicher gelesene Wörter und Zeilen kommen dazu. Ein sicher gelesenes Wort ersetzt das fast gleiche unsichere („HD“ → „MHD“); bei mindestens 30 Punkten mehr Sicherheit darf es etwas kürzer sein („03/2028“ statt „0312075“). Zwei Wörter einer Zeile an derselben waagerechten Stelle: Das deutlich unsicherere entfällt.
- **Kleine Fotos (unter 1.100 Bildpunkten Kantenlänge)** werden bei schwacher Lesung als eine vergrößerte, aufbereitete Kachel nachgelesen (Kaufland-Dose: Text im Schatten).
- **„haltbar“ über dem Datum (AlpenGrün Mash).** Von der klein gedruckten Feldüberschrift „Mindestens haltbar bis:“ liest die Texterkennung teils nur „haltbar“. Steht das Wort allein auf einer Zeile und das Datum direkt darunter, zählt es als Haltbarkeitsangabe. Im Fließtext nicht.
- **Fremde Überschrift aus der Nachbarspalte (animonda Hundesnack).** „… Nebenerzeugnisse (90 %, 45 % Composition:“: Die englische Überschrift am Zeilenende gehört zur Nachbarspalte. Sie beendet den deutschen Abschnitt nicht mehr und bekommt den deutschen Folgetext nicht als Liste.
- **Analysewert ohne gelesene Einheit.** Ging bei „Protein/… 11 % • Fettgehalt/… 5 %“ das erste „%“ verloren, ordnete `germanAnalysisBlock` den Wert des Fettgehalts dem Protein zu („Protein 5 %“). Eine Zahl ohne Einheit mitten in den Namen beendet jetzt den Eintrag davor ohne Ergebnis; der nächste Wert gehört nur zu den Namen dahinter. In `mergeTiles` ersetzt eine sicherere Lesung die andere nicht, wenn sie ein Zeichen verliert („11“ statt „11%“).

Ergebnis je Etikett (Karten Gefunden / Wahrscheinlich / Kein OCR-Treffer, vorher → nachher):

| Etikett | Karten | Wesentliche Änderung |
| --- | --- | --- |
| animonda Schale | 7/3/1 → 8/3/0 | Zusatzstoffe mit Kennnummern „Gefunden“, volle Anschrift |
| IAMS (hochkant) | 7/2/2 → 8/2/1 | mehr Text (3.574 → 4.166 Zeichen), „Amazonia AG … 4142 Münchenstein“ richtig gelesen |
| Purina Gourmet (hochkant, 2 Fotos) | 8/1/2 → 8/1/2 | „Fettgehalt: 3,0 %“ und „IE/kg: Vitamin D3: 107“ richtig gelesen |
| Katzenmilch-Snack + Aufdruckfoto | 6/0/5 → 7/0/4 | „MHD 03/2028“ vom schrägen Aufdruck |
| AlpenGrün Mash | 6/1/4 → 8/0/3 | „Chargennummer 01102000040327“, „Mindestens haltbar bis: 04.09.2026“, Hersteller ohne Fremdtext, Analyse mit Werten |
| AGROBS Seniormineral | 9/0/2 → 9/0/2 | „(3a672a)“ statt „(336728)“ |
| Vitakraft | keine Karten | Futtermittelart nicht erkannt (mehrsprachig, hochkant), unverändert |
| proCani (3 Fotos) | 1/2/7 → 3/0/7 | Feuchte „77,0 %“ als Beleg |
| animonda Hundesnack | 3/0/8 → 6/4/1 | Zusammensetzung, Analyse, Inverkehrbringer, Verweis auf Aufdruck |
| Kaufland-Dose | 3/2/6 → 3/2/6 | 53 Zeichen mehr Text, Karten gleich |
| Lucky-Kitty | 8/1/1 → 7/2/1 | Partie nicht mehr „40233“ (Postleitzahl), sondern „Bezugsnummer der Partie:“ als Hinweis |

Offen aus dieser Runde:

- Nettomenge: „5kg“ (Mash), „Inhalt: 3 kg“ (Seniormineral, gelesen als „3 k“), „400 g“ (Kaufland), „500g“ (proCani), „e 200 g“ (Lucky-Kitty), „e100g“ (animonda) werden nicht belegt. Große, fette Schrift neben dem ℮-Zeichen liest das Modell schlecht. Für das Seniormineral verlangt die Abnahme in CLAUDE.md „3 kg“; das war auch vorher nicht erfüllt.
- proCani: Zusammensetzung („Zusammenseizung“ in sehr kleiner Schrift), Haltbarkeit „09.12.26“ und Hersteller bleiben ohne Treffer. Die Karte Futtermittelart zeigt einen Fließtextsatz mit „Heimtierfutter“ als Beleg, auf dem Etikett steht „Mischfuttermittel / straight feed“.
- Lucky-Kitty: Feuchtigkeit wird als „737%“ gelesen (Komma fehlt), die Karte bleibt „Unklar“.
- Kaufland-Dose: Hersteller und Nettomasse liegen im Schatten und bleiben ungelesen.
- Katzenmilch-Snack: „Zusatzstoffe/kg: Taurin 570 mg/kg.“ steht doppelt im Beleg.
- Laufzeit in Chromium: 4 bis 91 s je Etikett (vorher 3 bis 90 s). Die hochkant fotografierten Etiketten brauchen wegen der Drehversuche 52 bis 91 s. Auf dem iPhone nicht gemessen.

## Groß gedruckte Nettomenge (11.11.2026)

Ausgangsbefund: Bei keinem der elf Produkte aus der vorigen Runde wurde die Nettomenge belegt. Die Menge steht meist in sehr großer, fetter Schrift für sich („5kg“, „Inhalt: 3 kg“, „500g ℮“). In voller Auflösung übergeht die Texterkennung solche Zeichen oder liest Bruchstücke („3 k“). Verkleinert und als verstreuter Text gelesen werden sie lesbar, aber nicht bei jeder Größe.

Zusatzprüfung `readLargeAmount` in `webapp/js/app.js`, nur wenn der Prüftext keine Mengenangabe und keinen Mengenhinweis enthält (`Labeling.lacksNetAmount`):

1. Das Foto wird auf 800 und 1.100 Bildpunkte Kantenlänge verkleinert und als verstreuter Text gelesen, je unverändert und mit Beleuchtungsausgleich (vier Durchgänge, bei kleinen Fotos weniger).
2. Steht danach keine bestätigte Menge fest: `Ocr.largeGlyphRuns` sucht ohne Texterkennung Folgen von zwei bis acht großen Schriftzeichen (zusammenhängende Flächen, mindestens 1,8-fache Fließtexthöhe). Bis zu zehn solcher Stellen werden ausgeschnitten, auf 48 Bildpunkte Schrifthöhe gebracht und als einzelne Zeile gelesen (zwei Durchgänge).
3. `Labeling.largeAmountCandidate` wählt aus allen Durchgängen: Die Zeile besteht allein aus einer Menge (ein verlesenes ℮ davor oder dahinter ist erlaubt), ist mindestens 1,5-mal so hoch wie der Fließtext, und die Menge steht nicht schon im Prüftext (Fütterungstabelle, Rationsangabe). Bei mehreren großen Mengen muss eine klar die größte sein (Faktor 1,3). Zwei Lesarten an derselben Stelle („500 g“ und „5009 g“): Die häufigere zählt, bei Gleichstand keine.
4. Übernommen wird nur, was zwei Durchgänge gleich lesen oder einer sicher liest (ab 80). Das Ergebnis ist die Zeile „OCR-Kandidat Packungsmenge: …“. Die Karte bleibt „Wahrscheinlich“ mit dem Vermerk, die Angabe am Etikett zu bestätigen.

Ergebnis im Browser (Chromium, normaler Foto-Upload):

| Etikett | Vorher | Nachher |
| --- | --- | --- |
| AlpenGrün Mash | Kein OCR-Treffer | Wahrscheinlich: „5 kg“ |
| AGROBS Seniormineral | Kein OCR-Treffer | Wahrscheinlich: „3 kg“ |
| proCani (3 Fotos) | Kein OCR-Treffer | Wahrscheinlich: „500 g“ |
| animonda Schale | Wahrscheinlich (nur Überschrift „Nettomasse“) | unverändert; „100 g“ wird nur in einem Durchgang unsicher gelesen und deshalb nicht übernommen |
| Kaufland-Dose, Lucky-Kitty, Purina, Vitakraft | Kein OCR-Treffer bzw. nur Überschrift | unverändert |
| IAMS, Katzenmilch-Snack, animonda Hundesnack, Pavo, Carolina | Kein OCR-Treffer (auf den Fotos steht keine Nettomenge) | unverändert, kein Fehltreffer |

Grenzen:

- Für das Seniormineral verlangt die Abnahme in `CLAUDE.md` „3 kg“ als getrenntes Feld. Die Menge erscheint jetzt als Hinweis („Wahrscheinlich“), nicht als belegte Angabe: Die Überschrift „Inhalt:“ und die Menge werden in getrennten Durchgängen gelesen.
- Lucky-Kitty: „200g“ steht bereits im Prüftext hinter der Internetadresse („www.lucky-kitty.de EC 200g“, das ℮ als „EC“ gelesen) und gilt dort nicht als Mengenangabe. Die Zusatzprüfung schließt Mengen aus, die schon im Prüftext stehen.
- Purina („2 x 57 g ℮ = 114 g“ im gedrehten Foto), Vitakraft („e 40g“) und Kaufland („400 g“ im Schatten) werden in keinem Durchgang gelesen.
- Laufzeit: Die Zusatzprüfung kostet in Chromium je Foto ohne Mengenangabe etwa 5 bis 10 s, bei Produkten mit mehreren Fotos entsprechend mehr (proCani 40 → 57 s, Purina 91 → 112 s). Auf dem iPhone nicht gemessen.
- Tests: `tests/js/large-amount.test.mjs`.
