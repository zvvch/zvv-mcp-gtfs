#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────
#  ZVV GTFS MCP Server — Proxmox LXC One-Liner Installer
#
#  Usage:
#    bash <(curl -fsSL https://raw.githubusercontent.com/zvvch/mcp-gtfs/main/deploy/install.sh)
#
#  Mit vorkonfiguriertem Cloudflare-Token:
#    CF_TOKEN="eyJ..." bash <(curl -fsSL https://raw.githubusercontent.com/zvvch/mcp-gtfs/main/deploy/install.sh)
#
#  Alle Optionen:
#    VMID=200 MEMORY=4096 DISK=15 CF_TOKEN="eyJ..." bash <(curl -fsSL ...)
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

# ─── Konfiguration (ueberschreibbar via Umgebungsvariablen) ───────
VMID="${VMID:-}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
MEMORY="${MEMORY:-2048}"
SWAP="${SWAP:-512}"
DISK="${DISK:-10}"
CORES="${CORES:-2}"
CT_HOSTNAME="${CT_HOSTNAME:-gtfs}"
REPO_URL="${REPO_URL:-https://github.com/zvvch/mcp-gtfs.git}"
NODE_MAJOR="${NODE_MAJOR:-22}"
APP_PORT="${APP_PORT:-3000}"
CF_TOKEN="${CF_TOKEN:-}"

# ─── Farben & Helfer ─────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()   { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()     { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()   { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()    { echo -e "${RED}[FAIL]${NC}  $*" >&2; }
die()    { err "$*"; exit 1; }
header() {
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  $*${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ══════════════════════════════════════════════════════════════════
#  Phase 1: Proxmox Host
# ══════════════════════════════════════════════════════════════════

header "ZVV GTFS MCP Server — LXC Installer"

# Proxmox pruefen
command -v pveversion >/dev/null 2>&1 \
  || die "Dieses Script muss auf einem Proxmox VE Host ausgefuehrt werden!"
info "Proxmox VE erkannt: $(pveversion 2>/dev/null || echo 'unbekannt')"

# ── Template ──────────────────────────────────────────────────────
info "Pruefe Ubuntu 24.04 Template..."
TEMPLATE_PATH=$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null \
  | grep -i "ubuntu-24.04" | awk '{print $1}' | head -1)

if [ -z "$TEMPLATE_PATH" ]; then
  info "Template wird heruntergeladen..."
  pveam update >/dev/null 2>&1 || true
  TEMPLATE_NAME=$(pveam available --section system 2>/dev/null \
    | grep -i "ubuntu-24.04" | awk '{print $2}' | head -1)
  [ -z "$TEMPLATE_NAME" ] && die "Kein Ubuntu 24.04 Template verfuegbar!"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_NAME"
  TEMPLATE_PATH="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE_NAME}"
fi
ok "Template: $TEMPLATE_PATH"

# ── VMID ──────────────────────────────────────────────────────────
if [ -z "$VMID" ]; then
  VMID=$(pvesh get /cluster/nextid 2>/dev/null)
fi
info "VMID: $VMID"

# ── LXC erstellen ────────────────────────────────────────────────
info "Erstelle LXC Container (${CORES} CPU, ${MEMORY} MB RAM, ${DISK} GB Disk)..."
pct create "$VMID" "$TEMPLATE_PATH" \
  --hostname "$CT_HOSTNAME" \
  --memory "$MEMORY" \
  --swap "$SWAP" \
  --cores "$CORES" \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --unprivileged 1 \
  --features nesting=1 \
  --start 0 \
  --ostype ubuntu
ok "LXC $VMID erstellt"

# Aufraeumen bei Fehler
CLEANUP_DONE=0
cleanup() {
  if [ "$CLEANUP_DONE" = "0" ]; then
    CLEANUP_DONE=1
    err "Installation fehlgeschlagen – Container $VMID wird entfernt..."
    pct stop "$VMID" 2>/dev/null || true
    sleep 2
    pct destroy "$VMID" 2>/dev/null || true
  fi
}
trap cleanup ERR

# ── Starten & Netzwerk ───────────────────────────────────────────
info "Starte Container..."
pct start "$VMID"

info "Warte auf Netzwerk..."
NETWORK_OK=0
for i in $(seq 1 30); do
  if pct exec "$VMID" -- ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; then
    NETWORK_OK=1; break
  fi
  sleep 1
done
[ "$NETWORK_OK" = "1" ] || die "Container hat nach 30 s kein Netzwerk!"
ok "Netzwerk bereit"

CT_IP=$(pct exec "$VMID" -- hostname -I 2>/dev/null | awk '{print $1}')
info "Container IP: ${CT_IP:-unbekannt}"

# ── Cloudflare Token ─────────────────────────────────────────────
if [ -z "$CF_TOKEN" ]; then
  echo ""
  echo -e "${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${YELLOW}║  Cloudflare Tunnel Token benoetigt                          ║${NC}"
  echo -e "${YELLOW}║                                                              ║${NC}"
  echo -e "${YELLOW}║  1. https://one.dash.cloudflare.com/                         ║${NC}"
  echo -e "${YELLOW}║  2. Networks > Tunnels > Create a tunnel                     ║${NC}"
  echo -e "${YELLOW}║  3. Name: gtfs-zvv                                           ║${NC}"
  echo -e "${YELLOW}║  4. Kopiere den Token (beginnt mit eyJ...)                   ║${NC}"
  echo -e "${YELLOW}║  5. Public Hostname: gtfs.zvv.dev -> http://localhost:3000   ║${NC}"
  echo -e "${YELLOW}║                                                              ║${NC}"
  echo -e "${YELLOW}║  ENTER ohne Eingabe = ohne Tunnel fortfahren                 ║${NC}"
  echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  read -rp "  Cloudflare Tunnel Token: " CF_TOKEN
  echo ""
fi

# Token an Container uebergeben
if [ -n "$CF_TOKEN" ]; then
  printf '%s' "$CF_TOKEN" \
    | pct exec "$VMID" -- bash -c 'cat > /tmp/.cf_token && chmod 600 /tmp/.cf_token'
fi

# Konfiguration an Container uebergeben
pct exec "$VMID" -- bash -c "cat > /tmp/.install-config" <<EOF
REPO_URL=$REPO_URL
APP_PORT=$APP_PORT
NODE_MAJOR=$NODE_MAJOR
EOF

# ══════════════════════════════════════════════════════════════════
#  Phase 2: Setup im LXC Container
# ══════════════════════════════════════════════════════════════════

header "Setup im Container (dauert ca. 5-10 Minuten)"

pct exec "$VMID" -- bash <<'SETUP_EOF'
#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Konfiguration einlesen
source /tmp/.install-config
rm -f /tmp/.install-config

# CF-Token einlesen (falls vorhanden)
CF_TOKEN=""
[ -f /tmp/.cf_token ] && { CF_TOKEN=$(cat /tmp/.cf_token); rm -f /tmp/.cf_token; }

APP_DIR="/home/gtfs/app"

# Farben
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}  [LXC]${NC}  $*"; }
ok()    { echo -e "${GREEN}  [LXC]${NC}  $*"; }
warn()  { echo -e "${YELLOW}  [LXC]${NC}  $*"; }

# ── 1. System-Pakete ─────────────────────────────────────────────
info "Installiere System-Pakete..."
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq \
  curl git build-essential python3 ca-certificates gnupg lsb-release \
  >/dev/null 2>&1
ok "System-Pakete installiert"

# ── 2. Node.js ───────────────────────────────────────────────────
info "Installiere Node.js ${NODE_MAJOR}..."
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs >/dev/null 2>&1
ok "Node.js $(node --version) + npm $(npm --version)"

# ── 3. Benutzer ──────────────────────────────────────────────────
id -u gtfs >/dev/null 2>&1 || useradd -m -s /bin/bash gtfs
ok "Benutzer 'gtfs' bereit"

# ── 4. Repository ────────────────────────────────────────────────
info "Klone Repository..."
[ -d "$APP_DIR" ] && rm -rf "$APP_DIR"
git clone --depth 1 "$REPO_URL" "$APP_DIR" 2>&1 | tail -1
chown -R gtfs:gtfs /home/gtfs
ok "Repository geklont"

# ── 5. npm install ───────────────────────────────────────────────
info "Installiere npm-Abhaengigkeiten..."
cd "$APP_DIR"
sudo -u gtfs npm install --production --no-fund --no-audit 2>&1 | tail -3
ok "Abhaengigkeiten installiert"

# ── 6. GTFS-Daten herunterladen & importieren ────────────────────
info "Lade GTFS-Daten herunter (~320 MB, kann einige Minuten dauern)..."
sudo -u gtfs node download-gtfs.js
ok "GTFS-Download abgeschlossen"

info "Importiere GTFS in SQLite-Datenbank..."
sudo -u gtfs node import-gtfs.js
ok "GTFS-Import abgeschlossen"

# ── 7. systemd Service ───────────────────────────────────────────
info "Erstelle systemd-Service..."
cat > /etc/systemd/system/gtfs.service <<'SVCEOF'
[Unit]
Description=ZVV GTFS MCP Server
After=network.target

[Service]
Type=simple
User=gtfs
WorkingDirectory=/home/gtfs/app
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gtfs

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable --now gtfs >/dev/null 2>&1
ok "Service 'gtfs' aktiv"

# ── 8. Health-Check ──────────────────────────────────────────────
info "Pruefe Server..."
HEALTH_OK=0
for i in $(seq 1 15); do
  if curl -sf "http://localhost:${APP_PORT}/health" >/dev/null 2>&1; then
    HEALTH_OK=1; break
  fi
  sleep 1
done
if [ "$HEALTH_OK" = "1" ]; then
  ok "Server antwortet auf /health"
else
  echo "  Health-Check fehlgeschlagen nach 15 Versuchen!"
  journalctl -u gtfs --no-pager -n 30
  exit 1
fi

# ── 9. cloudflared ───────────────────────────────────────────────
info "Installiere cloudflared..."
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg 2>/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq cloudflared >/dev/null 2>&1
ok "cloudflared installiert"

# ── 10. Tunnel einrichten ────────────────────────────────────────
if [ -n "$CF_TOKEN" ]; then
  info "Richte Cloudflare Tunnel ein..."
  cloudflared service install "$CF_TOKEN" 2>&1 || true
  systemctl enable cloudflared >/dev/null 2>&1 || true
  ok "Cloudflare Tunnel aktiv"
else
  warn "Kein CF-Token angegeben – Tunnel muss manuell eingerichtet werden"
  warn "  cloudflared service install <TOKEN>"
fi

# ── 11. Update-Script & Cron ─────────────────────────────────────
info "Richte taeglichen GTFS Smart-Update Cron ein..."

# Update-Script aus dem Repository verwenden
cp /home/gtfs/app/deploy/update-gtfs.sh /home/gtfs/update-gtfs.sh
chmod +x /home/gtfs/update-gtfs.sh
chown gtfs:gtfs /home/gtfs/update-gtfs.sh

# Cron: Taeglich 03:00 Uhr (Script prueft selbst ob neue Daten da sind)
( crontab -u gtfs -l 2>/dev/null | grep -v 'update-gtfs' || true
  echo "0 3 * * * /home/gtfs/update-gtfs.sh >> /home/gtfs/update-gtfs.log 2>&1"
) | crontab -u gtfs -
ok "Cron-Job: Taeglich 03:00 Uhr (Smart-Update)"

# ── 12. Sudoers ──────────────────────────────────────────────────
cat > /etc/sudoers.d/gtfs <<'SUDOEOF'
gtfs ALL=(root) NOPASSWD: /usr/bin/systemctl stop gtfs, /usr/bin/systemctl start gtfs, /usr/bin/systemctl restart gtfs
SUDOEOF
chmod 440 /etc/sudoers.d/gtfs
ok "Sudoers konfiguriert"

echo ""
ok "Container-Setup abgeschlossen!"
SETUP_EOF

# Fehler-Trap entfernen (Erfolg)
trap - ERR
CLEANUP_DONE=1

# ══════════════════════════════════════════════════════════════════
#  Phase 3: Zusammenfassung
# ══════════════════════════════════════════════════════════════════

CT_IP=$(pct exec "$VMID" -- hostname -I 2>/dev/null | awk '{print $1}')

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Installation erfolgreich abgeschlossen!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}VMID:${NC}       $VMID"
echo -e "  ${BOLD}IP:${NC}         ${CT_IP:-n/a}"
echo -e "  ${BOLD}Frontend:${NC}   http://${CT_IP:-<IP>}:${APP_PORT}/"
echo -e "  ${BOLD}Health:${NC}     http://${CT_IP:-<IP>}:${APP_PORT}/health"
echo -e "  ${BOLD}MCP:${NC}        POST http://${CT_IP:-<IP>}:${APP_PORT}/mcp"
if [ -n "$CF_TOKEN" ]; then
  echo -e "  ${BOLD}Tunnel:${NC}     https://gtfs.zvv.dev"
fi
echo ""
echo -e "  ${BOLD}Nuetzliche Befehle:${NC}"
echo -e "    Logs:         ${BLUE}pct exec $VMID -- journalctl -u gtfs -f${NC}"
echo -e "    Shell:        ${BLUE}pct enter $VMID${NC}"
echo -e "    Neustart:     ${BLUE}pct exec $VMID -- systemctl restart gtfs${NC}"
echo -e "    GTFS-Update:  ${BLUE}pct exec $VMID -- su - gtfs -c /home/gtfs/update-gtfs.sh${NC}"
if [ -n "$CF_TOKEN" ]; then
  echo -e "    Tunnel-Logs:  ${BLUE}pct exec $VMID -- journalctl -u cloudflared -f${NC}"
fi
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
