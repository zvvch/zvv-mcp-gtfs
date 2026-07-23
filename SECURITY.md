# Sicherheit

## Schwachstelle melden

Melde Sicherheitsprobleme **nicht** über ein öffentliches Issue.

Schreibe stattdessen an <marcel@marcelrapold.com>. Falls im Repository die private Meldung über [Security Advisories](https://github.com/zvvch/zvv-mcp-gtfs/security/advisories) aktiviert ist, funktioniert auch dieser Weg.

Du erhältst innerhalb von fünf Werktagen eine Rückmeldung. Bitte gib an:

- betroffene Version oder Commit
- Schritte zum Nachvollziehen
- mögliche Auswirkung

## Unterstützte Versionen

Sicherheitskorrekturen fliessen in den `main`-Zweig. Ältere Stände werden nicht gepflegt.

## Sicherheitsmodell

Das Projekt trennt bewusst zwei Zugriffsflächen:

| Endpunkt | Zugang | Begründung |
|---|---|---|
| `POST /mcp` | offen | Fahrplandaten sind offene Daten. Die Tools sind lesend, in ihren Ergebnismengen begrenzt und führen kein freies SQL aus. |
| `POST /mcp-admin` | Token oder OAuth | Führt beliebiges lesendes SQL aus. Das ist der Hebel für Rechenlast und liegt deshalb hinter der Anmeldung. |

### Bekannte Grenzen

> [!IMPORTANT]
> Diese Punkte sind bewusste Abwägungen, keine offenen Fehler.

**Rechenlast durch freies SQL.** Eine aufwendige Abfrage auf `/mcp-admin` kann den Node-Prozess blockieren. `better-sqlite3` arbeitet synchron und kann laufende Abfragen nicht abbrechen. Der Schutz ist die Zugangskontrolle, kein Zeitlimit.

**Stärke des PIN.** Der Zugang hängt an einem PIN, der zugleich das Signaturgeheimnis für Sitzungen und OAuth-Token ist. Ein kurzer PIN ist bequem, aber schwach. Abgesichert wird er durch eine Sperre von zehn Fehlversuchen je Adresse für fünfzehn Minuten und eine globale Bremse ab dreissig Fehlversuchen, die auch bei wechselnden Adressen greift. Für einen öffentlich erreichbaren Dienst empfiehlt sich trotzdem ein langer Zufallswert.

**PIN-Wechsel entwertet alle Token.** Sitzungen, Zugriffs- und Aktualisierungstoken sind mit dem PIN signiert. Änderst du ihn, verlieren alle ausgestellten Token sofort ihre Gültigkeit. Das ist beabsichtigt und der schnellste Weg, sämtliche Zugänge zu widerrufen.

**Kein Zeitlimit für Antwortgrössen.** Ergebnismengen sind auf 1000 Zeilen begrenzt, aber eine breite Zeile kann trotzdem gross werden.

### Was das Projekt schützt

- Die Datenbank wird ausschliesslich lesend geöffnet.
- `query_gtfs` lässt nur `SELECT` und `WITH … SELECT` zu; schreibende Schlüsselwörter werden abgewiesen, Zeichenketten-Literale dabei ausgeblendet.
- Ergebnismengen werden hart auf 1000 Zeilen begrenzt; der Grenzwert wird nie aus der Anfrage in die Abfrage übernommen.
- Sitzungscookies sind `HttpOnly`, `SameSite=Lax` und über HTTPS `Secure`.
- OAuth verlangt PKCE mit `S256`; Autorisierungscodes gelten sechzig Sekunden und genau einmal.
- Zugriffs- und Aktualisierungstoken tragen ein signiertes Typkennzeichen und lassen sich nicht gegeneinander austauschen.
- Der Dienstport ist an `127.0.0.1` gebunden; nach aussen führt ausschliesslich der Tunnel.
