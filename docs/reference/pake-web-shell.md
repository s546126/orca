# Optional Pake web-shell

Pake ([tw93/Pake](https://github.com/tw93/Pake) / `pake-cli`) wraps a webpage or a static web build in a Tauri system-webview window. It is **not** a replacement for the Electron desktop app.

## What stays on Electron

`pnpm run build:linux` / AppImage / electron-builder remain the supported desktop product. Daemon, PTY (`node-pty`), native modules, and the packaged `orca` CLI only exist in that Electron build.

## What `build:pake` is

After `pnpm run build:web`, `pnpm run build:pake` is an optional experiment that:

1. Stages `out/web` (Vite emits `web-index.html`) into `out/pake-web` with `index.html` at the root. Pake can only pack a static directory that has `index.html`, and only hash routing.
2. Runs `pake-cli --json --config config/pake.config.json`.
3. Checks the machine-readable `outputs[]` list for a Linux AppImage. Deb is requested too (`appimage,deb`); Linux multi-target builds may omit a format and put the failure in `warnings`.

The app name is **Orca**. The bundle id is `com.stablyai.orca.web-shell` so it does not collide with the Electron `com.stablyai.orca` updater.

## Serve URL

To wrap a running `orca serve` pairing page instead of the static build:

```bash
ORCA_PAKE_URL=http://127.0.0.1:6768/web-index.html pnpm run build:pake
```

The serve URL can keep pathname routing (`/web-index.html`). Local-directory packaging cannot.

## Requirements

- Node 18+
- Rust (pake-cli will offer to install it)
- `npx pake-cli` (not a workspace dependency)

This path is optional. A missing Rust toolchain or a failed deb target must not block Electron packaging.
