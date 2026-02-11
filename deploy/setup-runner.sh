#!/bin/bash
# ───────────────────────────────────────────────────────────────────
#  GitHub Actions Self-Hosted Runner Setup fuer LXC
#
#  Ausfuehrung im LXC Container (als root):
#    bash <(curl -fsSL https://raw.githubusercontent.com/zvvch/mcp-gtfs/main/deploy/setup-runner.sh)
#
#  Oder von Proxmox aus:
#    pct exec 105 -- bash <(curl -fsSL ...)
#
#  Voraussetzung: GitHub Personal Access Token oder Runner-Token
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[FAIL]${NC}  $*" >&2; }

RUNNER_USER="gtfs"
RUNNER_DIR="/home/${RUNNER_USER}/actions-runner"
REPO="${REPO:-zvvch/mcp-gtfs}"
LABELS="${LABELS:-self-hosted,linux,x64,gtfs}"

# Token kann als Argument, Env-Var, oder interaktiv uebergeben werden
# Usage: setup-runner.sh <TOKEN>
#    or: RUNNER_TOKEN=xxx setup-runner.sh
RUNNER_TOKEN="${1:-${RUNNER_TOKEN:-}}"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  GitHub Actions Runner Setup${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ -z "$RUNNER_TOKEN" ]; then
  echo -e "${YELLOW}Runner-Token wird benoetigt:${NC}"
  echo -e "  1. https://github.com/${REPO}/settings/actions/runners/new"
  echo -e "  2. Kopiere den Token aus dem ./config.sh Befehl"
  echo -e "     (beginnt meist mit A...)"
  echo ""
  read -rp "  Runner Registration Token: " RUNNER_TOKEN </dev/tty
  echo ""
fi

if [ -z "$RUNNER_TOKEN" ]; then
  err "Kein Token angegeben! Usage: setup-runner.sh <TOKEN>"
  exit 1
fi

ok "Token erhalten"

# ── Dependencies ──────────────────────────────────────────────────
info "Installiere Abhaengigkeiten..."
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq curl tar libicu-dev >/dev/null 2>&1
ok "Abhaengigkeiten installiert"

# ── Runner herunterladen ──────────────────────────────────────────
info "Lade GitHub Actions Runner herunter..."

# Neueste Version ermitteln
RUNNER_VERSION=$(curl -sf https://api.github.com/repos/actions/runner/releases/latest | grep -oP '"tag_name":\s*"v\K[^"]+')
if [ -z "$RUNNER_VERSION" ]; then
  RUNNER_VERSION="2.322.0"
  warn "Konnte neueste Version nicht ermitteln, verwende ${RUNNER_VERSION}"
fi
info "Runner Version: ${RUNNER_VERSION}"

RUNNER_ARCH="linux-x64"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"

mkdir -p "$RUNNER_DIR"
chown "${RUNNER_USER}:${RUNNER_USER}" "$RUNNER_DIR"

cd "$RUNNER_DIR"
curl -fsSL "$RUNNER_URL" | sudo -u "$RUNNER_USER" tar xz
ok "Runner heruntergeladen"

# ── Runner konfigurieren ──────────────────────────────────────────
info "Konfiguriere Runner..."
sudo -u "$RUNNER_USER" ./config.sh \
  --url "https://github.com/${REPO}" \
  --token "$RUNNER_TOKEN" \
  --name "gtfs-lxc" \
  --labels "$LABELS" \
  --unattended \
  --replace
ok "Runner konfiguriert"

# ── systemd Service ───────────────────────────────────────────────
info "Erstelle systemd-Service..."

cat > /etc/systemd/system/github-runner.service <<SVCEOF
[Unit]
Description=GitHub Actions Runner (${REPO})
After=network.target

[Service]
Type=simple
User=${RUNNER_USER}
WorkingDirectory=${RUNNER_DIR}
ExecStart=${RUNNER_DIR}/run.sh
Restart=always
RestartSec=5
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=5min

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable --now github-runner >/dev/null 2>&1
ok "Runner-Service aktiv"

# ── Verify ────────────────────────────────────────────────────────
sleep 2
if systemctl is-active --quiet github-runner; then
  ok "Runner laeuft!"
else
  err "Runner konnte nicht gestartet werden"
  journalctl -u github-runner --no-pager -n 20
  exit 1
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Runner erfolgreich eingerichtet!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Status:${NC}    systemctl status github-runner"
echo -e "  ${BOLD}Logs:${NC}      journalctl -u github-runner -f"
echo -e "  ${BOLD}Dashboard:${NC} https://github.com/${REPO}/settings/actions/runners"
echo ""
