#!/bin/bash
# ───────────────────────────────────────────────────────────────────
#  GTFS-Daten-Update fuer ZVV GTFS MCP Server
#
#  Wird automatisch via Cron ausgefuehrt (Mi 03:00).
#  Manuell: /home/gtfs/update-gtfs.sh
# ───────────────────────────────────────────────────────────────────
set -e

LOG=/home/gtfs/update-gtfs.log
APP_DIR=/home/gtfs/app

echo "$(date '+%Y-%m-%d %H:%M:%S'): Starte GTFS-Update..." >> "$LOG"

cd "$APP_DIR"

# Optional: Code aktualisieren
if [ "${UPDATE_CODE:-0}" = "1" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S'): Aktualisiere Code von GitHub..." >> "$LOG"
  git pull --ff-only 2>>"$LOG" || true
  npm install --production --no-fund --no-audit 2>>"$LOG" || true
fi

# Server stoppen fuer sauberen DB-Wechsel
sudo systemctl stop gtfs

# Alte Daten entfernen
rm -f zvv-data/gtfs/*.txt zvv-data/gtfs.db zvv-data/gtfs.db-wal zvv-data/gtfs.db-shm

# Neue Daten laden & importieren
node download-gtfs.js 2>>"$LOG"
node import-gtfs.js 2>>"$LOG"

# Server starten
sudo systemctl start gtfs

# Kurzer Health-Check
sleep 3
if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
  echo "$(date '+%Y-%m-%d %H:%M:%S'): GTFS-Update erfolgreich" >> "$LOG"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S'): WARNUNG - Server antwortet nicht nach Update!" >> "$LOG"
  sudo systemctl restart gtfs
fi
