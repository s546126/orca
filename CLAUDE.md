@AGENTS.md

## ⛔ Hard constraint: do NOT run redroid / Android emulator on this host (opc)

This worktree runs on **opc** — a headless Oracle Cloud ARM (aarch64) instance with **no GPU**.
redroid / Android emulators DO NOT WORK here and have repeatedly **crashed and rebooted the whole
host**: Android SurfaceFlinger needs a GPU, `gpu_mode=guest` software rendering still crash-loops,
and the kernel `binder` driver faults take the box down. Every such reboot also resets the Orca
pairing token and drops all remote sessions.

Therefore, on opc:
- **Never** `docker run ... redroid/redroid` (or anbox / waydroid / qemu-android / any Android emulator).
- Do NOT start, restart, or "fix" `orca-redroid-fg` or any Android-emulator container.
- Android device-support work that needs a *running* Android image must target a machine with a GPU
  or a real device — NOT this headless host. On opc, keep to code / static / non-emulator work only.
