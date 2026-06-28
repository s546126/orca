import { EmulatorError } from './android-errors'
import type { AdbCommandExecutor } from './adb-command-execution'
import {
  buildButtonArgs,
  buildGestureSwipeArgs,
  buildRotateArgs,
  buildTapArgs,
  buildTypeArgs,
  orientationToUserRotation,
  runAdbShellInput,
  type DeviceRotation,
  type StreamSize
} from './adb-input-control'
import { resolveAndroidExecutor } from './android-executor-resolution'
import type {
  AndroidBackendAvailability,
  AndroidDeviceBackend,
  AndroidDeviceSummary,
  AndroidHost
} from './android-device-backend'
import type { EmulatorSessionRegistry } from './emulator-session-registry'
import { EmulatorSessionLifecycle, type SessionTeardown } from './emulator-session-lifecycle'
import type { EmulatorGesturePoint } from './emulator-gesture-sender'
import type { EmulatorSessionInfo } from './emulator-types'
import type { MobileDeviceBridge, MobileDeviceTargetOptions } from './mobile-device-bridge'
import type { SimulatorDevice } from './simctl-simulator-devices'
import { androidStreamHandleRegistry } from '../ipc/android-stream-handle-registry'
import { DEFAULT_REDROID_DISPLAY } from './redroid-container-spec'

export type AndroidBridgeOptions = {
  // Why: shared with EmulatorBridge so the runtime routes from one registry.
  registry: EmulatorSessionRegistry
  backend: AndroidDeviceBackend
  // null => no reachable redroid host (non-Linux desktop, no SSH target).
  resolveHost: () => AndroidHost | null
  // Resolve an adb executor for input verbs (backend-agnostic, shared across all
  // Android backends). null => no reachable host. Defaults to local-only.
  getExecutor?: (host: AndroidHost) => Promise<AdbCommandExecutor | null>
}

// Default tap-mapping resolution until the stream reports real dimensions.
// streamSizeBySerial must always hold NATURAL (rotation-0) dimensions —
// effectiveSize() applies the current rotation when mapping taps, so storing
// already-rotated dims here would double-swap. Shares the container's booted
// dims (DEFAULT_REDROID_DISPLAY) so the fallback can never drift from the image.
const DEFAULT_STREAM_SIZE: StreamSize = {
  width: DEFAULT_REDROID_DISPLAY.width,
  height: DEFAULT_REDROID_DISPLAY.height
}

// Phase 1 scaffold: device-control verbs throw TODO; session/registry shells
// delegate to the shared lifecycle so routing and app-quit never blow up.
export class AndroidBridge implements MobileDeviceBridge {
  private readonly lifecycle: EmulatorSessionLifecycle
  private readonly backend: AndroidDeviceBackend
  private readonly resolveHost: () => AndroidHost | null
  private readonly getExecutor: (host: AndroidHost) => Promise<AdbCommandExecutor | null>
  // Recorded per-serial input state. Rotation drives tap/swipe pixel mapping;
  // stream size defaults until Phase 4 reports real dimensions.
  private readonly rotationBySerial = new Map<string, DeviceRotation>()
  private readonly streamSizeBySerial = new Map<string, StreamSize>()
  // serial -> live H.264 stream id, so session teardown stops the source (teardown
  // wins over the renderer's frameStreamStop).
  private readonly streamIdBySerial = new Map<string, string>()

  private readonly teardownSession: SessionTeardown = async (target, options) => {
    const streamId = this.streamIdBySerial.get(target.deviceUdid)
    if (streamId) {
      androidStreamHandleRegistry.remove(streamId)
      this.streamIdBySerial.delete(target.deviceUdid)
    }
    const host = this.resolveHost()
    if (!host) {
      return
    }
    await this.backend.teardown(target.deviceUdid, host, {
      destroy: options.shutdownDevice
    })
    this.rotationBySerial.delete(target.deviceUdid)
    this.streamSizeBySerial.delete(target.deviceUdid)
  }

  constructor(options: AndroidBridgeOptions) {
    this.backend = options.backend
    this.resolveHost = options.resolveHost
    this.getExecutor =
      options.getExecutor ??
      (async (host) => {
        const resolved = await resolveAndroidExecutor(host, {})
        return resolved.ok ? resolved.executor : null
      })
    this.lifecycle = new EmulatorSessionLifecycle(options.registry, this.teardownSession, 'android')
  }

  async startHelperForDevice(device: string): Promise<EmulatorSessionInfo> {
    const host = this.resolveHost()
    if (!host) {
      throw new EmulatorError(
        'emulator_adb_unavailable',
        'No reachable redroid host. Configure a remote SSH target or run on a Linux binder host.'
      )
    }
    const { serial, hostId } = await this.backend.provision({
      deviceId: device || undefined,
      host
    })
    this.rotationBySerial.set(serial, 0)
    // Main owns the H.264 byte source from here; register the live handle so the
    // renderer-initiated frameStreamStart resolves it by streamId (no URL open).
    const handle = await this.backend.startStream(serial, host)
    androidStreamHandleRegistry.register(handle)
    this.streamIdBySerial.set(serial, handle.streamId)
    // streamUrl carries the streamId — the h264 frame-stream handler looks the
    // handle up rather than opening a socket like the iOS mjpeg path does.
    return {
      deviceUdid: serial,
      wsUrl: '',
      streamUrl: handle.streamId,
      kind: 'android',
      streamKind: 'h264',
      hostId
    }
  }

  async tap(x: number, y: number, opts?: MobileDeviceTargetOptions): Promise<void> {
    const { executor, serial, size, rotation } = await this.resolveInput(opts)
    await runAdbShellInput(executor, serial, buildTapArgs(x, y, size, rotation))
  }

  async gesture(points: EmulatorGesturePoint[], opts?: MobileDeviceTargetOptions): Promise<void> {
    if (points.length === 0) {
      return
    }
    const { executor, serial, size, rotation } = await this.resolveInput(opts)
    for (const argv of buildGestureSwipeArgs(points, size, rotation)) {
      await runAdbShellInput(executor, serial, argv)
    }
  }

  async type(text: string, opts?: MobileDeviceTargetOptions): Promise<void> {
    const { executor, serial } = await this.resolveInput(opts)
    await runAdbShellInput(executor, serial, buildTypeArgs(text))
  }

  async button(name: string, opts?: MobileDeviceTargetOptions): Promise<void> {
    const { executor, serial } = await this.resolveInput(opts)
    await runAdbShellInput(executor, serial, buildButtonArgs(name))
  }

  async rotate(orientation: string, opts?: MobileDeviceTargetOptions): Promise<void> {
    const { executor, serial } = await this.resolveInput(opts)
    await runAdbShellInput(executor, serial, buildRotateArgs(orientation))
    // Record the new rotation for tap mapping. Phase 4: the stream dimensions
    // change on rotate, so the caller must re-init the stream afterward.
    this.rotationBySerial.set(serial, orientationToUserRotation(orientation))
  }

  async exec(_command: string): Promise<unknown> {
    throw new EmulatorError(
      'emulator_adb_unavailable',
      'Android exec passthrough is not implemented yet.'
    )
  }

  // Resolve the executor + recorded input state for the targeted serial. Throws
  // emulator_no_active (no session) or emulator_adb_unavailable (no host/executor).
  private async resolveInput(opts?: MobileDeviceTargetOptions): Promise<{
    executor: AdbCommandExecutor
    serial: string
    size: StreamSize
    rotation: DeviceRotation
  }> {
    const serial = this.lifecycle.getTargetOrThrow(opts).udid
    const host = this.resolveHost()
    if (!host) {
      throw new EmulatorError('emulator_adb_unavailable', 'No reachable redroid host for input.')
    }
    const executor = await this.getExecutor(host)
    if (!executor) {
      throw new EmulatorError('emulator_adb_unavailable', 'No adb executor for the redroid host.')
    }
    return {
      executor,
      serial,
      size: this.streamSizeBySerial.get(serial) ?? DEFAULT_STREAM_SIZE,
      rotation: this.rotationBySerial.get(serial) ?? 0
    }
  }

  async listSimulators(): Promise<SimulatorDevice[]> {
    throw new EmulatorError(
      'emulator_adb_unavailable',
      'TODO: Android device discovery is not implemented (Phase 2).'
    )
  }

  // `emulator list --kind android`: enumerate running redroid devices. No host
  // (non-Linux desktop, no SSH target) yields an empty list, not an error.
  async listRunningHelpers(): Promise<AndroidDeviceSummary[]> {
    const host = this.resolveHost()
    if (!host) {
      return []
    }
    return this.backend.listDevices(host)
  }

  // Capability probe for "is android available". Returns no_remote_host when no
  // redroid host is reachable, otherwise the backend's real binder/arch/docker
  // verdict. Parallel to inspectEmulatorAvailability for the iOS path.
  async inspectAvailability(): Promise<AndroidBackendAvailability> {
    const host = this.resolveHost()
    if (!host) {
      return {
        ok: false,
        reason: 'no_remote_host',
        message:
          'No redroid host available. Configure a remote SSH target, or run Orca on a Linux host with binder support.'
      }
    }
    return this.backend.inspect(host)
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

  async getReusableActiveForWorktree(worktreeId: string): Promise<EmulatorSessionInfo | null> {
    // Why: re-attach must reconnect to the running container, not tear it down.
    // Without this, the runtime falls through to stopActiveForWorktree -> docker
    // rm -f and a fresh ~60s cold boot on every re-attach. One redroid container
    // per host in this phase, so any requested device maps to the same serial —
    // device-switch reuse logic arrives with multi-container support.
    return this.getActiveForWorktree(worktreeId)
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
    const target = this.lifecycle.getTargetOrThrow({ device, worktreeId })
    return this.lifecycle.tearDownDevice(
      target.udid,
      { shutdownDevice: false, ignoreShutdownError: false },
      target.worktreeId
    )
  }

  async shutdown(device?: string, worktreeId?: string): Promise<string> {
    const target = this.lifecycle.getTargetOrThrow({ device, worktreeId })
    return this.lifecycle.tearDownDevice(
      target.udid,
      { shutdownDevice: true, ignoreShutdownError: false },
      target.worktreeId
    )
  }

  async destroyAllSessions(): Promise<void> {
    await this.lifecycle.destroyAll()
  }

  async onAppQuit(): Promise<void> {
    await this.destroyAllSessions()
  }
}
