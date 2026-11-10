# Zusatzstoff-Grenzwerte: Prüfnachweise und Freigabesperre

Stand: 10.11.2026. Dieses Dokument ist eine **technische Prüfanweisung**, keine vollständige rechtliche Validierung.

## Warum dieser Prüfpfad erforderlich ist

Die BVL-PDF-Extraktion speichert Grenzwerte bisher in generischen Feldern wie `min_mg_kg` / `max_mg_kg`, obwohl der Ursprungsakt Werte in Aktivitätseinheiten oder Keimzahlen enthalten kann. `webapp/js/eval.js` hat bei fehlender Einheit `mg/kg` lediglich angenommen. Solche Datensätze dürfen **nicht** als bestanden/nicht bestanden bewertet werden, auch dann nicht, wenn die Eingabe ebenfalls `mg/kg` lautet.

Dieser Branch sperrt diese scheinbar sicheren Ergebnisse und liefert ein **nicht veränderndes** Audit:

```bash
python3 Data/audit_limit_units.py Data/zusatzstoffe.json --output /tmp/feedlabelcheck-unit-audit.json
python3 -m unittest discover -s tests/python -p 'test_audit_limit_units.py'
node --test tests/js/eval-units.test.mjs
```

Mit `--strict` liefert das Audit Exitcode 1, sobald ein Grenzwertdatensatz offene Nachweise aufweist. Das ist **noch kein produktiver Datenpipeline-Blocker**, da zuerst die bestehenden Datensätze fachlich korrigiert werden müssen.

## Nachweise vor einer echten Grenzwertfreigabe

Jede maschinell bewertete Zeile benötigt eine explizite, geprüfte **Messgröße und Einheit** (z. B. mg Wirkstoff/kg, FYT/kg, FTU/kg oder KBE/kg), ein für die gewählte Tierkategorie gültiges **Mindest-/Höchstwert-Kennzeichen**, den **Bezugsfuttertyp**, den **Feuchtebezug**, die Identität des maßgeblichen Stoffes, den maßgeblichen **Zulassungsakt inkl. Änderungen**, sowie ein **Gültigkeitsintervall** und die konkreten sonstigen Verwendungsbedingungen. Ein erfolgreicher technischer Zahlenvergleich ist keine vollständige Zulassungs- oder Etikettenprüfung.

`reference_moisture_percent` und `limit_basis` sind im Audit aktuell Nachweis-/Metadatenfelder, noch **kein** allgemein eingeführtes Produktions-Datenformat. Ihre bloße Anwesenheit ist nicht gleichbedeutend mit juristischer Quellenverifikation. Ein aussagekräftiges Herkunfts- und Review-Verfahren ist vor produktiven positiven Bescheiden erforderlich.

## Manuell zu validierende Ausgangsfälle

| Kennnummer | Primärquelle | Maßgeblicher Befund | Fehlerklasse |
| --- | --- | --- | --- |
| `4a48` | https://eur-lex.europa.eu/eli/reg_impl/2024/2177/oj/deu | 6-Phytase: `FYT/kg` (nicht mg/kg, nicht automatisch FTU/kg); u. a. 200 FYT oder 1000 FYT, abhängig von Tierart. **Aktuelle Änderungsfassung prüfen.** | falsche Einheit / Tierartzeile |
| `4b1823i` | https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32026R0092 | Bacillus velezensis: **Mindestgehalt** `1 × 10⁸ KBE/kg` Alleinfuttermittel mit 12 % Feuchte, nicht Höchstgehalt 1 mg/kg | Einheit + Zehnerpotenz + Min/Max-Spalte |

**Nicht** per Kennnummer eine Zahl für alle Tierarten überschreiben: Zulassungsakte enthalten mehrere Zieltierspezies und ggf. unterschiedliche Grenzen. Die beiden Einträge werden zur Review markiert, **nicht automatisch korrigiert**. Die Konversion zwischen KBE, FYT/FTU und Masse ist unzulässig, sofern kein validierter stoffspezifischer Faktor samt Methodenbezug vorliegt.

## Weitere technische Folgearbeiten

1. PDF-Parser: Einheit aus dem Tabellenkopf pro Seite/Tabelle erfassen, zusammen mit dem Referenzfutter und dem Feuchtebezug. Wiederholte Tabellenüberschriften und Seitenumbrüche berücksichtigen.
2. Werteparser: Exponenten (z. B. `1 × 10⁸`) exakt erhalten und `min`/ `max` nicht vertauschen; mehrdeutige Zeilen in Quarantäne.
3. Vor Veröffentlichung: originale Rechtsakte, Änderungen und Tierartbedingungen per Datensatz referenzieren und durch fachliche Review freigeben. Kein heuristisches Autovervollständigen.
4. Danach erst einen versionierten, transaktional auslieferbaren Datensatz erzeugen. Aktuelle unsichere Einträge dürfen im Browser sichtbar sein, aber nicht als rechtlich „konform“ oder „nicht konform“ ausgewertet werden.
5. Regressionsprüfung gegen weitere Einheiten und Grenzfälle aus dem aktuellen Datenbestand; PWA und Swift-/Python-Clients auf gemeinsame Datenverträge abstimmen.

## Grenzen dieses Branches

- Ändert **keine** Zulassungsdaten und veröffentlicht **keine** Fachdaten.
- Stellt keine automatische Volltextprüfung oder Zulassungsvalidierung her.
- Erzeugt **kein** vollständiges rechtliches Gesamturteil.
- Ändert PR #49 und das laufende PWA-Redesign nicht.
