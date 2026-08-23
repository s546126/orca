---
name: orca-browser-cdp
description: >-
  Connect Playwright, Browser Use, Playwright MCP, or Chrome DevTools MCP to
  the Chromium view already rendered inside Orca. Use when the user wants
  Browser Use, Playwright, Chrome DevTools MCP, or another CDP client to
  control Orca's visible browser instead of launching a hidden browser.
---

# Orca Browser CDP

Use this skill when the user wants Playwright, Browser Use, Chrome DevTools MCP,
or another CDP client to control the browser visible in Orca.

Do not launch a second Chromium. Orca already owns the live pane. Discover the
view, then attach to its localhost CDP gateway.

```bash
command -v orca || command -v orca-ide
orca cdp views --json
```

Select the intended view from `viewId`, `worktreeId`, URL, title, and `tabs`.
Never guess when more than one view is present. Connect with:

```bash
orca cdp connect --worktree id:<viewId> --json
# or
orca cdp connect --view id:<viewId> --json
```

The response contains a view-scoped `cdpHttpUrl`, `browserWsUrl`, and the
currently active target. Use the browser-level endpoint so the automation tool
can create, inspect, select, and close multiple tabs in that view.

Standard CDP `Target.createTarget`, `Target.activateTarget`,
`Page.bringToFront`, and `Target.closeTarget` operations synchronize with the
Orca tab strip. A tool that changes only its own internal selected-page state
must also bring that page to front; local tool state is not observable through
CDP.

Tool bootstrap:

- Browser Use: set `BU_CDP_URL` to `cdpHttpUrl` or `BU_CDP_WS` to `browserWsUrl`.
- Playwright: call `chromium.connectOverCDP(cdpHttpUrl)`.
- Playwright MCP: pass `--cdp-endpoint=<cdpHttpUrl>`.
- Chrome DevTools MCP: pass `--browser-url=<cdpHttpUrl>`.

The JSON result also includes ready-to-run `snippets` for those tools.

Orca owns Chromium lifecycle. Closing a connected automation client disconnects
it from the gateway without terminating Chromium or quitting Orca. Closing the
Orca browser pane closes that view's tabs; `orca cdp stop --worktree <selector>`
stops the gateway.

The gateway binds `127.0.0.1` only on the machine running the Orca app. Remote
or SSH agents cannot attach Playwright to that localhost port; they should keep
using `orca snapshot` / `orca click` from the `orca-cli` skill.
