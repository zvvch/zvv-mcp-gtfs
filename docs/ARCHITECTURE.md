# Architektur und Entwurfsentscheidungen

Dieses Dokument hält fest, **warum** Dinge so gebaut sind. Vieles davon ist teuer erarbeitet — mehrere Punkte sind Fehler, die erst im Betrieb gegen echte Daten sichtbar wurden.

- [Datenfluss](#datenfluss)
- [Eigenheiten der Schweizer GTFS-Daten](#eigenheiten-der-schweizer-gtfs-daten)
- [Verbindungssuche](#verbindungssuche)
- [Warum zwei Endpunkte](#warum-zwei-endpunkte)
- [OAuth zustandslos](#oauth-zustandslos)
- [Atomarer Fahrplanwechsel](#atomarer-fahrplanwechsel)
- [Leistung](#leistung)

---

## Datenfluss

```mermaid
flowchart TD
    OTD["opentransportdata.swiss<br/>GTFS-ZIP, ~190 MB"] -->|download-gtfs.js| CSV["CSV-Dateien<br/>~2.9 GB entpackt"]
    CSV -->|import-gtfs.js| DB[("SQLite<br/>41 Mio. Zeilen, ~5.3 GB")]
    DB --> PUB["POST /mcp<br/>7 Tools, anonym"]
    DB --> ADM["POST /mcp-admin<br/>+ query_gtfs, geschützt"]
    DB --> UI["Web-UI<br/>GTFS Explorer"]
    PUB --> CF["cloudflared"]
    ADM --> CF
    UI --> CF
    CF --> NET["gtfs.zvv.dev"]
```

SQLite wurde gewählt, weil der Datensatz **statisch** ist: er ändert sich alle paar Wochen einmal, wird nie geschrieben und passt auf eine Platte. Die Datenbank wird readonly geöffnet — schon das schliesst eine ganze Fehlerklasse aus.

### Der Import im Detail

Die Herausforderung ist die Grösse: `stop_times.txt` allein ist 1.7 GB mit 28 Mio. Zeilen. Die Datei wird deshalb **gestreamt**, nie vollständig geladen, und in Blöcken von 10'000 Zeilen je Transaktion geschrieben.

```mermaid
sequenceDiagram
    participant F as CSV-Datei<br/>(1.7 GB)
    participant R as readline<br/>Zeilenstrom
    participant P as parseCSVLine
    participant B as Stapel<br/>(10'000 Zeilen)
    participant D as SQLite

    Note over D: PRAGMA synchronous=OFF<br/>cache_size=64 MB
    F->>R: createReadStream
    R->>P: erste Zeile = Kopfzeile
    P->>D: CREATE TABLE<br/>(nur vorhandene Spalten)
    P->>D: INSERT vorbereiten

    loop je Datenzeile
        R->>P: Zeile
        P->>B: Feldwerte
        alt Stapel voll
            B->>D: db.transaction(10'000 INSERT)
            Note right of D: ein Commit statt<br/>10'000 einzelne
        end
    end

    B->>D: Rest-Stapel
    D->>D: CREATE INDEX (erst jetzt)
    Note over D: PRAGMA synchronous=NORMAL
```

Drei Entscheidungen tragen die Laufzeit von rund dreieinhalb Minuten für 41 Mio. Zeilen:

| Entscheidung | Wirkung |
|---|---|
| Stapel von 10'000 Zeilen je Transaktion | ein Commit statt zehntausender — der grösste Hebel |
| Indexe **nach** dem Import | jeder Insert müsste sonst alle Indexe mitpflegen |
| `synchronous = OFF` während des Imports | keine Synchronisierung auf die Platte je Commit |

`synchronous = OFF` ist vertretbar, weil ein Absturz während des Imports ohnehin einen Neuaufbau nach sich zieht — es geht nichts verloren, was nicht ersetzbar wäre. Danach wird auf `NORMAL` zurückgestellt.

Der CSV-Parser ist selbst geschrieben statt einer Bibliothek entnommen. Er behandelt Anführungszeichen, verdoppelte Anführungszeichen als Escape und leere Felder — mehr braucht GTFS nicht, und im heissen Pfad zählt jede vermiedene Indirektion.

### Anfrage und Anmeldung

```mermaid
flowchart TD
    REQ["Anfrage"] --> WHICH{"Welcher<br/>Endpunkt?"}

    WHICH -->|"POST /mcp"| PUB["7 lesende Tools"]
    PUB --> DB[("SQLite")]

    WHICH -->|"POST /mcp-admin"| AUTH{"Anmeldung<br/>gültig?"}
    WHICH -->|"/api/*"| AUTH

    AUTH -->|"Bearer = PIN"| OK["Zugriff"]
    AUTH -->|"Bearer = OAuth-Token"| AUD{"Audience<br/>passt?"}
    AUTH -->|"Sitzungscookie"| OK
    AUTH -->|"nichts davon"| FAIL["401 + Verweis auf<br/>Ressourcen-Metadaten"]

    AUD -->|"ja"| OK
    AUD -->|"nein"| INV["401 invalid_token"]

    OK --> DB
    FAIL --> LOCK{"10 Fehlversuche<br/>erreicht?"}
    INV --> LOCK
    LOCK -->|"ja"| BAN["429 · IP 15 min gesperrt"]
    LOCK -->|"nein"| END["Antwort"]
```

Der öffentliche Pfad kennt keine Abzweigung — er führt direkt zur Datenbank. Alles, was Anmeldung verlangt, teilt sich denselben Fehlversuchszähler; sonst wäre jeder neue Anmeldeweg ein Schlupfloch am Schutz vorbei.

---

## Eigenheiten der Schweizer GTFS-Daten

Der Feed weicht an mehreren Stellen von dem ab, was GTFS-Tutorials nahelegen. Jede dieser Abweichungen hat hier einmal zu falschen oder leeren Ergebnissen geführt.

### SLOID statt DIDOK

Seit dem Fahrplan **2026-07** nutzen die Schweizer Haltestellen SLOID-Kennungen. Die bekannten DIDOK-Nummern kommen im Feed **überhaupt nicht mehr vor**:

```
früher:  8503000              (Zürich HB)
heute:   ch:1:sloid:3000
```

Wer die alte Nummer verwendet, bekam anfangs **stillschweigend null Abfahrten** — das schlimmste Fehlerbild, weil es wie ein leerer Fahrplan aussieht statt wie eine falsche ID.

Die Umrechnung: `85` entfernen, führende Nullen entfernen, `ch:1:sloid:` davorsetzen. Bestätigt an Zürich HB, Stadelhofen, Basel SBB, Bern, Luzern, Lausanne und St. Gallen — 7 von 7.

> **Sackgasse, die dokumentiert bleiben soll:** Ein erster Versuch stützte sich auf die Spalte `original_stop_id`, weil sie bei einer *ausländischen* Haltestelle die alte Nummer trug. Falsch: für die 98'244 Schweizer Stops dupliziert sie nur die SLOID. Der Fix war wirkungslos und fiel erst beim Test gegen die fertige Datenbank auf. Die Spalte hilft weiterhin bei den 5'304 ausländischen Haltestellen, die nie eine SLOID hatten.

Wichtiger als die Umrechnung ist die zweite Lehre: **eine unbekannte ID muss als Fehler gemeldet werden, nicht als leeres Ergebnis.** Genau dieses stille Nichts hatte den Fehler wochenlang verdeckt.

So läuft die Auflösung heute — eine Eingabe kann eine ID, eine alte Nummer oder ein Name sein:

```mermaid
flowchart TD
    IN["Eingabe<br/>ID · alte Nummer · Name"] --> ID{"Trifft eine<br/>stop_id?"}
    ID -->|"ja"| EDGES["Haltekanten sammeln"]
    ID -->|"nein"| DIDOK{"Muster 85xxxxx?"}

    DIDOK -->|"ja"| CONV["85 weg, Nullen weg<br/>8503000 → ch:1:sloid:3000"]
    CONV --> ID
    DIDOK -->|"nein"| NAME["Namenssuche<br/>wortweise, ohne Diakritika"]

    NAME --> HIT{"Treffer?"}
    HIT -->|"nein"| ERR["Fehler melden<br/>NICHT leer antworten"]
    HIT -->|"ja"| BEST["besten Namen wählen<br/>Vergleich ohne Satzzeichen"]
    BEST --> EDGES

    EDGES --> E1["Station selbst"]
    EDGES --> E2["Elternstation<br/>Parent…"]
    EDGES --> E3["Gleise und Kanten<br/>…:3:4"]
    EDGES --> E4["Namensvarianten<br/>Name, Bahnhof"]
```

Der letzte Zweig ist der unscheinbarste und zugleich wichtigste: Bahn und Tram haben am selben Ort getrennte Haltestellen ohne gemeinsame Elternstation. Ohne ihn findet man von Bellevue aus keine Tram nach Stadelhofen.

### Erweiterte Linientypen (HVT)

Der Feed verwendet ausschliesslich die **erweiterten** `route_type`-Werte (100–1599), nie die klassischen 0–7:

```
route_type = 2   (Bahn, klassisch)  →  0 Treffer
route_type = 700 (Bus, HVT)         →  rund 3400 Linien
```

`get_routes` bildet klassische Werte deshalb auf die HVT-Bereiche ab. Vorher gab jede Anfrage nach „alle Bahnlinien" null Ergebnisse, obwohl Beschreibung und Dokumentation es versprachen.

### Nachtkurse jenseits von 24:00

GTFS kodiert Fahrten nach Mitternacht im Service-Tag **davor**, mit Zeiten über 24 Uhr:

```
00:30 heute  ≙  24:30:00 im Service-Tag von gestern
```

Der Feed enthält **rund 1.3 Mio. solcher Haltezeiten**; an einem Knoten wie Zürich HB sind es mehrere hundert je Betriebstag.

```mermaid
flowchart LR
    subgraph GESTERN["Betriebstag gestern"]
        G1["22:00"] --> G2["23:30"] --> G3["24:30<br/>= heute 00:30"] --> G4["25:10<br/>= heute 01:10"]
    end
    subgraph HEUTE["Betriebstag heute"]
        H1["00:15"] --> H2["05:30"] --> H3["12:00"]
    end
    Q["Anfrage:<br/>heute ab 00:15"] -.->|"Zweig 1<br/>ab 00:15:00"| HEUTE
    Q -.->|"Zweig 2<br/>ab 24:15:00"| GESTERN
```

`get_stop_departures` fragt deshalb **zwei Betriebstage** ab: den heutigen ab der Startzeit und den gestrigen ab Startzeit plus 24 Stunden. Die Ergebnisse des zweiten Zweigs werden auf die Wanduhr zurückgerechnet (`24:30` wird zu `00:30`) und mit dem ersten nach tatsächlicher Uhrzeit zusammensortiert.

Ohne den zweiten Zweig fehlt um 00:15 der komplette Nachtverkehr — und zwar unsichtbar, weil die Antwort nicht leer ist, sondern nur unvollständig.

> Alle konkreten Zahlen in diesem Dokument sind Momentaufnahmen. Der Feed wird alle paar Wochen neu veröffentlicht, die Grössenordnungen bleiben aber stabil. Den aktuellen Stand liefert `get_dataset_info` oder `GET /health`.

### Zeitzone

Das Zieldatum wird in **Europe/Zurich** bestimmt, nicht in UTC. Sonst zeigte der Server zwischen Mitternacht und ~02:00 den Fahrplan des Vortags: das Datum kam aus UTC, die Uhrzeit aus Schweizer Zeit — zwei Betriebstage in einer Abfrage.

### Getrennte Stops für dasselbe Bauwerk

Bahn und Tram haben am selben Ort **verschiedene Haltestellen ohne gemeinsame Elternstation**:

```
Zürich Stadelhofen            ch:1:sloid:3003      (Bahnhof)
Zürich Stadelhofen, Bahnhof   ch:1:sloid:…         (Tramhaltestelle)
```

Eine Auflösung über `parent_station` allein findet von Bellevue aus **keine Tram** nach Stadelhofen. Die Ortsauflösung berücksichtigt deshalb den Namen und seine Untervarianten (`Name` plus `Name, …`).

### Namenssuche

Drei Dinge, die ein Sprachmodell sonst scheitern lassen:

| Eingabe | Problem | Lösung |
|---|---|---|
| `zurich` | Feed schreibt `Zürich` | normalisierte Spalte `stop_name_norm` ohne Diakritika |
| `zuerich` | deutsche Umschreibung | Rückfall `ue→u`, **nur bei null Treffern** |
| `zurich bellevue` | offiziell `Zürich, Bellevue` | wortweise Suche statt durchgehendem Substring |

Der Rückfall greift bewusst erst bei null Treffern — sonst würde `Neuenburg` zu `Neunburg` verstümmelt und fände nichts mehr.

Die Sortierung vergleicht **ohne Satzzeichen**, damit die Tramhaltestelle `Zürich, Bellevue` vor der Schiffstation `Zürich Bellevue (See)` liegt. Das muss **nach** dem SQL-`LIMIT` geschehen — mit `LIMIT 1` kam sonst die falsche durch.

---

## Verbindungssuche

`get_connections` findet direkte Verbindungen. Der Weg dahin war teuer:

| Ansatz | Laufzeit | Warum |
|---|---|---|
| Self-Join über `stop_times` | **20 s** | 28 Mio. Zeilen mit sich selbst verbunden |
| Zweistufig, Ziel per `stop_id IN (…)` | **19 s** | SQLite wählt den Stop-Index und scannt Millionen Zeilen |
| Zweistufig, Filter in JS | **0.2–1.8 s** | Stufe 2 filtert nur nach `trip_id` → Trip-Index |

Der entscheidende Punkt ist die dritte Zeile: Stufe 2 filtert **ausschliesslich nach `trip_id`**, damit der Abfrageplaner sicher den Trip-Index nimmt. Die Zielhalte werden anschliessend in JavaScript gefiltert. Ein zusätzliches `stop_id IN (…)` in der SQL kippt den Plan und kostet Faktor 20.

Ebenso wichtig ist die Deckelung der Ortsauflösung: `Bern` als Präfix trifft **1025 Haltekanten** von Bernex bis Berneck. Die Auflösung bestimmt deshalb zuerst den besten Namenstreffer und sammelt nur dessen Kanten ein.

**Bewusste Grenze:** Umsteigeverbindungen werden nicht berechnet. Das wäre eine echte Routensuche (RAPTOR o. Ä.) und ein anderes Projekt. Findet das Tool nichts, sagt es das im Feld `note`, statt schweigend leer zu antworten.

---

## Warum zwei Endpunkte

Der ursprüngliche Plan war ein Endpunkt mit gemischter Authentifizierung: harmlose Tools anonym, `query_gtfs` geschützt, deklariert über `securitySchemes` auf Tool-Ebene.

**Das SDK 1.29 kennt `securitySchemes` nicht.** `registerTool` destrukturiert exakt sechs Schlüssel:

```js
const { title, description, inputSchema, outputSchema, annotations, _meta } = config;
```

Jeder weitere Schlüssel wird **stillschweigend verworfen** — kein Fehler, keine Warnung, nichts auf der Leitung. Eine Deklaration wäre wirkungslos im Nichts verschwunden.

Deshalb zwei Endpunkte. Das ist zugleich die robustere Lösung: die Trennung liegt in der Middleware, nicht in Metadaten, die ein Client interpretieren muss.

`_meta` ist der offizielle Erweiterungskanal und wird unverändert ausgeliefert — die öffentlichen Tools tragen dort `securitySchemes: [{ type: "noauth" }]`. Ob ein Client das liest, ist offen; auf einem Endpunkt ohne jede Authentifizierung ist es ohnehin nur die Bestätigung des Offensichtlichen.

### `outputSchema` ist ein Vertrag mit Zähnen

Sobald ein Tool ein `outputSchema` deklariert, **muss** jede erfolgreiche Antwort ein dazu passendes `structuredContent` enthalten — sonst antwortet der Server mit `-32602` statt mit Daten. GTFS-Felder sind häufig leer, deshalb sind fast alle Felder in den Schemas `nullable`.

---

## OAuth zustandslos

Der Server ist zugleich Resource Server und Authorization Server. Für ein Einzelnutzer-Setup ist das angemessen und hält den Betrieb einfach: **alle Artefakte sind HMAC-signierte Nutzdaten**. Kein Token-Speicher, keine Datenbank, ein Neustart verliert nichts.

```
client_id       = c.<payload>.<hmac>     enthält die redirect_uris
authorization   = a.<payload>.<hmac>     60 Sekunden gültig
access_token    = t.<payload>.<hmac>     1 Stunde
refresh_token   = r.<payload>.<hmac>     30 Tage
session_cookie  = <exp>.<hmac>           30 Tage
```

### Typtrennung

Alle Artefakte werden mit **demselben** Secret signiert. Ohne Typkennzeichen im signierten Teil könnte ein Refresh-Token als Access-Token durchgehen — ein 30-Tage-Artefakt würde zum Vollzugriff. Das Kürzel (`c`, `a`, `t`, `r`) wandert deshalb **mit in die Signatur**; ein Test prüft genau diesen Fall.

### Einmalverwendung der Codes

Ein signierter Code ist für sich beliebig oft einlösbar. Ein gedeckeltes In-Memory-Set verhindert die zweite Einlösung. Weil es nach einem Neustart leer ist, leben Codes nur **60 Sekunden** — das Replay-Fenster ist damit winzig.

### Der Ablauf

```mermaid
sequenceDiagram
    autonumber
    participant C as Client<br/>(ChatGPT)
    participant S as Server
    participant U as Du<br/>(Browser)

    C->>S: POST /mcp-admin (ohne Token)
    S-->>C: 401 + resource_metadata="…/mcp-admin"
    C->>S: GET /.well-known/oauth-protected-resource/mcp-admin
    S-->>C: { resource, authorization_servers }
    C->>S: GET /.well-known/oauth-authorization-server
    S-->>C: { authorize, token, register, S256 }
    C->>S: POST /register { redirect_uris }
    S-->>C: client_id (= signierte Registrierung)

    Note over C: Verifier erzeugen<br/>Challenge = SHA256(Verifier)
    C->>U: Browser öffnen: /authorize?…&code_challenge=…
    U->>S: GET /authorize
    S-->>U: Zustimmungsseite mit PIN-Feld
    U->>S: POST /authorize + PIN
    S-->>U: 302 zurück zum Client, mit code
    U->>C: code

    C->>S: POST /token { code, code_verifier }
    Note over S: Signatur prüfen · Ablauf prüfen<br/>SHA256(Verifier) == Challenge?<br/>Code schon benutzt?
    S-->>C: access_token (1 h) + refresh_token (30 d)
    C->>S: POST /mcp-admin + Bearer access_token
    S-->>C: 8 Tools inkl. query_gtfs
```

Der Client sieht den PIN nie — er öffnet nur den Browser und bekommt am Ende einen Code zurück. Das ist der eigentliche Gewinn gegenüber einem fest hinterlegten Token.

### Discovery muss zusammenpassen

RFC 9728 §3 schiebt den well-known-String **zwischen** Host und Pfad, §3.3 verlangt, dass das gelieferte `resource` exakt der Kennung entspricht, aus der die Abruf-URL gebildet wurde:

```
richtig:  /.well-known/oauth-protected-resource/mcp-admin  →  resource: …/mcp-admin
falsch:   /.well-known/oauth-protected-resource            →  resource: …/mcp-admin
```

Die falsche Variante war zunächst ausgeliefert. Ein streng prüfender Client **muss** sie zurückweisen — der Fluss wäre für ihn tot gewesen, und der eigene Test hatte es durchgewinkt, weil er nur prüfte, *dass* ein `resource_metadata`-Parameter da ist, nicht *wohin* er zeigt. Beide Pfade werden bedient; MCP 2025-11-25 nennt die Wurzel ausdrücklich als Rückfall.

### Audience-Prüfung

Ein Access-Token, das für eine andere Ressource ausgestellt wurde, wird mit `invalid_token` abgewiesen (RFC 8707). Fehlt die Angabe, gilt das Token — es kann ohnehin nur von diesem Server stammen, weil nur er das Signaturgeheimnis kennt.

---

## Atomarer Fahrplanwechsel

Ein Update darf den laufenden Betrieb nicht gefährden. Der neue Stand wird **neben** dem alten aufgebaut:

```mermaid
flowchart LR
    A["gtfs.db<br/>in Betrieb"] --> B{"neuer Feed?"}
    B -->|nein| A
    B -->|ja| C["gtfs.staging.db<br/>laden + importieren"]
    C -->|Fehler| D["Staging verwerfen<br/>alter Stand läuft weiter"]
    C -->|vollständig| E["closeDb + umbenennen"]
    E --> F["gtfs.db<br/>neuer Stand"]
```

Vor dem Umbenennen wird `closeDb()` aufgerufen. Ohne das läse die offene readonly-Verbindung weiter den **alten Inode** — der Server würde stillschweigend veraltete Daten ausliefern.

**Selbstheilung:** Stirbt der Container genau zwischen den Umbenennungen, kann `gtfs.db` fehlen, während das Sentinel noch gesetzt ist. Der Entrypoint erkennt das: liegt die Sicherung `gtfs.db.old` vor, wird sie sofort zurückgestellt; sonst wird das Sentinel gelöscht und sauber neu aufgebaut.

---

## Leistung

Gemessen gegen den Produktivbestand (41 Mio. Zeilen):

| Vorgang | Laufzeit |
|---|---|
| `get_dataset_info` | 5–10 ms |
| `search_stops` | 40–90 ms |
| `get_connections`, innerstädtisch | 0.2 s |
| `get_connections`, Fernverkehr | 1.4–1.8 s |
| `get_stop_departures`, grosser Knoten | 2.7–2.8 s |
| Live-Suche der Web-UI (`/api/suggest`) | 34 ms + ~50 ms Netz |
| `/health` | gecacht, O(1) |

Gemessen über `POST /mcp` gegen den Produktivbestand, je drei warme Läufe.

**`get_stop_departures` ist der langsamste Aufruf.** Ein Knoten wie Zürich HB hat fast vierzig Haltekanten, und die Abfrage läuft zweimal — einmal für den heutigen Betriebstag, einmal für den vorherigen wegen der Nachtkurse. Der Aufwand steckt in der Gültigkeitsprüfung über `calendar_dates`, eine Tabelle mit rund zehn Millionen Zeilen. Für kleinere Haltestellen liegt der Wert deutlich darunter.

Zwei Optimierungen tragen den grössten Teil:

**Normalisierte Suchspalte.** `stop_name_norm` wird beim Import materialisiert und indiziert. Ohne sie läuft pro Abfrage ein `REPLACE`-Stapel über 103'548 Zeilen — 56 ms statt 34 ms.

**Gecachte Tabellenzahlen.** `/health` rief früher bei **jedem** Aufruf `COUNT(*)` über alle Tabellen auf — auch beim Docker-Healthcheck alle 30 Sekunden und bei jedem unauthentifizierten Poller. Da die Datenbank readonly ist, ändern sich die Zahlen nur beim Update-Wechsel; der Cache wird genau dort verworfen.

**Bekannte Grenze:** Eine freie SQL-Abfrage mit teurem Aggregat (Self-Join ohne Grenze) kann den Node-Prozess blockieren. `better-sqlite3` arbeitet synchron und kann laufende Abfragen nicht abbrechen. Deshalb liegt `query_gtfs` hinter der Anmeldung — der Schutz ist die Zugangskontrolle, nicht ein Zeitlimit.
