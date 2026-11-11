/*
 * Deutsche Textteile aus mehrsprachigen Etiketten (Ocr.germanView).
 * Textgrundlage: Pavo WeightLift, Rückseite (Nutzerfoto, nur der gedruckte Wortlaut).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ocr = require("../../webapp/js/ocr.js");
const Labeling = require("../../webapp/js/labeling.js");

const COMPOSITION = [
  "Samenstelling / Komposition / Composition / Sammensætning / Composition / Composición / Sammansättning / Composizione / Kompozycja / Composição / Složení / Koostumus",
  "NL Luzerne, Rijstevoermeel, Lijnzaad, Biergist, Monocalciumfosfaat, Magnesiumoxide",
  "DE Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid",
  "EN Alfalfa, Rice bran, Linseed, Brewer's yeast, Monocalcium phosphate, Magnesium oxide",
  "DA Lucerne, Risklid, Hørfrø, ølgær, Monocalciumfosfat, Magnesiumoxid",
  "FR Luzerne, Son de riz, Graine de lin, Levure de bière, Phosphate monocalcique, Oxyde de magnésium",
  "CZ Alfalfa, Rýžové otruby, Lněné semeno, Pivovarské kvasnice, Monokalciumfosfát, Oxid hořečnatý",
].join("\n");

test("Zusammensetzung: nur die deutsche Zeile bleibt, die Überschrift ist die deutsche", () => {
  const view = Ocr.germanView(COMPOSITION);
  assert.equal(view, "Komposition: Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid");
  assert.ok(!/Rijstevoermeel|Alfalfa|Levure/.test(view));
});

test("Prüfung belegt die Zusammensetzung mit der deutschen Zeile, nicht mit der Mehrsprachen-Überschrift", () => {
  const feedType = { id: "complete_feed", nameDe: "Alleinfuttermittel", keywordsDe: ["Alleinfuttermittel"] };
  const rule = { id: "art17_003_complete", severity: "critical", patterns: [{
    patternValue: "Zusammensetzung", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] };
  const text = view => `Ergänzungsfuttermittel für Pferde.\n${view}`;
  const raw = Labeling.check(text(COMPOSITION), feedType, [rule]).ruleResults[0];
  const german = Labeling.check(text(Ocr.germanView(COMPOSITION)), feedType, [rule]).ruleResults[0];
  assert.equal(german.status, "found");
  assert.equal(german.matchedText, "Komposition: Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid");
  // Vorher zeigte die Karte die ganze Mehrsprachen-Überschrift.
  assert.match(raw.matchedText, /Samenstelling/);
});

test("Lagerungshinweis und Fütterungstabelle: das deutsche Segment wird gewählt", () => {
  const text = [
    "Bewaaradvies / Lagerungshinweis / Storage advise / Opbevarings anvisning / Conseils de conservation /",
    "Koel, droog en donker bewaren. Na gebruik de verpakking hersluiten. / Kühl, trocken und dunkel lagern. Die",
    "Lichaamsgewicht / Körpergewicht / Body weight",
    "Slank paard / Mageres Pferd / Lean horse",
    "Ondergewicht / Untergewicht / Underweight",
    "Ernstig ondergewicht / Starkes Untergewicht / Severe underweight",
  ].join("\n");
  assert.deepEqual(Ocr.germanView(text).split("\n"), [
    "Lagerungshinweis",
    "Kühl, trocken und dunkel lagern. Die",
    "Körpergewicht",
    "Mageres Pferd",
    "Untergewicht",
    "Starkes Untergewicht",
  ]);
});

test("Unklare Zeilen bleiben unverändert, einsprachiger Text wird nicht angefasst", () => {
  const unclear = "Alfalfa / Rice bran / Linseed";
  assert.equal(Ocr.germanView(unclear), unclear);
  const german = "Zusammensetzung: Hafer, Gerste, Weizen\nAnalytische Bestandteile: Rohprotein 12 %";
  assert.equal(Ocr.germanView(german), german);
  // Ohne deutsche „DE “-Zeile werden Zeilen mit Sprachkürzel nicht verworfen.
  const nl = "NL Luzerne, Lijnzaad, Biergist";
  assert.equal(Ocr.germanView(nl), nl);
});

test("Einsprachige Aufzählungen mit Schrägstrichen bleiben vollständig", () => {
  for (const line of ["Zusammensetzung: Getreide / Mais / Erbsen", "Mais / Erbsen / Futterkalk", "Fütterung: Heu / Stroh / Gras",
                      "Rohprotein / Rohfett / Futterbestandteile"]) {
    assert.equal(Ocr.germanView(line), line, line);
  }
  // Die Zusammensetzungskarte behält alle Zutaten und meldet keinen Mehrsprachen-Filter.
  const text = "Ergänzungsfuttermittel für Pferde.\nZusammensetzung: Getreide / Mais / Erbsen";
  assert.equal(Ocr.germanView(text), text);
});

test("Gemeinsame Zutatenliste nach einer mehrsprachigen Überschrift bleibt erhalten", () => {
  assert.equal(Ocr.germanView("Samenstelling / Zusammensetzung / Composition: Hafer, Gerste, Mais"),
    "Zusammensetzung: Hafer, Gerste, Mais");
  const feedType = { id: "complete_feed", nameDe: "Alleinfuttermittel", keywordsDe: ["Alleinfuttermittel"] };
  const rule = { id: "art17_003_complete", severity: "critical", patterns: [{
    patternValue: "Zusammensetzung", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] };
  const view = Ocr.germanView("Ergänzungsfuttermittel für Pferde.\nSamenstelling / Zusammensetzung / Composition: Hafer, Gerste, Mais");
  assert.equal(Labeling.check(view, feedType, [rule]).ruleResults[0].status, "found");
});

test("Anschrift mit Länderkennzeichen wird nicht als Sprachzeile verworfen", () => {
  const text = "DE Hafer, Gerste, Mais\nMusterfutter NV\nBeispielstraat 41\nNL 5823 AC Musterort";
  assert.equal(Ocr.germanView(text), text);
  // Eine echte Sprachzeile entfällt weiterhin.
  assert.equal(Ocr.germanView("NL Haver, Gerst, Mais\nDE Hafer, Gerste, Mais"), "DE Hafer, Gerste, Mais");
});

// ── Analytische Bestandteile in mehrsprachiger Schreibweise (animonda „Vom Feinsten“) ──
const ANALYSIS_MULTI = [
  "== Analytische Bestandteile/Constituants analy-",
  "ZZ tiques/Analytische bestanddelen/Componenti",
  "= analitici: Protein/Prot&ine/Eiwit/Proteine 11 % Fett-",
  "=> gehalt/Teneur en mati&res grasses/Vetgehalte/Tenore",
  "= In materia grassa 5 % + Rohfaser/Cellulose brute/Ruwe",
  "ZZ Celstof/Cellulosa grezza 0,3 % » Rohasche/Cendres",
  "grezze 1,6 % « Feuchtigkeit/",
  "ZZ Humidit&/Vocht/Umidita 81 % + Taurin/Taurine/",
  "Taurina 600 mg/kg.",
  "= Emnährungsphysiologische Zusatzstoffe/",
  "= Additifs nutritionnels/Nutritionele toe-",
  "(kg): 200 JE 3a671, 1 mg 3b406",
].join("\n");

test("Analytische Bestandteile: aus dem mehrsprachigen Fließtext wird eine deutsche Zeile mit denselben Werten", () => {
  const view = Ocr.germanView(ANALYSIS_MULTI).split("\n");
  assert.equal(view[0], "Analytische Bestandteile: Protein 11 %, Fettgehalt 5 %, Rohfaser 0,3 %, Rohasche 1,6 %, Feuchtigkeit 81 %, Taurin 600 mg/kg.");
  // Der folgende Abschnitt (Zusatzstoffe) bleibt außerhalb des Blocks.
  assert.ok(view.some(l => /Zusatzstoffe/.test(l)));
  assert.ok(view.some(l => /3a671/.test(l)));
  assert.ok(!view.some(l => /Eiwit|Teneur|Vetgehalte|Cendres/.test(l)));
});

test("Analytische Bestandteile: ein Eintrag ohne gelesenen Wert entfällt, mit weniger als zwei Einträgen bleibt der Text", () => {
  const withoutTaurin = ANALYSIS_MULTI.replace("Taurina 600 mg/kg.\n", "");
  assert.match(Ocr.germanView(withoutTaurin).split("\n")[0], /Feuchtigkeit 81 %\.$/);
  const one = ["Analytische Bestandteile/Constituants analytiques: Protein/Protéine/Eiwit 11 %", "Mehr Text folgt."].join("\n");
  assert.equal(Ocr.germanView(one), one);
});

test("Analytische Bestandteile: einsprachiger Abschnitt und andere Schreibweisen bleiben unverändert", () => {
  const german = "Analytische Bestandteile: Rohprotein 24 %, Rohfett 12 %, Rohfaser 3 %, Rohasche 7 %";
  assert.equal(Ocr.germanView(german), german);
  // Mit Schrägstrichen, aber ohne Hinweis auf andere Sprachen: kein Umbau
  const slashed = "Analytische Bestandteile/Werte: Rohprotein/Fett 24 %, Rohfaser/Asche 3 %";
  assert.equal(Ocr.germanView(slashed), slashed);
});

test("Analytische Bestandteile: die Prüfung belegt Analyse und Feuchte mit den deutschen Werten", () => {
  const feedType = { id: "complete_feed", nameDe: "Alleinfuttermittel", keywordsDe: ["Alleinfuttermittel"] };
  const rules = [
    { id: "art17_004_complete", severity: "critical", patterns: [{ patternValue: "Analytische Bestandteile", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] },
    { id: "art15_005", severity: "warning", patterns: [{ patternValue: "Feuchtigkeit", patternType: "keyword", patternLanguage: "de", confidenceWeight: 0.7 }] },
  ];
  const text = `Alleinfuttermittel für ausgewachsene Katzen\n${ANALYSIS_MULTI}`;
  const view = Labeling.check(Ocr.germanView(text), feedType, rules).ruleResults;
  assert.equal(view[0].status, "found");
  assert.match(view[0].matchedText, /Protein 11 %, Fettgehalt 5 %/);
  assert.equal(view[1].status, "found");
  assert.match(view[1].matchedText, /Feuchtigkeit 81 %/);
});

test("germanView: nach dem sprachweisen Block endet der Abschnitt vor der nächsten Überschrift", () => {
  // Die mehrsprachige Überschrift der Lagerungshinweise ist nur bruchstückhaft gelesen und nicht als deutsch erkennbar.
  const text = [
    "Samenstelling / Komposition / Composition /",
    "NL Luzerne, Rijstevoermeel, Lijnzaad, Biergist",
    "DE Luzerne, Reiskleie, Leinsaat, Bierhefe, Monocalciumphosphat, Magnesiumoxid",
    "EN Alfalfa, Rice bran, Linseed, Brewer's yeast",
    "CZ Alfalfa, Ryzove otruby, Lnene semeno",
    "ation /",
    "advise / Opbevarings anvisning / Conseils de",
    "Koel, droog en donker bewaren.",
  ].join("\n");
  const view = Ocr.germanView(text).split("\n");
  const list = view.findIndex(line => line.includes("Bierhefe"));
  assert.ok(list >= 0);
  assert.equal(view[list + 1], "", "Leerzeile trennt die Liste vom folgenden Abschnitt");
  assert.ok(view.includes("ation /"), "der folgende Text bleibt erhalten");
});

test("germanView: die deutsche Zeile am Blockende bleibt mit ihrer Fortsetzung verbunden", () => {
  const text = ["Zusammensetzung", "EN Oats, barley, linseed", "DE Hafer, Gerste, Leinsaat,", "Bierhefe, Magnesiumoxid"].join("\n");
  const view = Ocr.germanView(text).split("\n");
  assert.ok(!view.includes(""), "keine Leerzeile zwischen deutscher Liste und ihrer Fortsetzung");
});

test("germanView: mehrsprachige Überschrift der Zusatzstoffe ohne Leerzeichen um die Schrägstriche", () => {
  const text = [
    "Taurina 600 mg/kg.",
    "Ernährungsphysiologische Zusatzstoffe/",
    "Additifs nutritionnels/Nutritionele toevoegingsmiddelen/Additivi nutrizionali",
    "(/kg): 200 IE 3a671, 1 mg 3b406, 11,4 mg",
    "3b605, 1,4 mg 3b503, 0,1 mg 3b202.",
    "Art.-No. 83205",
  ].join("\n");
  const view = Ocr.germanView(text).split("\n");
  assert.ok(view.includes("Ernährungsphysiologische Zusatzstoffe (/kg): 200 IE 3a671, 1 mg 3b406, 11,4 mg"), view.join(" | "));
  assert.ok(view.includes("3b605, 1,4 mg 3b503, 0,1 mg 3b202."), "die Liste bleibt unverändert");
  assert.ok(!view.some(line => /Additifs|toevoeging|Additivi/.test(line)), "Übersetzungen der Überschrift entfallen");
});

test("germanView: einsprachige Zusatzstoffzeilen mit Schrägstrich bleiben unverändert", () => {
  for (const line of ["Zusatzstoffe/kg: Vitamin A 10.000 IE, Vitamin D3 1.000 IE", "Zusatzstoffe / kg: 3b605 Zink 50 mg",
                      "Ernährungsphysiologische Zusatzstoffe/kg:", "Zusatzstoffe/Additives 12 mg: Zink"]) {
    assert.equal(Ocr.germanView(line), line);
  }
});

test("germanView: Analysewert ohne gelesene Einheit wird nicht dem nächsten Namen zugeordnet", () => {
  const text = [
    "Analytische Bestandteile/Constituants analytiques/Analytische bestanddelen/Componenti",
    "analitici: Protein/Protéine/Eiwit/Proteine 11 Fettgehalt/Teneur en matières grasses/Vetgehalte/Tenore",
    "in materia grassa 5 % Rohfaser/Cellulose brute/Ruwe",
    "celstof/Cellulosa grezza 0,3 % Rohasche/Cendres",
    "brutes/Ruwe as/Ceneri grezze 1,6 %.",
  ].join("\n");
  const view = Ocr.germanView(text);
  assert.match(view, /Fettgehalt 5 %, Rohfaser 0,3 %, Rohasche 1,6 %/);
  assert.doesNotMatch(view, /Protein 5 %/, "der Wert des Fettgehalts gehört nicht zum Protein");
  assert.doesNotMatch(view, /Protein 11/, "ohne Einheit kein Eintrag");
});

test("germanView: Angaben direkt nach dem mehrsprachigen Analyseblock bleiben erhalten", () => {
  const text = [
    "Analytische Bestandteile/Constituants analytiques/Analytische bestanddelen:",
    "Protein/Protéine/Eiwit 11 % Fettgehalt/Teneur en matières grasses/Vetgehalte 5 %",
    "Nettomasse: 400 g",
    "Mindestens haltbar bis: 03/2028",
    "Charge: ABC123",
  ].join("\n");
  const view = Ocr.germanView(text).split("\n");
  assert.equal(view[0], "Analytische Bestandteile: Protein 11 %, Fettgehalt 5 %.");
  assert.deepEqual(view.slice(1), ["Nettomasse: 400 g", "Mindestens haltbar bis: 03/2028", "Charge: ABC123"]);
  // Auch eine Folgezeile ohne bekannte Überschrift und ohne Analysewert bleibt stehen.
  const other = Ocr.germanView(text.replace("Nettomasse: 400 g", "Bitte stets frisches Wasser bereitstellen.")).split("\n");
  assert.ok(other.includes("Bitte stets frisches Wasser bereitstellen."), other.join(" | "));
  // Eine Zusammensetzung mit Prozentwert direkt danach gehört nicht zum Block.
  const composition = Ocr.germanView(text.replace("Nettomasse: 400 g", "Zusammensetzung: 65 % Fleisch, 4 % Reis")).split("\n");
  assert.ok(composition.includes("Zusammensetzung: 65 % Fleisch, 4 % Reis"), composition.join(" | "));
  assert.doesNotMatch(composition[0], /Fleisch|Reis/);
});

test("germanView: Analyseblock mit abweichender Bezugsbasis bleibt unverändert", () => {
  // Der Hinweis auf die Bezugsbasis darf nicht verloren gehen: Spätere Umrechnungen hängen daran.
  for (const text of [
    "Analytische Bestandteile/Constituants analytiques (bezogen auf Trockenmasse): Phosphor/Phosphore 0,4 % Rohprotein/Protéine/Eiwit 24 % Feuchtigkeit/Humidité/Vocht 8 %",
    "Analytische Bestandteile/Constituants analytiques/Analytische bestanddelen:\nPhosphor/Phosphore/Fosfor 0,4 % TS Rohprotein/Protéine/Eiwit 24 % TS",
    "Analytische Bestandteile/Constituants analytiques/Analytische bestanddelen in der Trockensubstanz:\nPhosphor/Phosphore/Fosfor 0,4 % Rohprotein/Protéine/Eiwit 24 %",
  ]) {
    assert.equal(Ocr.germanView(text), text);
  }
});

test("germanView: Analyseangaben außerhalb der Namensliste bleiben im umgeschriebenen Block", () => {
  const text = "Analytische Bestandteile/Constituants analytiques: Protein/Protéine 24 % Fettgehalt/Teneur en matières grasses 5 % Chlorid/Chloride 0,15 % Schwefel/Sulphur 0,2 % Feuchtegehalt/Humidité 8 %";
  assert.equal(Ocr.germanView(text),
    "Analytische Bestandteile: Protein 24 %, Fettgehalt 5 %, Chlorid 0,15 %, Schwefel 0,2 %, Feuchtegehalt 8 %.");
  // Lässt sich ein Eintrag nicht benennen (kein Wort vor dem Wert), bleibt der ganze Block unverändert.
  const broken = "Analytische Bestandteile/Constituants analytiques: Protein/Protéine 24 % Fettgehalt/Teneur en matières grasses 5 % •/ 0,15 %";
  assert.equal(Ocr.germanView(broken), broken);
});
