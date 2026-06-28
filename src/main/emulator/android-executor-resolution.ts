import {
  createLocalAdbExecutor,
  createRemoteAdbExecutor,
  type AdbCommandExecutor
} from './adb-command-execution'
import { localRemoteHostPlatform } from './android-host-resolution'
import type { AndroidBackendAvailability, AndroidHost } from './android-device-backend'
import { detectRemoteHostPlatform } from '../ssh/ssh-remote-platform-detection'
import type { SshConnection } from '../ssh/ssh-connection'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'

// Why: both the redroid backend (inspect/listDevices/provision/teardown) and the
// backend-agnostic input path need an adb executor + host platform for a host.
// Resolving them in one injectable place keeps the local-spawn vs remote-SSH
// dispatch single-sourced and nothing connects at import time.
export type AndroidExecutorDeps = {
  // Connected SshConnection for a stored target id, or null when none.
  getConnection?: (targetId: string) => SshConnection | null
  detectHostPlatform?: (conn: SshConnection) => Promise<RemoteHostPlatform | null>
  localHostPlatform?: () => RemoteHostPlatform | null
  createLocalExecutor?: () => AdbCommandExecutor
  createRemoteExecutor?: (conn: SshConnection) => AdbCommandExecutor
}

export type ResolvedAndroidExecutor =
  | { ok: true; executor: AdbCommandExecutor; hostPlatform: RemoteHostPlatform }
  | { ok: false; availability: AndroidBackendAvailability }

// Stable id so registry serials and container `orca.host` labels never collide
// across two remote hosts that both expose 127.0.0.1:5555.
export function hostIdForHost(host: AndroidHost): string {
  return host.mode === 'remote' ? host.sshTargetId : 'local'
}

export async function resolveAndroidExecutor(
  host: AndroidHost,
  deps: AndroidExecutorDeps
): Promise<ResolvedAndroidExecutor> {
  if (host.mode === 'remote') {
    const conn = deps.getConnection?.(host.sshTargetId) ?? null
    if (!conn || conn.getState().status !== 'connected') {
      return unreachable('The configured SSH host for remote Android is not connected.')
    }
    const detect = deps.detectHostPlatform ?? detectRemoteHostPlatform
    const hostPlatform = await detect(conn)
    if (!hostPlatform) {
      return unreachable('Could not detect the remote host platform over SSH.')
    }
    const make = deps.createRemoteExecutor ?? createRemoteAdbExecutor
    return { ok: true, executor: make(conn), hostPlatform }
  }
  const hostPlatform = (deps.localHostPlatform ?? defaultLocalHostPlatform)()
  if (!hostPlatform) {
    return {
      ok: false,
      availability: {
        ok: false,
        reason: 'host_not_linux',
        message: 'This host is not a supported Linux redroid host.'
      }
    }
  }
  const make = deps.createLocalExecutor ?? createLocalAdbExecutor
  return { ok: true, executor: make(), hostPlatform }
}

function unreachable(message: string): ResolvedAndroidExecutor {
  return { ok: false, availability: { ok: false, reason: 'ssh_unreachable', message } }
}

function defaultLocalHostPlatform(): RemoteHostPlatform | null {
  return localRemoteHostPlatform(process.platform, process.arch)
}
