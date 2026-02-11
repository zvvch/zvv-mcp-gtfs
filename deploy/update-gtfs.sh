#!/bin/bash
# ───────────────────────────────────────────────────────────────────
#  GTFS Smart Auto-Update fuer ZVV GTFS MCP Server
#
#  Prueft taeglich ob neue Daten auf opentransportdata.swiss verfuegbar
#  sind. Aktualisiert nur bei Bedarf (spart Bandbreite + Downtime).
#
#  Cron (taeglich 03:00): 0 3 * * * /home/gtfs/update-gtfs.sh
#  Manuell:               /home/gtfs/update-gtfs.sh
#  Force-Update:          /home/gtfs/update-gtfs.sh --force
# ───────────────────────────────────────────────────────────────────
set -e

LOG=/home/gtfs/update-gtfs.log
APP_DIR=/home/gtfs/app
MAX_LOG_LINES=5000

# Log rotieren (max 5000 Zeilen behalten)
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt "$MAX_LOG_LINES" ]; then
  tail -n "$MAX_LOG_LINES" "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S'): $1" >> "$LOG"
}

log "=== Update-Check gestartet ==="

cd "$APP_DIR"

# Optional: Code aktualisieren
if [ "${UPDATE_CODE:-1}" = "1" ]; then
  log "Aktualisiere Code von GitHub..."
  git pull --ff-only 2>>"$LOG" || true
  npm install --production --no-fund --no-audit 2>>"$LOG" || true
fi

# Smart Check: Gibt es neue Daten?
FORCE_FLAG=""
if [ "${1}" = "--force" ]; then
  FORCE_FLAG="--force"
  log "Force-Update angefordert"
fi

log "Pruefe auf neue GTFS-Daten..."
CHECK_RESULT=$(node check-update.js --check 2>&1) || CHECK_EXIT=$?
CHECK_EXIT=${CHECK_EXIT:-0}

echo "$CHECK_RESULT" >> "$LOG"

if [ "$CHECK_EXIT" = "0" ] && [ -z "$FORCE_FLAG" ]; then
  # Exit 0 = Daten sind aktuell
  log "Keine neuen Daten verfuegbar. Fertig."
  exit 0
fi

if [ "$CHECK_EXIT" = "1" ] && [ -z "$FORCE_FLAG" ]; then
  # Exit 1 = Fehler beim Check
  log "WARNUNG: Update-Check fehlgeschlagen. Ueberspringe Update."
  exit 1
fi

# Exit 2 = Update verfuegbar, oder --force
log "Neues GTFS-Update wird installiert..."

# Server stoppen fuer sauberen DB-Wechsel
sudo systemctl stop gtfs
log "Server gestoppt"

# Alte Daten entfernen
rm -f zvv-data/gtfs/*.txt zvv-data/gtfs.db zvv-data/gtfs.db-wal zvv-data/gtfs.db-shm

# Neue Daten laden & importieren
log "Download laeuft..."
node download-gtfs.js 2>>"$LOG"
log "Import laeuft..."
node import-gtfs.js 2>>"$LOG"

# Server starten
sudo systemctl start gtfs
log "Server neu gestartet"

# Kurzer Health-Check
sleep 3
if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
  # Version aus Health-Endpoint lesen
  GTFS_FILE=$(curl -sf http://localhost:3000/health | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).database.gtfs_filename)}catch(e){}})" 2>/dev/null || echo "unbekannt")
  log "GTFS-Update erfolgreich: $GTFS_FILE"
else
  log "WARNUNG: Server antwortet nicht nach Update!"
  sudo systemctl restart gtfs
  sleep 3
  if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    log "Server nach Neustart OK"
  else
    log "FEHLER: Server laeuft nicht nach Update!"
  fi
fi

log "=== Update abgeschlossen ==="
