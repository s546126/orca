import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const BROWSER_CDP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['cdp', 'views'],
    summary: 'List Orca browser views that can expose a view-scoped CDP endpoint',
    usage: 'orca cdp views [--worktree <selector|all>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['cdp', 'connect'],
    summary: 'Start a view-scoped CDP gateway for Playwright, Browser Use, or Chrome DevTools MCP',
    usage: 'orca cdp connect [--worktree <selector>] [--view <selector>] [--page <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'view', 'page'],
    notes: [
      'Binds 127.0.0.1 only on the machine running Orca. Remote/SSH agents should keep using orca snapshot/click.',
      'Target.createTarget, Target.activateTarget, Page.bringToFront, and Target.closeTarget stay in sync with Orca browser tabs.',
      'Browser.close disconnects the automation client without quitting Orca or Chromium.'
    ],
    examples: [
      'orca cdp views --json',
      'orca cdp connect --worktree active --json',
      'npx @playwright/mcp@latest --cdp-endpoint=<cdpHttpUrl>'
    ]
  },
  {
    path: ['cdp', 'stop'],
    summary: 'Stop the view-scoped CDP gateway for a worktree',
    usage: 'orca cdp stop [--worktree <selector>] [--view <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'view']
  }
]
