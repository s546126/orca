import { EmulatorError } from './android-errors'
import type { AndroidDeviceBackend, AndroidHost } from './android-device-backend'
import type { EmulatorSessionRegistry } from './emulator-session-registry'
import {
  EmulatorSessionLifecycle,
  type SessionTeardown
} from './emulator-session-lifecycle'
import type { EmulatorGesturePoint } from './emulator-gesture-sender'
import type { EmulatorSessionInfo } from './emulator-types'
import type { MobileDeviceBridge } from './mobile-device-bridge'
import type { SimulatorDevice } from './simctl-simulator-devices'

export type AndroidBridgeOptions = {
  // Why: shared with EmulatorBridge so the runtime routes from one registry.
  registry: EmulatorSessionRegistry
  backend: AndroidDeviceBackend
  resolveHost: () => AndroidHost
}

// Phase 1 scaffold: device-control verbs throw TODO; session/registry shells
// delegate to the shared lifecycle so routing and app-quit never blow up.
export class AndroidBridge implements MobileDeviceBridge {
  private readonly lifecycle: EmulatorSessionLifecycle
  private readonly backend: AndroidDeviceBackend
  private readonly resolveHost: () => AndroidHost

  private readonly teardownSession: SessionTeardown = async (target, options) => {
    await this.backend.teardown(target.deviceUdid, this.resolveHost(), {
      destroy: options.shutdownDevice
    })
  }

  constructor(options: AndroidBridgeOptions) {
    this.backend = options.backend
    this.resolveHost = options.resolveHost
    this.lifecycle = new EmulatorSessionLifecycle(options.registry, this.teardownSession, 'android')
  }

  async startHelperForDevice(_device: string): Promise<EmulatorSessionInfo> {
    throw new EmulatorError(
      'emulator_adb_unavailable',
      'TODO: Android device attach is not implemented (Phase 3).'
    )
  }

  async tap(_x: number, _y: number): Promise<void> {
    throw this.notImplemented()
  }

  async gesture(_points: EmulatorGesturePoint[]): Promise<void> {
    throw this.notImplemented()
  }

  async type(_text: string): Promise<void> {
    throw this.notImplemented()
  }

  async button(_name: string): Promise<void> {
    throw this.notImplemented()
  }

  async rotate(_orientation: string): Promise<void> {
    throw this.notImplemented()
  }

  async exec(_command: string): Promise<unknown> {
    throw this.notImplemented()
  }

  async listSimulators(): Promise<SimulatorDevice[]> {
    throw new EmulatorError(
      'emulator_adb_unavailable',
      'TODO: Android device discovery is not implemented (Phase 2).'
    )
  }

  async listRunningHelpers(): Promise<unknown> {
    throw new EmulatorError(
      'emulator_adb_unavailable',
      'TODO: Android device discovery is not implemented (Phase 2).'
    )
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

  async getReusableActiveForWorktree(): Promise<EmulatorSessionInfo | null> {
    // Phase 1: no reuse path yet — attach always provisions (and throws TODO).
    return null
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

  async kill(device?: string, worktreeId?: string): Promise<string> {
    const udid = this.lifecycle.getTargetOrThrow({ device, worktreeId }).udid
    return this.lifecycle.tearDownDevice(udid, { shutdownDevice: false, ignoreShutdownError: false })
  }

  async shutdown(device?: string, worktreeId?: string): Promise<string> {
    const udid = this.lifecycle.getTargetOrThrow({ device, worktreeId }).udid
    return this.lifecycle.tearDownDevice(udid, { shutdownDevice: true, ignoreShutdownError: false })
  }

  async destroyAllSessions(): Promise<void> {
    await this.lifecycle.destroyAll()
  }

  async onAppQuit(): Promise<void> {
    await this.destroyAllSessions()
  }

  private notImplemented(): EmulatorError {
    return new EmulatorError(
      'emulator_adb_unavailable',
      'TODO: Android input control is not implemented (Phase 3).'
    )
  }
}
