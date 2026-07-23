# Betrieb

Deployment, Cloudflare-Tunnel und Fehlersuche.

- [Deployment](#deployment)
- [Cloudflare-Tunnel](#cloudflare-tunnel)
- [Reboot-Festigkeit](#reboot-festigkeit)
- [Plattenplatz](#plattenplatz)
- [Fehlersuche](#fehlersuche)

---

## Deployment

Zwei Compose-Services:

| Service | Zweck | Start |
|---|---|---|
| `gtfs` | MCP-Server, gebunden an `127.0.0.1` | `docker compose up -d` |
| `cloudflared` | Tunnel nach aussen | zusätzlich `--profile tunnel` |

```bash
docker volume create zvv-gtfs-data        # einmalig, siehe unten
docker compose up -d                      # nur lokal
docker compose --profile tunnel up -d     # mit Tunnel
```

Der Host-Port ist **bewusst nur auf Loopback** gebunden. Von aussen erreichbar wird der Dienst ausschliesslich über den Tunnel — nicht über eine offene Portfreigabe.

### Volume

Datenbank und entpackte Rohdaten liegen im **externen** Volume `zvv-gtfs-data` (rund 8.8 GB). „Extern" heisst: ausserhalb des Compose-Lebenszyklus, damit ein `docker compose down -v` sie nicht mitreisst. Ein Neuaufbau kostet 10–15 Minuten.

> [!IMPORTANT]
> Der Preis dafür: Compose legt externe Volumes **nicht** an. Auf einer neuen Maschine muss das Volume einmalig von Hand entstehen, sonst bricht `docker compose up -d` ab mit `external volume "zvv-gtfs-data" not found`, bevor ein Container startet.

```bash
docker volume create zvv-gtfs-data    # einmalig, wiederholbar
docker volume inspect zvv-gtfs-data   # prüfen
```

---

## Cloudflare-Tunnel

Der Dienst läuft lokal und ist über einen **Named Tunnel** unter einem festen Hostnamen erreichbar — ohne Portfreigabe, ohne feste IP, auch hinter NAT.

### Einrichtung

```bash
cloudflared tunnel login                          # Browser: Zone auswählen
cloudflared tunnel create zvv-mcp-gtfs            # schreibt <UUID>.json
cloudflared tunnel route dns <UUID> gtfs.zvv.dev  # DNS-Eintrag setzen
```

Dann in `.env`:

```bash
TUNNEL_ID=<UUID>
CF_CREDENTIALS_FILE=C:/Users/<du>/.cloudflared/<UUID>.json
```

und starten mit `docker compose --profile tunnel up -d`.

Die **Ingress-Regel steht in `docker-compose.yml`** (`--url http://gtfs:3000`), nicht im Cloudflare-Dashboard. Damit ist das Setup versioniert und reproduzierbar; es braucht keine Konfiguration in der Weboberfläche.

### Wichtig: den bestehenden Dienst nicht überschreiben

Läuft auf der Maschine bereits ein `cloudflared`-Systemdienst für andere Zwecke, dann **nicht** `cloudflared service install` aufrufen. Der Befehl kennt keinen `--name`-Parameter und verwaltet genau einen Dienst — ein Aufruf überschreibt den bestehenden und kappt dessen Routen.

Der Tunnel dieses Projekts läuft deshalb als **Container**, nicht als Systemdienst. Beide koexistieren problemlos.

### Route auf einen anderen Origin umbiegen

Zeigt ein bestehender DNS-Eintrag noch auf einen toten Origin (Symptom: **502** statt Cloudflare-Fehlerseite 1033), lässt er sich im Dashboard umhängen: *Networks → Tunnels → Tunnel wählen → Public Hostnames*. Ein blanker 502 heisst: die Route existiert am Edge und ein Connector ist erreichbar, aber der Dienst dahinter antwortet nicht.

---

## Reboot-Festigkeit

Drei Dinge, damit der Dienst einen Neustart übersteht:

1. **`restart: unless-stopped`** auf beiden Services — greift, sobald Docker läuft
2. **Docker startet beim Anmelden** — siehe unten, das ist die kritische Stelle
3. **Externes Volume**, das ein `down -v` nicht wegräumt

### Docker-Autostart prüfen

> [!WARNING]
> `restart: unless-stopped` nützt nichts, wenn Docker selbst nicht startet. Auf einer Windows-Maschine ist das leicht zu übersehen: die Container gelten als „laufend", der Dienst ist aber nach jedem Neustart tot.

Zwei Stellen entscheiden gemeinsam, und beide müssen stimmen:

```powershell
# 1. Docker-eigene Einstellung
(Get-Content "$env:APPDATA\Docker\settings-store.json" -Raw | ConvertFrom-Json).AutoStart

# 2. Windows-Autostart: 02 = aktiviert, 03 = deaktiviert
$b = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run")."Docker Desktop"
if ($b[0] -band 1) { "DEAKTIVIERT" } else { "aktiviert" }
```

Die zweite Stelle ist die wirksame. Ein Eintrag unter `Run` allein genügt nicht — der Task-Manager kann ihn abgeschaltet haben, ohne ihn zu entfernen.

Am zuverlässigsten stellst du das in der Oberfläche um: *Docker Desktop → Settings → General → „Start Docker Desktop when you sign in"*. Das setzt beide Werte konsistent. Ein direktes Schreiben in `settings-store.json` wird von Docker Desktop beim Beenden überschrieben.

---

## Plattenplatz

| Posten | Grösse |
|---|---|
| GTFS-ZIP (nur während des Downloads) | ~190 MB |
| Rohdaten entpackt | ~2.9 GB |
| SQLite-Datenbank | ~5.3 GB |
| **Dauerbedarf im Volume** | **~8.2 GB** |
| **Spitze während eines Updates** | **~16 GB** |

Der Spitzenwert entsteht durch den atomaren Wechsel: der neue Stand — Rohdaten **und** Datenbank — entsteht vollständig neben dem alten, bevor umgeschaltet wird. Rechne mit mindestens **9 GB freiem Platz** zusätzlich zum Dauerbedarf. Reicht er nicht, schlägt das Update fehl und der alte Stand läuft unverändert weiter.

---

## Fehlersuche

### Container startet in einer Schleife

```bash
docker compose logs gtfs --tail 30
```

`MODULE_NOT_FOUND` bedeutet meist, dass eine neue Quelldatei nicht in der `COPY`-Zeile des `Dockerfile` steht. Die Datei ist im Repo, aber nicht im Image.

### `gtfs.zvv.dev` liefert 502

Der Tunnel steht, das Backend nicht:

```bash
docker compose ps                        # läuft gtfs? healthy?
curl http://localhost:3000/health        # Port aus HOST_PORT, Vorgabe 3000
docker compose logs cloudflared --tail 20
```

`connection refused` in den cloudflared-Logs heisst: der Tunnel erreicht den Container nicht — meist weil dieser neu gebaut wird oder abgestürzt ist.

### Docker Desktop startet nicht (Windows)

Fehlerbild:

```
starting services: initializing Inference manager:
listening on unix://…\Docker\run\dockerInference:
remove …: Das System kann auf die Datei nicht zugreifen.
```

**Ursache:** verwaiste AF_UNIX-Socket-Dateien. Nach einem Windows-Update kann der `afunix.sys`-Treiber alte Reparse Points nicht mehr auflösen. Docker versucht beim Start, jeden Socket zu löschen, scheitert mit Fehler 1920 und bricht den gesamten Engine-Start ab.

Die Dateien sind **nicht löschbar** — weder mit `Remove-Item -Force`, noch `fsutil reparsepoint delete`, noch `del`. Der Ausweg ist, die **Verzeichnisse** umzubenennen; Docker legt sie neu an:

```powershell
Get-Process -Name "Docker Desktop","com.docker.backend" | Stop-Process -Force
Rename-Item "$env:LOCALAPPDATA\Docker\run" "run.broken"
Rename-Item "$env:LOCALAPPDATA\docker-secrets-engine" "docker-secrets-engine.broken"
```

**Es sind mehrere Verzeichnisse betroffen.** Die Fehlermeldung nennt immer nur den gerade scheiternden Dienst — nach dem Aufräumen von `Docker\run` scheitert der Start am nächsten Socket. Alle in einem Zug erledigen.

`EnableDockerAI` abzuschalten hilft **nicht**; es verschiebt den Fehler nur. Und *„Reset to factory defaults"* im Fehlerdialog nicht anklicken — das löscht alle Container, Images und Volumes, inklusive der 5.3-GB-Datenbank.

### Fahrplan veraltet

```bash
docker compose exec gtfs node check-update.js --check
curl -s http://localhost:3000/health | grep -o '"gtfs_filename":"[^"]*"'
```

### Zu viele Fehlversuche (429)

Der Brute-Force-Schutz greift: 10 Fehlversuche je IP sperren diese 15 Minuten, 30 insgesamt drosseln global. Warten oder den Container neu starten — die Zähler liegen im Arbeitsspeicher.
