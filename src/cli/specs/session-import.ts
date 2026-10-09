import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const SESSION_IMPORT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'import'],
    summary: 'Copy Codex or Pi session logs into Orca so they can be opened and continued',
    usage:
      'orca session import --harness <codex|pi> [--path <file-or-dir>]... [--session <id>]... [--workspace <id>] [--workspace-kind <git-worktree|folder>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'harness', 'path', 'session', 'workspace', 'workspace-kind'],
    repeatableFlags: ['path', 'session'],
    notes: [
      'Reads logs only when you run this command. It does not watch for new sessions and it does not send anything over the network.',
      'With no --path, Orca looks in the default Codex (~/.codex/sessions) or Pi (~/.pi/agent/sessions) directory on the selected Orca host.',
      'Running it again for the same log does not create a second Orca session.',
      'A Codex log is continued inside Orca only when you pass --workspace for the folder that log was working in. Otherwise it is saved as history and the reason is printed.',
      'A Pi log Orca can map is continued by opening that Pi session. A log with tool or role gaps is saved as history only.',
      '--path and --session may be repeated. Paths are on the selected Orca host, not on another computer.'
    ],
    examples: [
      'orca session import --harness codex --workspace repo::/home/me/repo',
      'orca session import --harness pi --path ~/.pi/agent/sessions',
      'orca session import --harness codex --path ~/.codex/sessions/2026/05/01/rollout.jsonl --session 019f0000-1111-7222-8333-444444444444 --workspace repo::/home/me/repo --json'
    ]
  }
]
