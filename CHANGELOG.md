# Changelog

Alle nennenswerten Änderungen an diesem Projekt.

Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung [Semantic Versioning](https://semver.org/lang/de/).

## [Unveröffentlicht]

### Hinzugefügt

- Lizenz, Verhaltenskodex, Beitragsleitfaden, Sicherheitsrichtlinie sowie Vorlagen für Issues und Pull Requests.

## [3.0.0] – 2026-07-23

Der Server ist nicht mehr ein einzelner geschützter Endpunkt, sondern trennt öffentliche Fahrplanabfragen von administrativen Analysen.

### Hinzugefügt

- **Öffentlicher MCP-Endpunkt `POST /mcp`** ohne Anmeldung, mit sieben lesenden Fachabfragen. Damit lässt sich der Server als ChatGPT-App ohne Authentifizierung eintragen.
- **Geschützter Endpunkt `POST /mcp-admin`** mit der freien SQL-Abfrage.
- **OAuth 2.1 mit PKCE** für `/mcp-admin`, einschliesslich Discovery nach RFC 9728 und RFC 8414, dynamischer Client-Registrierung nach RFC 7591 sowie Aktualisierungstoken. Alle Artefakte sind signiert und zustandslos.
- **`get_connections`** findet direkte Verbindungen zwischen zwei Haltestellen.
- **`get_dataset_info`** meldet den geladenen Fahrplan und ausdrücklich, dass keine Echtzeitdaten vorliegen.
- **Live-Suche** in der Weboberfläche, wortweise und tolerant gegenüber fehlenden Umlauten.
- **Sitzungscookie** statt wiederholter PIN-Eingabe, dreissig Tage gültig.
- **Brute-Force-Schutz** mit Sperre je Adresse und globaler Bremse.
- **Permanenter Cloudflare-Tunnel** als Compose-Dienst mit lokal abgelegten Zugangsdaten.
- **`docs/ARCHITECTURE.md`** und **`docs/OPERATIONS.md`**.

### Geändert

- Alle Tools nutzen `registerTool` mit `outputSchema`, `structuredContent` und `readOnlyHint`.
- `get_departures` heisst `get_stop_departures` und nimmt auch Haltestellennamen entgegen.
- Der Fahrplan hält sich selbst aktuell: täglich geprüft, atomar gewechselt.

### Behoben

- **Alte DIDOK-Nummern lieferten stillschweigend nichts.** Seit Fahrplan 2026-07 nutzt der Feed SLOID-Kennungen; `8503000` kommt nicht mehr vor. Bekannte Nummern werden jetzt übersetzt, unbekannte Eingaben als Fehler gemeldet statt als leeres Ergebnis.
- **`route_type` 0 bis 7 fand keine Linien.** Der Feed nutzt ausschliesslich erweiterte HVT-Werte. Klassische Werte werden abgebildet.
- **Nachtkurse nach Mitternacht fehlten.** Fahrten des vorherigen Betriebstags mit Zeiten jenseits 24:00 werden mitgeliefert und auf die Wanduhr umgerechnet.
- **Datum kam aus UTC.** Zwischen Mitternacht und etwa zwei Uhr zeigte der Server den Vortag.
- **Der Grenzwert wanderte roh in die Abfrage.** Ein negativer oder sehr grosser Wert hebelte die Begrenzung aus.
- **Abfragen mit führendem Kommentar wurden abgewiesen.** Die Prüfung auf `SELECT` scheiterte an `-- Beschreibung`.
- **Ein Aktualisierungstoken galt als Zugriffstoken.** Alle Artefakte teilen ein Signaturgeheimnis; sie tragen jetzt ein signiertes Typkennzeichen.
- **Der Verweis auf die Ressourcen-Metadaten zeigte auf den falschen Pfad.** Nach RFC 9728 §3.3 hätte ein streng prüfender Client den OAuth-Fluss abgebrochen.

### Sicherheit

- Zugriffstoken werden gegen die eigene Ressourcenkennung geprüft (RFC 8707).
- Die Schlüsselwortsperre blendet Zeichenketten-Literale aus und erlaubt `WITH … SELECT`.
- `/health` liefert den absoluten Datenbankpfad nicht mehr aus und beantwortet Anfragen aus einem Zwischenspeicher, statt bei jedem Aufruf über alle Tabellen zu zählen.

## [2.0.0] – 2026-07-22

### Hinzugefügt

- Auslieferung als Docker-Abbild über die GitHub Container Registry, mehrarchitektur-fähig.
- Token-Schutz für `/mcp` und `/api/query`.
- Atomarer Fahrplanwechsel: der neue Stand entsteht neben dem alten, ein Fehlschlag lässt den bisherigen unberührt.
- Selbstheilung, falls der Container während des Wechsels abstürzt.

### Entfernt

- Vercel-Konfiguration. Die Datenbank ist mit rund fünf Gigabyte weit jenseits des Funktionslimits.
- Proxmox-Installationsskripte und der Deploy über einen selbst gehosteten Runner.

## [1.0.0] – 2026-02-11

### Hinzugefügt

- MCP-Server auf Basis des offiziellen SDK mit sechs Werkzeugen.
- Weboberfläche zum Erkunden der Fahrplandaten.
- Importpfad von den Rohdaten nach SQLite.
