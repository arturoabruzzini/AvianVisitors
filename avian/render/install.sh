#!/usr/bin/env bash
# Installs headless Chromium and the 15-minute render timer. Idempotent; run as
# root (install_services.sh does, or `sudo avian/render/install.sh`).
set -euo pipefail

RUN_USER="${SUDO_USER:-$USER}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
RENDER_DIR="$(cd "$(dirname "$0")" && pwd)"

apt-get install -y --no-install-recommends chromium-headless-shell

cat > /etc/systemd/system/birdnet-render.service <<UNIT
[Unit]
Description=Render the round bird collage for the watch tile and phone widget
After=caddy.service
[Service]
Type=oneshot
User=$RUN_USER
Environment=HOME=$RUN_HOME
Nice=10
# Backstop for render-round.sh's own 60 s timeout.
TimeoutStartSec=120
ExecStart=$RENDER_DIR/render-round.sh
UNIT

cat > /etc/systemd/system/birdnet-render.timer <<UNIT
[Unit]
Description=Render the round bird collage every 15 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now birdnet-render.timer
