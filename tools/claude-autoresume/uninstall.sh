#!/usr/bin/env bash
# Remove claude-autoresume. Keeps your manifest unless --purge is given.
set -euo pipefail

BIN_DIR="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"
CONF_DIR="$HOME/.config/claude-autoresume"

systemctl --user disable --now claude-autoresume.service 2>/dev/null || true
"$BIN_DIR/claude-autoresume" stop 2>/dev/null || true

rm -f "$UNIT_DIR/claude-autoresume.service"
rm -f "$BIN_DIR/claude-autoresume"
systemctl --user daemon-reload 2>/dev/null || true

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$CONF_DIR"
  echo "purged manifest at $CONF_DIR"
else
  echo "kept manifest at $CONF_DIR (use --purge to remove)"
fi
echo "uninstalled."
