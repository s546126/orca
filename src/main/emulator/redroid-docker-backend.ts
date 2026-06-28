import { EmulatorError } from './android-errors'
import {
  createLocalAdbExecutor,
  createRemoteAdbExecutor,
  type AdbCommandExecutor
} from './adb-command-execution'
import { listAdbDevices } from './adb-android-devices'
import { inspectAndroidAvailability } from './android-availability'
import { localRemoteHostPlatform } from './android-host-resolution'
import type {
  AndroidBackendAvailability,
  AndroidDeviceBackend,
  AndroidDeviceSummary,
  AndroidHost,
  AndroidProvisionTarget,
  AndroidStreamHandle
} from './android-device-backend'
import { detectRemoteHostPlatform } from '../ssh/ssh-remote-platform-detection'
import type { SshConnection } from '../ssh/ssh-connection'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'

// Why: every dependency that touches a process/socket is injected so inspect()
// and listDevices() run against mocked executors in tests and never spawn here.
export type RedroidDockerBackendDeps = {
  // Connected SshConnection for a stored target id, or null when none.
  getConnection?: (targetId: string) => SshConnection | null
  detectHostPlatform?: (conn: SshConnection) => Promise<RemoteHostPlatform | null>
  localHostPlatform?: () => RemoteHostPlatform | null
  createLocalExecutor?: () => AdbCommandExecutor
  createRemoteExecutor?: (conn: SshConnection) => AdbCommandExecutor
}

type ResolvedExecutor =
  | { ok: true; executor: AdbCommandExecutor; hostPlatform: RemoteHostPlatform }
  | { ok: false; availability: AndroidBackendAvailability }

const DOCKER_PROGRAM = 'docker'
// Format keeps fields tab-separated so the pure parser needs no docker-version
// quirks; `orca.session` is the label provision() will stamp on each container.
function buildSessionPsArgs(): string[] {
  return ['ps', '--filter', 'label=orca.session', '--format', '{{.ID}}\t{{.Names}}\t{{.Labels}}']
}

type RedroidContainer = { containerId: string; name: string; sessionId?: string }

export function parseDockerSessionContainers(stdout: string): RedroidContainer[] {
  const containers: RedroidContainer[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) {
      continue
    }
    const [containerId, name = '', labels = ''] = line.split('\t')
    if (!containerId) {
      continue
    }
    containers.push({ containerId, name, sessionId: parseLabel(labels, 'orca.session') })
  }
  return containers
}

function parseLabel(labels: string, key: string): string | undefined {
  for (const pair of labels.split(',')) {
    const idx = pair.indexOf('=')
    if (idx > 0 && pair.slice(0, idx) === key) {
      return pair.slice(idx + 1)
    }
  }
  return undefined
}

export class RedroidDockerBackend implements AndroidDeviceBackend {
  readonly id = 'redroid-docker' as const

  constructor(private readonly deps: RedroidDockerBackendDeps = {}) {}

  async inspect(host: AndroidHost): Promise<AndroidBackendAvailability> {
    const resolved = await this.resolveExecutor(host)
    if (!resolved.ok) {
      return resolved.availability
    }
    return inspectAndroidAvailability({
      executor: resolved.executor,
      hostPlatform: resolved.hostPlatform,
      // redroid auto-selects the host-matched image, so default is no mismatch.
      imageArch: resolved.hostPlatform.arch
    })
  }

  async listDevices(host: AndroidHost): Promise<AndroidDeviceSummary[]> {
    const resolved = await this.resolveExecutor(host)
    if (!resolved.ok) {
      return []
    }
    const devices = await listAdbDevices(resolved.executor)
    const containers = parseDockerSessionContainers(
      (await resolved.executor.exec(DOCKER_PROGRAM, buildSessionPsArgs())).stdout
    )
    const summaries: AndroidDeviceSummary[] = devices.map((device) => ({
      serial: device.serial,
      state: device.state,
      kind: 'android'
    }))
    const seen = new Set(summaries.map((summary) => summary.serial))
    // Surface managed containers that have no adb entry yet (still booting).
    for (const container of containers) {
      if (container.sessionId && !seen.has(container.name)) {
        summaries.push({
          serial: container.name,
          state: 'container',
          kind: 'android',
          sessionId: container.sessionId,
          containerId: container.containerId
        })
      }
    }
    return summaries
  }

  private async resolveExecutor(host: AndroidHost): Promise<ResolvedExecutor> {
    if (host.mode === 'remote') {
      const conn = this.deps.getConnection?.(host.sshTargetId) ?? null
      if (!conn || conn.getState().status !== 'connected') {
        return {
          ok: false,
          availability: {
            ok: false,
            reason: 'ssh_unreachable',
            message: 'The configured SSH host for remote Android is not connected.'
          }
        }
      }
      const detect = this.deps.detectHostPlatform ?? detectRemoteHostPlatform
      const hostPlatform = await detect(conn)
      if (!hostPlatform) {
        return {
          ok: false,
          availability: {
            ok: false,
            reason: 'ssh_unreachable',
            message: 'Could not detect the remote host platform over SSH.'
          }
        }
      }
      const make = this.deps.createRemoteExecutor ?? createRemoteAdbExecutor
      return { ok: true, executor: make(conn), hostPlatform }
    }
    const hostPlatform = (this.deps.localHostPlatform ?? defaultLocalHostPlatform)()
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
    const make = this.deps.createLocalExecutor ?? createLocalAdbExecutor
    return { ok: true, executor: make(), hostPlatform }
  }

  async provision(
    _target: AndroidProvisionTarget
  ): Promise<{ serial: string; host: AndroidHost; hostId: string }> {
    throw new EmulatorError(
      'emulator_redroid_unreachable',
      'TODO: redroid container provisioning is not implemented (Phase 3).'
    )
  }

  async startStream(_serial: string, _host: AndroidHost): Promise<AndroidStreamHandle> {
    throw new EmulatorError(
      'emulator_redroid_unreachable',
      'TODO: redroid H.264 streaming is not implemented (Phase 4).'
    )
  }

  async teardown(
    _serial: string,
    _host: AndroidHost,
    _opts?: { destroy?: boolean }
  ): Promise<void> {
    throw new EmulatorError(
      'emulator_redroid_unreachable',
      'TODO: redroid teardown is not implemented (Phase 3).'
    )
  }
}

function defaultLocalHostPlatform(): RemoteHostPlatform | null {
  return localRemoteHostPlatform(process.platform, process.arch)
}
