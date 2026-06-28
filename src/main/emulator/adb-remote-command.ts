import type { ClientChannel } from 'ssh2'
import type { SshConnection } from '../ssh/ssh-connection'
import { shellEscape } from '../ssh/ssh-connection-utils'
import type { AdbCommandExecutor, AdbCommandResult } from './adb-command-execution'

// Why: remote redroid runs adb/docker/probe commands remote-side over the SAME
// SshConnection.exec channel the rest of Orca uses — not the JSON-RPC
// multiplexer, and with no port-forward. The redroid host is always Linux
// (gated by android-availability before any adb/docker call), so a POSIX command
// line built with shellEscape is the correct dialect here.
export function createRemoteAdbExecutor(connection: SshConnection): AdbCommandExecutor {
  return {
    mode: 'remote',
    async exec(program: string, args: string[]): Promise<AdbCommandResult> {
      const command = [program, ...args].map(shellEscape).join(' ')
      const channel = await connection.exec(command)
      return collectChannelOutput(channel)
    }
  }
}

function collectChannelOutput(channel: ClientChannel): Promise<AdbCommandResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (exitCode: number | null): void => {
      if (settled) {
        return
      }
      settled = true
      resolve({ stdout, stderr, exitCode, spawnError: false })
    }
    channel.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    channel.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    channel.on('error', (error: Error) => {
      stderr += error.message
      settle(null)
    })
    // ssh2 delivers the remote exit status on 'close' (code is null on signal).
    channel.on('close', (code: number | null) => {
      settle(typeof code === 'number' ? code : null)
    })
  })
}
