# Mitwirken

Danke für dein Interesse. Dieses Dokument beschreibt, wie du eine Änderung einbringst.

## Entwicklungsumgebung einrichten

Du brauchst Node.js 20 oder neuer. `better-sqlite3` wird nativ kompiliert und benötigt eine Build-Umgebung (unter Windows die Build Tools für Visual Studio, unter Linux `build-essential` und `python3`).

```bash
git clone https://github.com/zvvch/zvv-mcp-gtfs.git
cd zvv-mcp-gtfs
npm install
npm test
```

Die Tests laufen gegen eine kleine Beispieldatenbank aus `test/fixtures/` und brauchen **keine** echten Fahrplandaten. Sie sind in wenigen Sekunden durch.

Für Arbeiten an den Abfragen selbst brauchst du den vollen Datensatz:

```bash
npm run build   # lädt den Feed und importiert ihn, 10 bis 15 Minuten
npm start
```

## Änderung einbringen

1. Zweig von `main` abzweigen.
2. Änderung umsetzen, Tests ergänzen.
3. `npm test` muss grün sein.
4. Pull Request öffnen und beschreiben, **warum** die Änderung nötig ist.

## Erwartungen an Beiträge

**Tests gehören dazu.** Jede Verhaltensänderung braucht einen Test, der ohne sie fehlschlägt. Reine Attrappen-Tests, die eine Prüfung im Test nachbauen statt den echten Code aufzurufen, werden abgelehnt — davon gab es hier schon welche, und sie haben einen Fehler monatelang verdeckt.

**Belege statt Vermutungen.** Behauptungen über Laufzeit, Datenmengen oder Verhalten des Feeds gehören gemessen. Die Zahlen in [ARCHITECTURE.md](docs/ARCHITECTURE.md) stammen alle aus Messungen gegen den Produktivbestand.

**Fehler laut melden, nicht leer antworten.** Findet eine Abfrage nichts, weil die Eingabe unbekannt ist, muss das als Fehler zurückkommen. Ein leeres Ergebnis sieht für ein Sprachmodell aus wie „es gibt nichts" — dieser Unterschied hat hier bereits einen Fehler verschleiert.

## Code-Stil

Der Bestand nutzt CommonJS und keinen Transpiler. Halte dich an den umgebenden Stil.

Kommentare erklären das **Warum**, nicht das Was. Besonders wertvoll sind Kommentare an Stellen, die ohne Erklärung falsch aussehen — etwa warum die Verbindungssuche in Stufe zwei nur nach `trip_id` filtert (weil SQLite sonst den falschen Index wählt und die Abfrage zwanzigmal länger dauert).

## Commit-Nachrichten

Erste Zeile als knappe Zusammenfassung im Präsens, danach eine Leerzeile und der Rumpf. Beschreibe im Rumpf, was das Problem war und warum die Lösung so aussieht. Verweise auf Messwerte, wenn es um Laufzeit geht.

## Dokumentation

Änderst du Verhalten, aktualisiere die Dokumentation im selben Pull Request:

| Was | Wohin |
|---|---|
| Neues Tool, neuer Parameter, neuer Endpunkt | [README.md](README.md) |
| Entwurfsentscheidung, Eigenheit der Daten | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Betrieb, Fehlersuche | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| Jede sichtbare Änderung | [CHANGELOG.md](CHANGELOG.md) |

Konkrete Zahlen im Fliesstext veralten schnell — der Feed erscheint alle paar Wochen neu. Schreibe Grössenordnungen, wo die genaue Zahl nichts zur Aussage beiträgt.

## Sicherheitsprobleme

Nicht als Issue melden, sondern nach [SECURITY.md](SECURITY.md) verfahren.
