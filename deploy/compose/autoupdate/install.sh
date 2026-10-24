#!/usr/bin/env bash
# Turns on automatic updates for this server's Brio (Linux with systemd): every 5 minutes, brio-update.sh checks the
# branch on GitHub and updates when it moved (downloading ready-made images, or rebuilding, as .env says). Run once
# with sudo from deploy/compose/autoupdate:
#   sudo ./install.sh            turn on
#   sudo ./install.sh --remove   turn off
# Logs: journalctl -u brio-update --since today
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
user="${SUDO_USER:-$(stat -c %U "$here")}"
if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now brio-update.timer 2>/dev/null || true
  rm -f /etc/systemd/system/brio-update.service /etc/systemd/system/brio-update.timer
  systemctl daemon-reload
  echo "automatic updates are off"
  exit 0
fi
chmod +x "$here/brio-update.sh"
cat > /etc/systemd/system/brio-update.service <<UNIT
[Unit]
Description=Update Brio to the newest commit
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
User=$user
ExecStart=$here/brio-update.sh
UNIT
cat > /etc/systemd/system/brio-update.timer <<UNIT
[Unit]
Description=Check for a new Brio every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now brio-update.timer
echo "automatic updates are on for $user: every 5 minutes. Logs: journalctl -u brio-update --since today"
