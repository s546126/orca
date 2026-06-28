#!/bin/bash
# Runs as the agent user. Proves (A) launcher portability on a clean machine via
# a direct `start`, and (B) the real systemd-user unit path if the user manager
# is reachable. Emits PASS/FAIL markers the host grep-checks.
set -uo pipefail
BIN="$HOME/.local/bin/claude-autoresume"
fail=0
mark() { echo "VERIFY:$1"; }

echo "===== install toolkit into clean HOME ($HOME) ====="
cp -r /opt/claude-autoresume-src "$HOME/claude-autoresume"
"$HOME/claude-autoresume/install.sh" >/dev/null 2>&1 || true   # daemon-reload may warn until bus is up
cat > "$HOME/.config/claude-autoresume/sessions.json" <<'JSON'
{ "options": { "net_wait_seconds": 2, "stagger_seconds": 3 },
  "sessions": [ { "cwd": "/home/agent/proj", "session": "latest", "mode": "reopen", "host": "tmux", "enabled": true } ] }
JSON
chmod 600 "$HOME/.config/claude-autoresume/sessions.json"

echo "===== A) doctor on clean machine ====="
if "$BIN" doctor 2>&1 | tee /tmp/doctor.out | tail -3; then :; fi
grep -q 'doctor: PASS' /tmp/doctor.out && mark "DOCTOR_PASS" || { mark "DOCTOR_FAIL"; fail=1; }

echo "===== A) direct launcher start (no systemd) ====="
"$BIN" start 2>&1 | tee /tmp/start.out
grep -q 'done: enabled=1 launched=1 live=1' /tmp/start.out && mark "DIRECT_LAUNCH_OK" || { mark "DIRECT_LAUNCH_FAIL"; fail=1; }
if ! grep -q '\[!!\]' /tmp/start.out; then mark "NO_FALSE_WARN"; else mark "UNEXPECTED_WARN"; fail=1; fi
echo "--- live sessions ---"; tmux -L claude-autoresume ls 2>&1
tmux -L claude-autoresume capture-pane -p -t car-proj 2>/dev/null | grep -qi 'STUB CLAUDE RESUMED' && mark "PANE_RESUMED" || { mark "PANE_EMPTY"; fail=1; }
echo "--- idempotent re-run ---"
reout="$("$BIN" start 2>&1)"; echo "$reout" | grep -E 'already running|done:'
echo "$reout" | grep -q "already running" && mark "IDEMPOTENT_OK" || { mark "IDEMPOTENT_FAIL"; fail=1; }
"$BIN" stop >/dev/null 2>&1; sleep 1
tmux -L claude-autoresume ls >/dev/null 2>&1 && { mark "STOP_FAIL"; fail=1; } || mark "STOP_OK"

echo "===== B) real systemd-user unit path ====="
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
busok=0
for i in $(seq 1 30); do [ -S "$XDG_RUNTIME_DIR/bus" ] && { busok=1; break; }; sleep 1; done
if [ "$busok" = 1 ] && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemd-analyze --user verify "$HOME/.config/systemd/user/claude-autoresume.service" 2>&1 && mark "UNIT_VERIFY_OK" || mark "UNIT_VERIFY_WARN"
  systemctl --user start claude-autoresume.service
  state="$(systemctl --user show claude-autoresume.service -p ActiveState,SubState,Result --no-pager | tr '\n' ' ')"
  echo "unit state: $state"
  sleep 5
  echo "--- SURVIVAL: tmux session alive after oneshot ExecStart returned? ---"
  if tmux -L claude-autoresume ls 2>&1 | grep -q '^car-proj'; then mark "SYSTEMD_SURVIVAL_OK"; else mark "SYSTEMD_SURVIVAL_FAIL"; fail=1; fi
  systemctl --user status claude-autoresume.service --no-pager 2>/dev/null | grep -E 'Active:|CGroup:|tmux|sleep 3600' | head -6
  systemctl --user stop claude-autoresume.service; sleep 2
  tmux -L claude-autoresume ls >/dev/null 2>&1 && { mark "SYSTEMD_STOP_FAIL"; fail=1; } || mark "SYSTEMD_STOP_OK"
else
  mark "SYSTEMD_USER_BUS_UNAVAILABLE"; fail=1
  echo "(user manager not reachable in this container; static unit check instead)"
  systemd-analyze verify "$HOME/.config/systemd/user/claude-autoresume.service" 2>&1 || true
fi

echo "===== RESULT ====="
[ "$fail" = 0 ] && echo "OVERALL: PASS" || echo "OVERALL: FAIL"
