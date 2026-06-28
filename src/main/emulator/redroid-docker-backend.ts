import { EmulatorError, type AndroidErrorCode } from './android-errors'
import type { AdbCommandResult } from './adb-command-execution'
import {
  ADB_PROGRAM,
  adbConnect,
  listAdbDevices,
  waitForBootCompleted,
  type WaitClock
} from './adb-android-devices'
import { inspectAndroidAvailability } from './android-availability'
import {
  createAndroidStreamSource,
  createLocalScreenrecordSpawner,
  type AndroidStreamSpawner
} from './android-stream-source'
import { createRemoteScreenrecordSpawner } from './android-remote-screenrecord-spawner'
import {
  hostIdForHost,
  resolveAndroidExecutor,
  type AndroidExecutorDeps,
  type ResolvedAndroidExecutor
} from './android-executor-resolution'
import {
  buildRedroidContainerSpec,
  REDROID_SESSION_LABEL,
  type RedroidContainerRow
} from './redroid-container-spec'
import {
  buildHostContainersPsArgs,
  buildOrphanReapArgs,
  computeOrphanContainers
} from './redroid-orphan-reaper'
import type {
  AndroidBackendAvailability,
  AndroidDeviceBackend,
  AndroidDeviceSummary,
  AndroidHost,
  AndroidProvisionTarget,
  AndroidStreamHandle
} from './android-device-backend'

// Why: every dependency that touches a process/socket is injected so the backend
// runs against mocked executors in tests and never spawns here. Clock/timeouts
// keep the boot-wait poll deterministic without real time.
export type RedroidDockerBackendDeps = AndroidExecutorDeps & {
  clock?: WaitClock
  bootTimeoutMs?: number
  bootPollIntervalMs?: number
  androidVersion?: string
  // Injected so streaming tests never spawn screenrecord; defaults to the local
  // adb exec-out child.
  createStreamSpawner?: (serial: string) => AndroidStreamSpawner
  // Per-target SSH reconnect subscription. The remote stream source re-establishes
  // its exec channel + re-keys on this signal (exec channels die on relay-lost).
  // Injected so nothing taps real SSH state in tests; absent => no reconnect-driven
  // restart (the source still bounds its retries and ends cleanly on permanent loss).
  subscribeReconnect?: (sshTargetId: string, cb: () => void) => () => void
  // Terminal SSH-loss subscription. When present it (not a time budget) ends the
  // remote stream, so a long reconnect window cannot prematurely kill it.
  subscribeUnrecoverable?: (sshTargetId: string, cb: () => void) => () => void
}

const DOCKER_PROGRAM = 'docker'
const DEFAULT_BOOT_TIMEOUT_MS = 60_000
const DEFAULT_BOOT_POLL_INTERVAL_MS = 1_000

// Real clock for production; never invoked at import, only inside provision().
const systemClock: WaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

const DOCKER_PS_FORMAT = '{{.ID}}\t{{.Names}}\t{{.Labels}}'

// Tab-separated format so the pure parser needs no docker-version quirks.
function buildSessionPsArgs(): string[] {
  return ['ps', '--filter', `label=${REDROID_SESSION_LABEL}`, '--format', DOCKER_PS_FORMAT]
}

// Idempotency probe: include stopped containers (-a) for this exact session id.
function buildSessionFilterPsArgs(sessionId: string): string[] {
  return ['ps', '-a', '--filter', `label=${REDROID_SESSION_LABEL}=${sessionId}`, '--format', DOCKER_PS_FORMAT]
}

export function parseDockerSessionContainers(stdout: string): RedroidContainerRow[] {
  const containers: RedroidContainerRow[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) {
      continue
    }
    const [containerId, name = '', labels = ''] = line.split('\t')
    if (!containerId) {
      continue
    }
    containers.push({ containerId, name, sessionId: parseLabel(labels, REDROID_SESSION_LABEL) })
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

// Pure: classify the result of `docker run`/`start`. Why: a docker-group or
// --privileged denial must surface distinctly and fail fast — otherwise the
// container never started, the boot-wait spins the full timeout, and the user
// gets a generic "unreachable" instead of the actionable privilege error.
export function classifyDockerStartFailure(
  result: AdbCommandResult
): { failed: false } | { failed: true; code: AndroidErrorCode; message: string } {
  if (!result.spawnError && result.exitCode === 0) {
    return { failed: false }
  }
  const text = `${result.stdout}\n${result.stderr}`.trim()
  if (/permission denied|privileged/i.test(text)) {
    return {
      failed: true,
      code: 'emulator_docker_unprivileged',
      message:
        'docker refused to start the redroid container: this user cannot run privileged containers. Add the user to the docker group or use rootless docker.'
    }
  }
  return {
    failed: true,
    code: 'emulator_redroid_unreachable',
    message: `docker failed to start the redroid container: ${text || 'unknown docker error'}`
  }
}

export class RedroidDockerBackend implements AndroidDeviceBackend {
  readonly id = 'redroid-docker' as const

  // serial -> container name for teardown. Restart-safety for serials not in this
  // map is handled by reapOrphans (label-based sweep), so a destroy of an unmapped
  // serial only disconnects adb here.
  private readonly containerBySerial = new Map<string, string>()

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

  private resolveExecutor(host: AndroidHost): Promise<ResolvedAndroidExecutor> {
    return resolveAndroidExecutor(host, this.deps)
  }

  async provision(
    target: AndroidProvisionTarget
  ): Promise<{ serial: string; host: AndroidHost; hostId: string }> {
    const resolved = await this.resolveExecutor(target.host)
    if (!resolved.ok) {
      throw new EmulatorError('emulator_redroid_unreachable', resolved.availability.message)
    }
    const { executor, hostPlatform } = resolved
    const sessionId = target.deviceId ?? target.worktreeId ?? `sess-${Date.now()}`
    const hostId = hostIdForHost(target.host)
    const spec = buildRedroidContainerSpec({
      sessionId,
      hostId,
      arch: hostPlatform.arch,
      androidVersion: this.deps.androidVersion
    })

    // Idempotent ensure: (re)start an existing labeled container, else run fresh.
    const existing = parseDockerSessionContainers(
      (await executor.exec(DOCKER_PROGRAM, buildSessionFilterPsArgs(sessionId))).stdout
    )
    const found = existing.find((c) => c.sessionId === sessionId)
    const startResult = await (found
      ? executor.exec(DOCKER_PROGRAM, ['start', found.name || found.containerId])
      : executor.exec(DOCKER_PROGRAM, spec.runArgs))
    // Fail fast on a privilege/docker error so we don't register an absent
    // container or spin the boot-wait for the full timeout on one that never ran.
    const failure = classifyDockerStartFailure(startResult)
    if (failure.failed) {
      throw new EmulatorError(failure.code, failure.message)
    }
    this.containerBySerial.set(this.serialKey(hostId, spec.serial), spec.containerName)

    await adbConnect(executor, spec.serial)
    const booted = await waitForBootCompleted({
      executor,
      serial: spec.serial,
      timeoutMs: this.deps.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
      pollIntervalMs: this.deps.bootPollIntervalMs ?? DEFAULT_BOOT_POLL_INTERVAL_MS,
      clock: this.deps.clock ?? systemClock
    })
    if (!booted) {
      // Why: don't leak the container we just created when it never boots. Only
      // remove a freshly-run one (a slow pre-existing container restart is left
      // for the label-sweep reaper) so a broken boot doesn't orphan per attempt.
      if (!found) {
        await executor.exec(DOCKER_PROGRAM, ['rm', '-f', spec.containerName])
        this.containerBySerial.delete(this.serialKey(hostId, spec.serial))
      }
      throw new EmulatorError(
        'emulator_redroid_unreachable',
        `redroid container for session ${sessionId} did not reach sys.boot_completed=1 in time.`
      )
    }
    return { serial: spec.serial, host: target.host, hostId }
  }

  async teardown(
    serial: string,
    host: AndroidHost,
    opts?: { destroy?: boolean }
  ): Promise<void> {
    const resolved = await this.resolveExecutor(host)
    if (!resolved.ok) {
      return // host unreachable — nothing to tear down here, tolerate.
    }
    const { executor } = resolved
    // exec never throws; a non-zero "device not found" is already-gone, tolerated.
    await executor.exec(ADB_PROGRAM, ['disconnect', serial])
    if (!opts?.destroy) {
      return
    }
    const key = this.serialKey(hostIdForHost(host), serial)
    const container = this.containerBySerial.get(key)
    if (container) {
      await executor.exec(DOCKER_PROGRAM, ['rm', '-f', container])
      this.containerBySerial.delete(key)
    }
  }

  // Startup sweep (wired in Phase 5): remove this host's labeled containers whose
  // session id is no longer live. Pure decision in computeOrphanContainers.
  async reapOrphans(liveSessionIds: Iterable<string>, host: AndroidHost): Promise<string[]> {
    const resolved = await this.resolveExecutor(host)
    if (!resolved.ok) {
      return []
    }
    const { executor } = resolved
    const containers = parseDockerSessionContainers(
      (await executor.exec(DOCKER_PROGRAM, buildHostContainersPsArgs(hostIdForHost(host)))).stdout
    )
    const orphans = computeOrphanContainers(containers, new Set(liveSessionIds))
    for (const containerId of orphans) {
      await executor.exec(DOCKER_PROGRAM, buildOrphanReapArgs(containerId))
    }
    return orphans
  }

  async startStream(serial: string, host: AndroidHost): Promise<AndroidStreamHandle> {
    const resolved = await this.resolveExecutor(host)
    if (!resolved.ok) {
      throw new EmulatorError('emulator_redroid_unreachable', resolved.availability.message)
    }
    if (host.mode === 'remote') {
      return this.startRemoteStream(serial, host.sshTargetId)
    }
    // The byte source is injected so streaming tests never spawn screenrecord.
    const spawner = this.deps.createStreamSpawner
      ? this.deps.createStreamSpawner(serial)
      : createLocalScreenrecordSpawner(serial)
    return createAndroidStreamSource({ spawn: spawner })
  }

  // Remote H.264 rides the long-lived SshConnection.exec channel; on SSH reconnect
  // the source re-execs (the old exec channel is not restored by port-forward
  // replay) and re-emits a fresh keyframe.
  private startRemoteStream(serial: string, sshTargetId: string): AndroidStreamHandle {
    const conn = this.deps.getConnection?.(sshTargetId)
    if (!conn) {
      throw new EmulatorError(
        'emulator_redroid_unreachable',
        'The configured SSH host for remote Android is not connected.'
      )
    }
    const spawner = this.deps.createStreamSpawner
      ? this.deps.createStreamSpawner(serial)
      : // Re-resolve per exec: a reconnect disposes the old SshConnection and builds
        // a new one, so a captured handle would re-exec a dead connection forever.
        createRemoteScreenrecordSpawner((command) => {
          const current = this.deps.getConnection?.(sshTargetId)
          return current
            ? current.exec(command)
            : Promise.reject(new Error('SSH host for remote Android is not connected.'))
        }, serial)
    const onReconnect = this.deps.subscribeReconnect
      ? (cb: () => void) => this.deps.subscribeReconnect!(sshTargetId, cb)
      : undefined
    const onUnrecoverable = this.deps.subscribeUnrecoverable
      ? (cb: () => void) => this.deps.subscribeUnrecoverable!(sshTargetId, cb)
      : undefined
    return createAndroidStreamSource({ spawn: spawner, onReconnect, onUnrecoverable })
  }

  // Two hosts can both expose 127.0.0.1:5555, so the teardown map keys by host.
  private serialKey(hostId: string, serial: string): string {
    return `${hostId}::${serial}`
  }
}
