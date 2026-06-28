import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionInfo } from './emulator-types'
import {
  ensureSimulatorBooted,
  listSimulatorDevices,
  resolveSimulatorUdid,
  shutdownSimulatorDevice,
  type SimulatorDevice
} from './simctl-simulator-devices'
import {
  execServeSimCommand,
  parseServeSimCommandArgs,
  resolveServeSimExecutable,
  stripEmulatorTargetArgs,
  type ServeSimExecutable
} from './serve-sim-execution'
import { waitForServeSimEndpointReady } from './serve-sim-endpoint-readiness'
import {
  killServeSimHelperProcessesForDevice,
  listServeSimHelperProcessesForDevice
} from './serve-sim-helper-processes'
import type { EmulatorBridgeOptions } from './emulator-bridge-types'
import { sendEmulatorGestureSequence, type EmulatorGesturePoint } from './emulator-gesture-sender'
import { parseServeSimDetachedSession } from './serve-sim-detached-session'
import { EmulatorSessionRegistry } from './emulator-session-registry'
import {
  EmulatorSessionLifecycle,
  type SessionTeardown
} from './emulator-session-lifecycle'
import type { MobileDeviceBridge } from './mobile-device-bridge'
import { hideNativeSimulatorApp } from './simulator-app-visibility'

export class EmulatorBridge implements MobileDeviceBridge {
  private readonly sessionRegistry: EmulatorSessionRegistry
  private readonly lifecycle: EmulatorSessionLifecycle

  private serveSimExecutable: ServeSimExecutable
  private readonly waitForEndpointReady: (endpoint: string) => Promise<boolean>

  // Why: behavior-preserving teardown hook for the shared lifecycle. The
  // conditional includeOrphaned key (vs always-present) is load-bearing — the
  // destroy path historically omits it, stop/kill include it.
  private readonly teardownSession: SessionTeardown = async (target, options) => {
    const killOptions =
      options.includeOrphaned === undefined
        ? { helperPid: target.pid }
        : { helperPid: target.pid, includeOrphaned: options.includeOrphaned }
    await this.stopServeSimForDevice(target.deviceUdid, killOptions)
    if (options.shutdownDevice) {
      await (options.ignoreShutdownError
        ? shutdownSimulatorDevice(target.deviceUdid).catch(() => {})
        : shutdownSimulatorDevice(target.deviceUdid))
    }
  }

  constructor(options: EmulatorBridgeOptions = {}) {
    this.serveSimExecutable = resolveServeSimExecutable()
    this.waitForEndpointReady = options.waitForEndpointReady ?? waitForServeSimEndpointReady
    this.sessionRegistry = options.registry ?? new EmulatorSessionRegistry()
    this.lifecycle = new EmulatorSessionLifecycle(this.sessionRegistry, this.teardownSession, 'ios')
  }

  private async ensureUdid(deviceOrName: string): Promise<string> {
    return resolveSimulatorUdid(deviceOrName, this.serveSimExecutable)
  }

  private async ensureDeviceBooted(udid: string): Promise<void> {
    await ensureSimulatorBooted(udid)
  }

  async listSimulators(): Promise<SimulatorDevice[]> {
    return listSimulatorDevices()
  }

  async listRunningHelpers(): Promise<unknown> {
    return this.execServeSim(['--list', '-q'], { json: true })
  }

  async checkServeSimAvailable(): Promise<void> {
    await this.execServeSim(['--help'], { timeoutMs: 10_000 })
  }

  registerActiveEmulator(
    worktreeId: string,
    info: EmulatorSessionInfo,
    options: { managed?: boolean } = {}
  ): void {
    this.lifecycle.registerActive(worktreeId, info, options)
  }

  unregisterActiveEmulator(worktreeId: string): void {
    this.lifecycle.unregisterWorktree(worktreeId)
  }

  getActiveForWorktree(worktreeId?: string): EmulatorSessionInfo | null {
    return this.lifecycle.getActiveForWorktree(worktreeId)
  }

  async getReusableActiveForWorktree(
    worktreeId: string,
    device?: string
  ): Promise<EmulatorSessionInfo | null> {
    const active = this.getActiveForWorktree(worktreeId)
    if (!active || (device && (await this.ensureUdid(device)) !== active.deviceUdid)) {
      return null
    }
    if (!(await this.waitForEndpointReady(active.streamUrl))) {
      return null
    }
    return (await this.hasServeSimHelperForDevice(active)) ? active : null
  }

  async stopActiveForWorktree(
    worktreeId: string,
    options: { shutdownDevice?: boolean } = {}
  ): Promise<string | null> {
    return this.lifecycle.stopActiveForWorktree(worktreeId, { ...options, managedOnly: false })
  }

  async stopActiveManagedForWorktree(
    worktreeId: string,
    options: { shutdownDevice?: boolean } = {}
  ): Promise<string | null> {
    return this.lifecycle.stopActiveForWorktree(worktreeId, { ...options, managedOnly: true })
  }

  async shutdownActiveManagedForWorktree(worktreeId: string): Promise<string | null> {
    return this.stopActiveManagedForWorktree(worktreeId, { shutdownDevice: true })
  }

  async tap(x: number, y: number, opts?: { device?: string; worktreeId?: string }): Promise<void> {
    const target = this.lifecycle.getTargetOrThrow(opts)
    const udid = await this.ensureUdid(target.udid)
    await this.execServeSim(['tap', x.toString(), y.toString(), '-d', udid])
  }

  async gesture(
    points: EmulatorGesturePoint[],
    opts?: { device?: string; worktreeId?: string }
  ): Promise<void> {
    if (points.length === 0) {
      return
    }
    const target = this.lifecycle.getTargetOrThrow(opts)
    const udid = await this.ensureUdid(target.udid)
    const session = this.sessionRegistry.getSession(udid)
    if (!session?.wsUrl) {
      throw new EmulatorError('emulator_no_active', 'No active emulator stream for gesture input')
    }
    await sendEmulatorGestureSequence(session.wsUrl, points)
  }

  async type(text: string, opts?: { device?: string; worktreeId?: string }): Promise<void> {
    const target = this.lifecycle.getTargetOrThrow(opts)
    const udid = await this.ensureUdid(target.udid)
    await this.execServeSim(['type', text, '-d', udid])
  }

  async button(name: string, opts?: { device?: string; worktreeId?: string }): Promise<void> {
    const target = this.lifecycle.getTargetOrThrow(opts)
    const udid = await this.ensureUdid(target.udid)
    await this.execServeSim(['button', name, '-d', udid])
  }

  async rotate(
    orientation: string,
    opts?: { device?: string; worktreeId?: string }
  ): Promise<void> {
    const target = this.lifecycle.getTargetOrThrow(opts)
    const udid = await this.ensureUdid(target.udid)
    await this.execServeSim(['rotate', orientation, '-d', udid])
  }

  async exec(
    command: string,
    opts?: { device?: string; emulator?: string; worktreeId?: string }
  ): Promise<unknown> {
    const target = this.lifecycle.getTargetOrThrow(opts)
    const udid = await this.ensureUdid(target.udid)
    const rawArgs = stripEmulatorTargetArgs(parseServeSimCommandArgs(command.trim()))
    const args = [...rawArgs, '-d', udid]
    return this.execServeSim(args, { json: true })
  }

  private async execServeSim(
    args: string[],
    options?: { json?: boolean; timeoutMs?: number }
  ): Promise<unknown> {
    return execServeSimCommand(this.serveSimExecutable, args, options)
  }

  private async stopServeSimForDevice(
    deviceUdid: string,
    options: { helperPid?: number; includeOrphaned?: boolean } = {}
  ): Promise<void> {
    await this.execServeSim(['--kill', '-q', deviceUdid]).catch(() => {})
    // Why: serve-sim --kill depends on its state file; stale helper binaries
    // can survive state loss and keep old streams/listeners around.
    await killServeSimHelperProcessesForDevice(deviceUdid, options).catch(() => {})
  }

  private async hasServeSimHelperForDevice(info: EmulatorSessionInfo): Promise<boolean> {
    const helpers = await listServeSimHelperProcessesForDevice(info.deviceUdid, {
      helperPid: info.helperPid,
      includeOrphaned: true
    }).catch(() => [])
    return helpers.length > 0
  }

  async startHelperForDevice(device: string): Promise<EmulatorSessionInfo> {
    const udid = await this.ensureUdid(device)
    await this.ensureDeviceBooted(udid)
    const startDetachedHelper = async (): Promise<EmulatorSessionInfo> => {
      const raw = await this.execServeSim(['--detach', '-q', udid], { json: true })
      return parseServeSimDetachedSession(raw, udid)
    }

    const waitForReadyOrKill = async (info: EmulatorSessionInfo): Promise<boolean> => {
      if (
        (await this.waitForEndpointReady(info.streamUrl)) &&
        (await this.hasServeSimHelperForDevice(info))
      ) {
        return true
      }
      await this.stopServeSimForDevice(info.deviceUdid, {
        helperPid: info.helperPid,
        includeOrphaned: true
      })
      return false
    }

    let info = await startDetachedHelper()
    if (!(await waitForReadyOrKill(info))) {
      info = await startDetachedHelper()
      if (!(await waitForReadyOrKill(info))) {
        throw new EmulatorError(
          'emulator_helper_failed',
          'serve-sim started but its stream endpoint is not reachable.'
        )
      }
    }
    // Why: serve-sim/CoreSimulator can surface Simulator.app while Orca embeds the stream.
    await hideNativeSimulatorApp().catch(() => {})
    return info
  }

  async kill(device?: string, worktreeId?: string): Promise<string> {
    const udid = device
      ? await this.ensureUdid(device)
      : this.lifecycle.getTargetOrThrow({ worktreeId }).udid
    return this.lifecycle.tearDownDevice(udid, {
      shutdownDevice: false,
      ignoreShutdownError: false
    })
  }

  async shutdown(device?: string, worktreeId?: string): Promise<string> {
    const udid = device
      ? await this.ensureUdid(device)
      : this.lifecycle.getTargetOrThrow({ worktreeId }).udid
    return this.lifecycle.tearDownDevice(udid, {
      shutdownDevice: true,
      ignoreShutdownError: false
    })
  }

  async destroyAllSessions(): Promise<void> {
    await this.lifecycle.destroyAll()
  }

  async onAppQuit(): Promise<void> {
    await this.destroyAllSessions()
  }
}
