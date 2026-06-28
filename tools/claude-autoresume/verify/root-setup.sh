#!/bin/bash
# Runs as root inside the booted container: provision the agent's clean HOME so
# the toolkit has a stub claude, creds, a trusted project, and a session file.
set -uo pipefail
H=/home/agent
install -d -o agent -g agent "$H/.local/bin" "$H/.claude" "$H/proj"
install -m 0755 -o agent -g agent /usr/local/stub/claude "$H/.local/bin/claude"
install -m 0600 -o agent -g agent /dev/stdin "$H/.claude/.credentials.json" <<< '{"stub":true}'
install -m 0600 -o agent -g agent /dev/stdin "$H/.claude.json" <<< '{"projects":{"/home/agent/proj":{"hasTrustDialogAccepted":true}}}'
# a dummy session file under the encoded project dir (so `--continue` has a target)
enc="$(printf '%s' /home/agent/proj | sed 's#[/._]#-#g')"
install -d -o agent -g agent "$H/.claude/projects/$enc"
install -m 0644 -o agent -g agent /dev/stdin "$H/.claude/projects/$enc/00000000-0000-0000-0000-000000000000.jsonl" <<< '{"type":"summary"}'
systemctl start systemd-logind.service 2>/dev/null
loginctl enable-linger agent
# wait for the user manager bus so the agent test can drive systemctl --user
for i in $(seq 1 20); do [ -S /run/user/1000/bus ] && break; sleep 1; done
echo "[root-setup] done; lingering: $(loginctl show-user agent 2>/dev/null | grep -i Linger); user@1000: $(systemctl is-active user@1000.service 2>/dev/null)"
