import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// Why: the target trio (plus kind) is repeated across every emulator command;
// hoisting it makes threading a new target dimension (kind) a single edit.
const EMULATOR_TARGET_FLAGS = ['kind', 'device', 'emulator', 'worktree']

export const EMULATOR_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['emulator', 'list'],
    summary: 'List available/running emulators (Orca-managed + raw serve-sim)',
    usage: 'orca emulator list [--kind <ios|android>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...EMULATOR_TARGET_FLAGS]
  },
  {
    path: ['emulator', 'attach'],
    summary: 'Attach/start helper for a device and make it active for the worktree',
    usage:
      'orca emulator attach [device] [--kind <ios|android>] [--worktree <selector>] [--focus] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...EMULATOR_TARGET_FLAGS, 'focus'],
    positionalArgs: ['device']
  },
  {
    path: ['emulator', 'tap'],
    summary: 'Tap at normalized 0..1 coords (preferred for single taps)',
    usage: 'orca emulator tap <x> <y> [--device <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...EMULATOR_TARGET_FLAGS, 'x', 'y'],
    positionalArgs: ['x', 'y']
  },
  {
    path: ['emulator', 'type'],
    summary: 'Type text (US ASCII only)',
    usage: 'orca emulator type <text> [--device <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...EMULATOR_TARGET_FLAGS, 'text'],
    positionalArgs: ['text']
  },
  {
    path: ['emulator', 'gesture'],
    summary: 'Send a multi-point gesture sequence',
    usage: "orca emulator gesture '<json>' [--device <id>] [--worktree <selector>] [--json]",
    allowedFlags: [...GLOBAL_FLAGS, ...EMULATOR_TARGET_FLAGS, 'points'],
    positionalArgs: ['points']
  },
  {
    path: ['emulator', 'button'],
    summary: 'Hardware button (home, side_button, etc.)',
    usage: 'orca emulator button <name> [--device <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...EMULATOR_TARGET_FLAGS, 'name'],
    positionalArgs: ['name']
  },
  {
    path: ['emulator', 'rotate'],
    summary: 'Rotate device',
    usage: 'orca emulator rotate <orientation> [--device <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...EMULATOR_TARGET_FLAGS, 'orientation'],
    positionalArgs: ['orientation']
  },
  {
    path: ['emulator', 'exec'],
    summary:
      'Raw passthrough (e.g. orca emulator exec --command "tap 0.5 0.7" or "ca-debug blended on")',
    usage: 'orca emulator exec --command <cmd> [--device <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...EMULATOR_TARGET_FLAGS, 'command']
  },
  {
    path: ['emulator', 'kill'],
    summary: 'Stop helper for device',
    usage: 'orca emulator kill [--device <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...EMULATOR_TARGET_FLAGS]
  },
  {
    path: ['emulator', 'shutdown'],
    summary: 'Stop helper and shut down the simulator device',
    usage:
      'orca emulator shutdown [--device <id>] [--emulator <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...EMULATOR_TARGET_FLAGS]
  }
]
