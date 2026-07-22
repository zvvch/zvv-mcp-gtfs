#!/usr/bin/env sh
# ───────────────────────────────────────────────────────────────────
#  Entrypoint fuer den ZVV GTFS MCP Server
#
#  Baut beim allerersten Start die SQLite-DB aus den offiziellen
#  GTFS-Daten auf. Danach wird der vorhandene Bestand wiederverwendet.
#  Beides passiert im Volume /app/zvv-data, nicht im Image.
# ───────────────────────────────────────────────────────────────────
set -eu

DATA_DIR=/app/zvv-data
DB="$DATA_DIR/gtfs.db"
# Sentinel statt blosser DB-Existenz: ein abgebrochener Import
# hinterlaesst sonst eine unvollstaendige DB, die nie repariert wuerde.
SENTINEL="$DATA_DIR/.build-complete"

log() { echo "[entrypoint] $*"; }

if [ ! -f "$SENTINEL" ]; then
  log "Keine vollstaendige Datenbank gefunden — Erstaufbau startet."
  log "Quelle: opentransportdata.swiss (~2 GB entpackt, Ergebnis ~5.3 GB)"
  log "Dauer: 10 bis 15 Minuten. Der Server startet danach automatisch."

  rm -f "$DB" "$DB-wal" "$DB-shm"

  node download-gtfs.js
  node import-gtfs.js

  touch "$SENTINEL"
  log "Erstaufbau abgeschlossen."
else
  log "Datenbank vorhanden ($(du -h "$DB" | cut -f1))."
  # Fahrplan-Updates macht der Server selbst, im Hintergrund und atomar.
  # Hier zu warten wuerde den Start unnoetig blockieren.
fi

exec "$@"
