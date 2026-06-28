import { shellEscape } from '../ssh/ssh-connection-utils'
import { ADB_PROGRAM } from './adb-android-devices'
import { buildScreenrecordArgs, type AndroidStreamChild, type AndroidStreamSpawner } from './android-stream-source'

// Why: for a REMOTE redroid host the H.264 byte source is `adb exec-out
// screenrecord` running remote-side; its stdout rides back on a long-lived
// SshConnection.exec channel (NOT the JSON-RPC multiplexer, NOT a port-forward).
// The exec is injected so tests feed a fake ClientChannel-like emitter and
// nothing opens a socket here. Shape matches createLocalScreenrecordSpawner so
// android-stream-source consumes both unchanged.

// Minimal slice of ssh2's ClientChannel the spawner needs: stdout/'data',
// stderr, 'close'/'error', and close(). Buffer is normalized to Uint8Array.
export type RemoteExecChannel = {
  on(event: 'data', listener: (chunk: Buffer | Uint8Array) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  stderr: { on(event: 'data', listener: (chunk: Buffer | Uint8Array) => void): unknown }
  close(): void
}

// Opens one remote exec channel for a command. In production this is
// `(cmd) => sshConnection.exec(cmd)`; the redroid host is always Linux (gated by
// availability), so the POSIX command line built with shellEscape is correct.
export type RemoteExec = (command: string) => Promise<RemoteExecChannel>

// shellEscape every token: the remote login shell parses this line, and a serial
// is attacker-influenced enough (host config) to warrant escaping.
export function buildRemoteScreenrecordCommand(serial: string): string {
  return [ADB_PROGRAM, ...buildScreenrecordArgs(serial)].map(shellEscape).join(' ')
}

function toUint8(chunk: Buffer | Uint8Array): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk)
}

function createRemoteScreenrecordChild(exec: RemoteExec, command: string): AndroidStreamChild {
  let channel: RemoteExecChannel | null = null
  let stopped = false

  async function* chunks(): AsyncGenerator<Uint8Array> {
    if (stopped) {
      return
    }
    try {
      channel = await exec(command)
    } catch {
      // Connection down (exec rejects with 'Not connected'): yield nothing so the
      // stream source treats this as a data-less restart and applies its budget,
      // rather than the error propagating out and rejecting the consumer.
      return
    }
    if (stopped) {
      channel.close()
      return
    }
    const queue: Uint8Array[] = []
    let done = false
    let wake: (() => void) | null = null
    const signal = (): void => {
      wake?.()
      wake = null
    }
    channel.on('data', (chunk) => {
      queue.push(toUint8(chunk))
      signal()
    })
    // stderr is drained but not forwarded; screenrecord warnings must not corrupt
    // the elementary stream the framer parses.
    channel.stderr.on('data', () => {})
    channel.on('error', () => {
      done = true
      signal()
    })
    channel.on('close', () => {
      done = true
      signal()
    })
    while (true) {
      while (queue.length > 0) {
        yield queue.shift() as Uint8Array
      }
      if (done || stopped) {
        return
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }

  return {
    chunks: chunks(),
    stop: () => {
      stopped = true
      channel?.close()
    }
  }
}

export function createRemoteScreenrecordSpawner(
  exec: RemoteExec,
  serial: string
): AndroidStreamSpawner {
  const command = buildRemoteScreenrecordCommand(serial)
  return () => createRemoteScreenrecordChild(exec, command)
}
