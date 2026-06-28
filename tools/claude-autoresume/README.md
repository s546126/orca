# claude-autoresume

Relaunch Claude Code sessions automatically after a **machine reboot**, triggered
on boot by a **systemd user service**. Designed and verified on a headless Linux
host (Oracle Linux 9, aarch64), and re-verified end-to-end on a clean AlmaLinux 9
container (see [`verify/`](./verify)).

## What it does

On boot, a oneshot systemd **user** service runs `claude-autoresume start`, which
reads a declarative manifest (`~/.config/claude-autoresume/sessions.json`) and, for
each enabled entry, re-opens the prior Claude conversation inside its own **detached
tmux pane**. tmux gives each session a real PTY, so the interactive TUI — and the
`/loop` / scheduler machinery your autonomous sessions rely on — resumes exactly as
it was before the reboot. You can `attach` later (over SSH or Orca) to watch.

```text
boot ──▶ systemd user manager (lingering) ──▶ claude-autoresume.service (oneshot)
                                                   │
                                                   ├─ wait for outbound :443
                                                   └─ for each enabled manifest entry:
                                                        tmux -L claude-autoresume new-session -d
                                                          └─ env -i HOME PATH TERM claude --resume … --dangerously-skip-permissions
```

## Why these specific choices (each was verified, not assumed)

| Decision | Reason found on this host |
| --- | --- |
| **systemd *user* service**, `WantedBy=default.target` | Lingering is already on (`loginctl … Linger=yes`), so user services start at boot with no login. Mirrors the existing `hermes-gateway.service`. No `sudo` needed. |
| **Minimal `Environment=` (HOME + PATH)** | A boot service gets a stripped env. Verified `env -i HOME=/home/opc PATH=/home/opc/.local/bin:/usr/bin claude -p --continue` resumes correctly. Credentials are a file (`~/.claude/.credentials.json`), resolved via `HOME` — no keyring. |
| **tmux short named socket (`-L`)** | A long `-S <path>` socket hits the 104-char UNIX-socket limit (hit it during testing). `-L claude-autoresume` lives under `/tmp/tmux-<uid>/` and is isolated from your interactive tmux. |
| **Trust pre-check / `auto_trust`** | Interactive resume **hangs** on the “Do you trust this folder?” prompt, and `--dangerously-skip-permissions` does **not** dismiss it. Untrusted cwds are skipped (or pre-seeded into `~/.claude.json`), never launched-and-hung. Already-trusted project cwds resume without prompting. |
| **`--continue` / `--resume <uuid>`** lets claude resolve sessions | The cwd→session-dir encoding folds `/ . _` → `-` (lossy: `crack_chefrobot` and `crack-chefrobot` collide), so the launcher never reconstructs it for launch. Pinned UUIDs are shape-checked and validated **within the cwd's own** project dir (`claude --resume` is cwd-scoped). |
| **Post-launch liveness check** | `tmux new-session` returns 0 even if claude immediately dies. After the stagger, each pane is re-checked: a vanished pane (crash / nothing to resume / rejected prompt) or one parked on a known gate is logged as `[!!]`, and `done: enabled=K launched=<K` flags a shortfall. Silent boot failures become loud journal lines. |
| **`RemainAfterExit` + `KillMode=process`** | The launcher daemonizes tmux servers and exits; these keep a completing oneshot from tearing them down. `systemctl stop`/`restart` is an intentional teardown — `ExecStop` runs `stop` (tmux `kill-server`) to end the sessions on purpose. |
| **`After=network.target` is a no-op; the launcher polls `:443`** | In the *user* manager `network.target` imposes no real ordering, so the launcher itself waits for outbound 443 before launching. Staggering (default 8s) keeps boot from slamming the API + ARM CPU with N simultaneous resumes. |
| **`--` before continuation prompts; skip missing/untrusted cwds** | `--` stops a prompt that starts with `-` being parsed as a flag. One session dir (`crack-chefrobot`) has no live project dir; dead and untrusted cwds are skipped with a warning rather than launched-and-hung. |

## Install

```sh
tools/claude-autoresume/install.sh    # copies bin + unit + sample manifest; does NOT enable
```

Then:

```sh
$EDITOR ~/.config/claude-autoresume/sessions.json   # flip entries to "enabled": true
claude-autoresume doctor                            # preflight (env, trust, lingering, resume probe)
claude-autoresume trust                             # seed folder-trust for manifest cwds
claude-autoresume enable --yes                      # activate boot auto-resume
```

Nothing runs on boot until `enable --yes`. The sample manifest ships every entry as
`enabled: false`.

## Manifest (`sessions.json`)

```jsonc
{
  "options": {
    "work_path": "/home/opc/.local/bin:/usr/local/bin:/usr/bin:/bin", // PATH given to resumed agents
    "net_wait_seconds": 60,   // wait for outbound :443 before launching
    "stagger_seconds": 8,     // gap between launches (also the liveness-check delay)
    "auto_trust": false,      // true = pre-seed trust for untrusted cwds instead of skipping
    "print_timeout_seconds": 600  // cap for a host:"print" resume turn
  },
  "sessions": [
    {
      "cwd":     "/home/opc/orca/projects/medialib",
      "session": "latest",          // "latest" = newest conversation for the cwd, or a pinned UUID
      "mode":    "reopen",          // "reopen" = idle TUI; "continue" = resume + auto-submit `prompt`
      "prompt":  "",                // only used by mode:"continue"
      "host":    "tmux",            // "tmux" = attachable PTY session; "print" = one-shot headless
      "enabled": true
    }
  ]
}
```

- **`session: "latest"`** vs a pinned UUID — pin when a project has several sessions
  (e.g. medialib has 3) and you want determinism; `latest` picks newest-by-mtime.
- **`mode: "reopen"`** just re-opens the conversation idle (no new turn — matches the
  in-repo resume-evidence guidance). **`mode: "continue"`** also submits `prompt`, which
  is what restarts an autonomous loop.
- **`host: "tmux"`** for long-running/observable sessions; **`host: "print"`** for a
  fire-and-forget single continuation turn logged to the journal.

## Operate

```sh
claude-autoresume status            # manifest + live sessions + unit state
claude-autoresume attach medialib   # watch a resumed session (detach: Ctrl-b d)
claude-autoresume start             # relaunch now (idempotent; skips already-live)
claude-autoresume stop              # kill all auto-resume sessions
journalctl --user -u claude-autoresume.service -b   # boot logs
```

## Security

Enabling this makes every boot relaunch agents with
`--dangerously-skip-permissions`. That is a real posture change: anything in those
sessions' continuation prompts runs unattended with no permission gate. Keep the
manifest tight, prefer `mode: "reopen"` unless a session genuinely needs to keep
working, and review `claude-autoresume status` before `enable --yes`.

## Portability (other OSes)

The mechanism is identical elsewhere; only the boot trigger changes:

- **macOS** — a LaunchAgent (`~/Library/LaunchAgents/com.user.claude-autoresume.plist`)
  with `RunAtLoad` + `KeepAlive:false`, `ProgramArguments` = the same launcher. tmux/jq
  via Homebrew; creds path is identical.
- **Windows** — Task Scheduler task “At startup” running `wsl claude-autoresume start`
  (under WSL) or a PowerShell shim; replace tmux with a detached `wt`/`conhost` or use
  `host: "print"`. Paths via the WSL home.

The launcher, manifest schema, and resume commands are unchanged across platforms — the
only OS-specific files are the boot-trigger unit and the tmux/PTY host.
