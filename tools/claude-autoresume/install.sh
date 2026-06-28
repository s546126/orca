#!/usr/bin/env bash
# Install claude-autoresume into the user's systemd/bin/config locations.
# Idempotent. Does NOT enable boot auto-resume (that is a deliberate, gated step).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"
CONF_DIR="$HOME/.config/claude-autoresume"

mkdir -p "$BIN_DIR" "$UNIT_DIR"
# 0700: the manifest can hold continuation prompts that run unattended.
mkdir -p "$CONF_DIR"; chmod 0700 "$CONF_DIR"

install -m 0755 "$SRC/bin/claude-autoresume" "$BIN_DIR/claude-autoresume"
install -m 0644 "$SRC/systemd/claude-autoresume.service" "$UNIT_DIR/claude-autoresume.service"

if [ -f "$CONF_DIR/sessions.json" ]; then
  echo "keep: $CONF_DIR/sessions.json (existing manifest left untouched)"
else
  install -m 0600 "$SRC/sessions.json" "$CONF_DIR/sessions.json"
  echo "wrote: $CONF_DIR/sessions.json (sample — every entry is enabled:false)"
fi

systemctl --user daemon-reload

if ! loginctl show-user "$(id -un)" 2>/dev/null | grep -q 'Linger=yes'; then
  echo "WARNING: systemd lingering is OFF; user services will NOT start at boot."
  echo "         enable with:  loginctl enable-linger $(id -un)"
fi

cat <<EOF

installed:
  $BIN_DIR/claude-autoresume
  $UNIT_DIR/claude-autoresume.service
  $CONF_DIR/sessions.json

next:
  1) edit  $CONF_DIR/sessions.json   (flip the sessions you want to enabled:true)
  2) run   claude-autoresume doctor   (preflight checks)
  3) run   claude-autoresume trust    (avoid the folder-trust boot hang)
  4) run   claude-autoresume enable --yes   (activate boot auto-resume)

nothing auto-runs until step 4.
EOF
