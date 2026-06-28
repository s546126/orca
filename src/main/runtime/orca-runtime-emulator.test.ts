import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RuntimeEmulatorCommands,
  type RuntimeEmulatorCommandHost
} from './orca-runtime-emulator'
import { setAndroidBridge, setEmulatorBridge } from './mobile-bridge-instances'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import type { MobileDeviceBridge } from '../emulator/mobile-device-bridge'
import type { EmulatorSessionInfo } from '../emulator/emulator-types'
import type { GlobalSettings } from '../../shared/types'

function androidInfo(): EmulatorSessionInfo {
  return {
    deviceUdid: '127.0.0.1:5555',
    wsUrl: '',
    streamUrl: 'android-stream-1',
    streamKind: 'h264',
    hostId: 'local',
    kind: 'android'
  }
}

function fakeBridge(overrides: Partial<MobileDeviceBridge> = {}): MobileDeviceBridge {
  return {
    startHelperForDevice: vi.fn(async () => androidInfo()),
    tap: vi.fn(async () => {}),
    gesture: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    button: vi.fn(async () => {}),
    rotate: vi.fn(async () => {}),
    exec: vi.fn(async () => ({})),
    listSimulators: vi.fn(async () => {
      throw new Error('listSimulators must not be called on the Android path')
    }),
    listRunningHelpers: vi.fn(async () => []),
    registerActiveEmulator: vi.fn(),
    unregisterActiveEmulator: vi.fn(),
    getActiveForWorktree: vi.fn(() => null),
    getReusableActiveForWorktree: vi.fn(async () => null),
    stopActiveForWorktree: vi.fn(async () => null),
    stopActiveManagedForWorktree: vi.fn(async () => null),
    shutdownActiveManagedForWorktree: vi.fn(async () => null),
    kill: vi.fn(async () => ''),
    shutdown: vi.fn(async () => ''),
    destroyAllSessions: vi.fn(async () => {}),
    onAppQuit: vi.fn(async () => {}),
    ...overrides
  }
}

function makeHost(settings: Partial<GlobalSettings>): RuntimeEmulatorCommandHost {
  return {
    getEmulatorBridge: () => null,
    resolveWorktreeSelector: vi.fn(async (selector: string) => ({ id: selector })),
    // Window send is wrapped in try/catch — throwing here is harmless.
    getAuthoritativeWindow: () => {
      throw new Error('no window in test')
    },
    getSettings: () =>
      settings as Pick<
        GlobalSettings,
        'mobileEmulatorEnabled' | 'mobileEmulatorDefaultDeviceUdid' | 'androidEnabled'
      >
  }
}

afterEach(() => {
  setAndroidBridge(null)
  setEmulatorBridge(null)
})

describe('RuntimeEmulatorCommands Android gating (SEC-2)', () => {
  it('rejects emulator.attach --kind android when androidEnabled is false', async () => {
    setAndroidBridge(fakeBridge())
    const cmds = new RuntimeEmulatorCommands(makeHost({ androidEnabled: false }))
    await expect(cmds.emulatorAttach({ kind: 'android' })).rejects.toMatchObject({
      code: 'emulator_disabled'
    })
  })

  it('rejects emulator.list --kind android when androidEnabled is false', async () => {
    setAndroidBridge(fakeBridge())
    const cmds = new RuntimeEmulatorCommands(makeHost({ androidEnabled: false }))
    await expect(cmds.emulatorList({ kind: 'android' })).rejects.toMatchObject({
      code: 'emulator_disabled'
    })
  })
})

describe('RuntimeEmulatorCommands Android attach without --device (HARD-3)', () => {
  it('provisions directly instead of calling listSimulators', async () => {
    const android = fakeBridge()
    setAndroidBridge(android)
    const cmds = new RuntimeEmulatorCommands(makeHost({ androidEnabled: true }))
    const res = await cmds.emulatorAttach({ kind: 'android' })
    expect(res.attached).toBe(true)
    expect(android.listSimulators).not.toHaveBeenCalled()
    expect(android.startHelperForDevice).toHaveBeenCalledWith('')
  })
})

describe('RuntimeEmulatorCommands cross-kind displacement (HARD-2)', () => {
  it('tears down a displaced Android session through its owning bridge on iOS attach', async () => {
    const android = fakeBridge({ stopActiveForWorktree: vi.fn(async () => '127.0.0.1:5555') })
    setAndroidBridge(android)
    const ios = {
      getActiveForWorktree: vi.fn(() => androidInfo()),
      getReusableActiveForWorktree: vi.fn(async () => null),
      stopActiveForWorktree: vi.fn(async () => null),
      startHelperForDevice: vi.fn(async () => ({
        deviceUdid: 'ios-1',
        wsUrl: 'ws://x',
        streamUrl: 'http://x'
      })),
      registerActiveEmulator: vi.fn()
    } as unknown as EmulatorBridge
    setEmulatorBridge(ios)
    const host = makeHost({ androidEnabled: true, mobileEmulatorEnabled: true })
    host.getEmulatorBridge = () => ios
    const cmds = new RuntimeEmulatorCommands(host)

    await cmds.emulatorAttach({ device: 'ios-1', worktree: 'wt-1' })

    expect(android.stopActiveForWorktree).toHaveBeenCalledWith('wt-1', { shutdownDevice: true })
  })
})
