import type { BrowserWindow } from 'electron'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import { EmulatorError } from '../emulator/emulator-errors'
import {
  inspectEmulatorAvailability,
  pickDefaultSimulatorDevice,
  type EmulatorAvailability
} from '../emulator/emulator-availability'
import { serveSimStateWatcher } from '../emulator/serve-sim-state-watcher'
import type { EmulatorGesturePoint } from '../emulator/emulator-gesture-sender'
import type { EmulatorSessionInfo } from '../emulator/emulator-types'
import type { MobileDeviceBridge } from '../emulator/mobile-device-bridge'
import type { AndroidBackendAvailability } from '../emulator/android-device-backend'
import type { SimulatorDevice } from '../emulator/simctl-simulator-devices'
import type { GlobalSettings } from '../../shared/types'

// Why: dedicated file for "one surface" separation (emulator), parallel to orca-runtime-browser.ts. Keeps OrcaRuntimeService focused; emulator routing easy to scan. No max-lines disable (split further if grows; per AGENTS + plan Phase 3).
export type RuntimeEmulatorCommandHost = {
  getEmulatorBridge(): EmulatorBridge | null
  resolveWorktreeSelector(selector: string): Promise<{ id: string }>
  getAuthoritativeWindow(): BrowserWindow
  getSettings(): Pick<GlobalSettings, EmulatorSettingKey>
}

type EmulatorSettingKey =
  | 'mobileEmulatorEnabled'
  | 'mobileEmulatorDefaultDeviceUdid'
  | 'androidEnabled'

export class RuntimeEmulatorCommands {
  constructor(private readonly host: RuntimeEmulatorCommandHost) {}

  private requireEmulatorBridge(): EmulatorBridge {
    const bridge = this.host.getEmulatorBridge()
    if (!bridge) {
      throw new EmulatorError('emulator_no_active', 'No emulator session is active')
    }
    return bridge
  }

  // Why: attach/list route by an explicit --kind; default (and absent android
  // bridge) behave exactly as the iOS-only path did.
  private resolveBridge(kind?: 'ios' | 'android'): MobileDeviceBridge {
    if (kind === 'android') {
      const android = getAndroidBridge()
      if (android) {
        return android
      }
    }
    return this.requireEmulatorBridge()
  }

  // Why: interaction verbs route by the kind recorded in the shared registry at
  // attach time. With no android sessions (Phase 1) this always returns iOS.
  private resolveBridgeForWorktree(worktreeId?: string): MobileDeviceBridge {
    const android = getAndroidBridge()
    if (android && worktreeId) {
      const recorded = this.host.getEmulatorBridge()?.getActiveForWorktree(worktreeId)
      if (recorded?.kind === 'android') {
        return android
      }
    }
    return this.requireEmulatorBridge()
  }

  // Why: RPC envelopes require a serializable `result` field; void/undefined omits it and breaks CLI schema validation.
  private static readonly OK = { ok: true as const }

  // High-level delegation (mirror browser* methods).
  async emulatorTap(params: {
    x: number
    y: number
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<{ ok: true }> {
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const bridge = this.resolveBridgeForWorktree(worktreeId)
    await bridge.tap(params.x, params.y, { device: params.device ?? params.emulator, worktreeId })
    return RuntimeEmulatorCommands.OK
  }

  async emulatorGesture(params: {
    points: EmulatorGesturePoint[]
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<{ ok: true }> {
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const bridge = this.resolveBridgeForWorktree(worktreeId)
    await bridge.gesture(params.points, { device: params.device ?? params.emulator, worktreeId })
    return RuntimeEmulatorCommands.OK
  }

  async emulatorType(params: {
    text: string
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<{ ok: true }> {
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const bridge = this.resolveBridgeForWorktree(worktreeId)
    await bridge.type(params.text, { device: params.device ?? params.emulator, worktreeId })
    return RuntimeEmulatorCommands.OK
  }

  async emulatorButton(params: {
    name: string
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<{ ok: true }> {
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const bridge = this.resolveBridgeForWorktree(worktreeId)
    await bridge.button(params.name, { device: params.device ?? params.emulator, worktreeId })
    return RuntimeEmulatorCommands.OK
  }

  async emulatorRotate(params: {
    orientation: string
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<{ ok: true }> {
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const bridge = this.resolveBridgeForWorktree(worktreeId)
    await bridge.rotate(params.orientation, {
      device: params.device ?? params.emulator,
      worktreeId
    })
    return RuntimeEmulatorCommands.OK
  }

  async emulatorExec(params: {
    command: string
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<unknown> {
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const bridge = this.resolveBridgeForWorktree(worktreeId)
    return bridge.exec(params.command, {
      device: params.device,
      emulator: params.emulator,
      worktreeId
    })
  }

  async emulatorAttach(params: {
    device?: string
    worktree?: string
    focus?: boolean
    kind?: 'ios' | 'android'
  }): Promise<{ attached: boolean; info?: EmulatorSessionInfo }> {
    const settings = this.host.getSettings()
    if (settings.mobileEmulatorEnabled === false) {
      throw new EmulatorError('emulator_disabled', 'Mobile Emulator is disabled in Settings.')
    }
    const bridge = this.resolveBridge(params.kind)
    let device = params.device ?? settings.mobileEmulatorDefaultDeviceUdid ?? undefined
    if (!device) {
      device = pickDefaultSimulatorDevice(await bridge.listSimulators())?.udid
    }
    if (!device) {
      throw new EmulatorError(
        'emulator_device_not_found',
        'No emulator device specified. Choose a default device in Settings > Mobile Emulator or pass a device.'
      )
    }
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    if (worktreeId) {
      const reusable = await bridge.getReusableActiveForWorktree(worktreeId, device)
      if (reusable) {
        // Why: renderer remounts should reconnect to the existing stream, not
        // kill it and create the stream-disconnected reload loop users see.
        serveSimStateWatcher.markOrcaManaged(reusable)
        this.notifyRendererEmulatorAutoAttach(worktreeId, reusable)
        if (params.focus) {
          this.notifyRendererEmulatorPaneFocus(worktreeId)
        }
        return { attached: true, info: reusable }
      }
      // Why: a different requested device is an explicit simulator switch.
      // Replace the old Orca-owned helper so switching does not leak devices.
      const stoppedUdid = await bridge.stopActiveForWorktree(worktreeId, { shutdownDevice: true })
      if (stoppedUdid) {
        serveSimStateWatcher.unmarkOrcaManaged(stoppedUdid)
      }
    }
    const info = await bridge.startHelperForDevice(device)
    if (worktreeId) {
      bridge.registerActiveEmulator(worktreeId, info, { managed: true })
      serveSimStateWatcher.markOrcaManaged(info)
      this.notifyRendererEmulatorAutoAttach(worktreeId, info)
      if (params.focus) {
        this.notifyRendererEmulatorPaneFocus(worktreeId)
      }
    }
    // Default: no auto steal (mirror browser tab create/switch). --focus sends emulator:pane-focus only when requested.
    return { attached: true, info }
  }

  async emulatorList(
    params: { worktree?: string; kind?: 'ios' | 'android' } = {}
  ): Promise<unknown> {
    const bridge = this.resolveBridge(params.kind)
    return bridge.listRunningHelpers()
  }

  async emulatorUnregisterActive(params: { worktree?: string }): Promise<{ ok: true }> {
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    if (worktreeId) {
      this.resolveBridgeForWorktree(worktreeId).unregisterActiveEmulator(worktreeId)
    }
    return RuntimeEmulatorCommands.OK
  }

  async emulatorListSimulators(_params: { worktree?: string } = {}): Promise<SimulatorDevice[]> {
    // Why: exposed for the EmulatorPane auto-flow on "New Mobile Emulator" tab creation.
    // Returns the full simctl list (including Shutdown devices) so the pane can choose a default and
    // rely on startHelperForDevice + ensureDeviceBooted to boot if needed. Worktree param ignored
    // (simulators are host-local, not per-worktree).
    const bridge = this.requireEmulatorBridge()
    return bridge.listSimulators()
  }

  async emulatorAvailability(_params: { worktree?: string } = {}): Promise<EmulatorAvailability> {
    return inspectEmulatorAvailability(this.requireEmulatorBridge())
  }

  // Why: sibling to emulatorAvailability so the iOS shape stays untouched. Gated
  // on androidEnabled (off by default); delegates to the Android bridge's
  // capability probe (binder/arch/docker, never KVM).
  async emulatorAndroidAvailability(
    _params: { worktree?: string; kind?: 'ios' | 'android' } = {}
  ): Promise<AndroidBackendAvailability> {
    if (!this.host.getSettings().androidEnabled) {
      return { ok: false, message: 'Android device support is disabled in Settings.' }
    }
    const probe = getAndroidBridge()?.inspectAvailability?.()
    return probe ?? { ok: false, reason: 'no_remote_host', message: 'Android is unavailable.' }
  }

  async emulatorKill(params: {
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<{ ok: true; deviceUdid: string }> {
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const bridge = this.resolveBridgeForWorktree(worktreeId)
    const killedUdid = await bridge.kill(params.device ?? params.emulator, worktreeId)
    serveSimStateWatcher.unmarkOrcaManaged(killedUdid)
    return { ok: true, deviceUdid: killedUdid }
  }

  async emulatorShutdown(params: {
    device?: string
    emulator?: string
    worktree?: string
    managedOnly?: boolean
  }): Promise<{ ok: true; deviceUdid?: string }> {
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const bridge = this.resolveBridgeForWorktree(worktreeId)
    if (params.managedOnly && worktreeId && !params.device && !params.emulator) {
      const shutdownUdid = await bridge.shutdownActiveManagedForWorktree(worktreeId)
      if (shutdownUdid) {
        serveSimStateWatcher.unmarkOrcaManaged(shutdownUdid)
      }
      return { ok: true, deviceUdid: shutdownUdid ?? undefined }
    }
    const shutdownUdid = await bridge.shutdown(params.device ?? params.emulator, worktreeId)
    serveSimStateWatcher.unmarkOrcaManaged(shutdownUdid)
    return { ok: true, deviceUdid: shutdownUdid }
  }

  // Why: mirror browser:pane-focus — scoped per worktree, no cross-worktree yank unless user is already there.
  private notifyRendererEmulatorPaneFocus(worktreeId: string): void {
    try {
      const win = this.host.getAuthoritativeWindow()
      win.webContents.send('emulator:pane-focus', { worktreeId })
    } catch {
      // Window may not exist during shutdown
    }
  }

  private notifyRendererEmulatorAutoAttach(worktreeId: string, info: EmulatorSessionInfo): void {
    try {
      const win = this.host.getAuthoritativeWindow()
      win.webContents.send('ui:emulatorAutoAttach', { worktreeId, info })
    } catch {
      // Window may not exist during shutdown
    }
  }

  // Raw for extensibility.
  async emulatorExecRaw(params: {
    command: string
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<unknown> {
    return this.emulatorExec(params)
  }
}

// Singleton accessor pattern (mirror requireAgentBrowserBridge).
let emulatorBridgeInstance: EmulatorBridge | null = null

export function setEmulatorBridge(bridge: EmulatorBridge | null): void {
  emulatorBridgeInstance = bridge
}

export function getEmulatorBridge(): EmulatorBridge | null {
  return emulatorBridgeInstance
}

export function requireEmulatorBridge(): EmulatorBridge {
  if (!emulatorBridgeInstance) {
    throw new EmulatorError('emulator_no_active', 'Emulator bridge not initialized')
  }
  return emulatorBridgeInstance
}

// Why: Android is a sibling MobileDeviceBridge. Null until index wires it, so
// resolveBridge falls back to the iOS bridge and behaves exactly as today.
let androidBridgeInstance: MobileDeviceBridge | null = null

export function setAndroidBridge(bridge: MobileDeviceBridge | null): void {
  androidBridgeInstance = bridge
}

export function getAndroidBridge(): MobileDeviceBridge | null {
  return androidBridgeInstance
}
