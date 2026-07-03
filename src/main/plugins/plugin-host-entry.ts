/**
 * Child-process entry for the out-of-process plugin host. Forked with
 * ELECTRON_RUN_AS_NODE, so this file must stay plain Node — no electron
 * imports (directly or transitively). All logic lives in
 * `plugin-host-runtime.ts`; this file only wires the fork IPC channel.
 */
import { createPluginHostRuntime } from './plugin-host-runtime'
import type { PluginHostChildMessage } from '../../shared/plugins/plugin-host-protocol'

function sendToParent(message: PluginHostChildMessage): void {
  process.send?.(message)
}

const runtime = createPluginHostRuntime({ send: sendToParent })

process.on('message', (raw: unknown) => {
  void runtime.handleMessage(raw)
})

// Why: third-party plugin code runs here; an escaped rejection must not leave
// a zombie host. Report the crash so the parent can mark the plugin errored.
function dieFatally(error: unknown): void {
  try {
    sendToParent({
      type: 'fatal',
      error: error instanceof Error ? (error.stack ?? error.message) : String(error)
    })
  } catch {
    // Channel already gone; nothing left to report to.
  }
  process.exit(1)
}

process.on('uncaughtException', dieFatally)
process.on('unhandledRejection', dieFatally)

// Why: if the parent dies without sending shutdown, the IPC channel closes;
// exit instead of lingering as an orphaned Node process.
process.on('disconnect', () => {
  process.exit(0)
})
