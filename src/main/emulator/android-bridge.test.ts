import { describe, expect, it, vi } from 'vitest'
import { AndroidBridge } from './android-bridge'
import { EmulatorSessionRegistry } from './emulator-session-registry'
import type { AndroidDeviceBackend, AndroidStreamHandle } from './android-device-backend'
import type { AdbCommandExecutor } from './adb-command-execution'
import type { EmulatorSessionInfo } from './emulator-types'
import { androidStreamHandleRegistry } from '../ipc/android-stream-handle-registry'

function iosSession(deviceUdid: string): EmulatorSessionInfo {
  return {
    deviceUdid,
    streamUrl: `http://127.0.0.1:3100/${deviceUdid}`,
    wsUrl: `ws://127.0.0.1:3100/${deviceUdid}`,
    helperPid: 4321
  }
}

const SERIAL = '127.0.0.1:5555'

function recordingExecutor(): { executor: AdbCommandExecutor; calls: string[][] } {
  const calls: string[][] = []
  const executor: AdbCommandExecutor = {
    mode: 'local',
    exec: vi.fn(async (program: string, args: string[]) => {
      calls.push([program, ...args])
      return { stdout: '', stderr: '', exitCode: 0, spawnError: false }
    })
  }
  return { executor, calls }
}

let nextStreamId = 0
function fakeStreamHandle(): AndroidStreamHandle {
  return {
    streamId: `android-stream-${nextStreamId++}`,
    streamKind: 'h264',
    units: async function* () {},
    stop: vi.fn()
  }
}

// Backend whose provision yields a fixed serial; input is backend-agnostic, so
// only provision/teardown/startStream matter to the bridge here.
function provisioningBackend(): AndroidDeviceBackend {
  return {
    provision: vi.fn(async () => ({ serial: SERIAL, host: { mode: 'local' }, hostId: 'local' })),
    startStream: vi.fn(async () => fakeStreamHandle()),
    teardown: vi.fn(async () => {})
  } as unknown as AndroidDeviceBackend
}

async function attachedBridge(): Promise<{
  bridge: AndroidBridge
  calls: string[][]
}> {
  const { executor, calls } = recordingExecutor()
  const bridge = new AndroidBridge({
    registry: new EmulatorSessionRegistry(),
    backend: provisioningBackend(),
    resolveHost: () => ({ mode: 'local' }),
    getExecutor: async () => executor
  })
  const info = await bridge.startHelperForDevice('sess1')
  bridge.registerActiveEmulator('wt-1', info, { managed: true })
  return { bridge, calls }
}

describe('AndroidBridge shared-registry kind isolation', () => {
  it('does not tear down or unregister an active iOS session on the shared registry', async () => {
    // Repro of B1: attach --kind android routes its pre-attach stop through the
    // AndroidBridge, which shares the registry with the iOS bridge. A kind-blind
    // teardown would fire redroid teardown on the iOS udid and leak the helper.
    const registry = new EmulatorSessionRegistry()
    registry.registerActive('wt-1', iosSession('ios-device-1'), { managed: true })

    const teardown = vi.fn(async () => {
      throw new Error('redroid teardown must not run on an iOS session')
    })
    const bridge = new AndroidBridge({
      registry,
      backend: { teardown } as unknown as AndroidDeviceBackend,
      resolveHost: () => ({ mode: 'local' })
    })

    const stopped = await bridge.stopActiveForWorktree('wt-1', { shutdownDevice: true })

    expect(stopped).toBeNull()
    expect(teardown).not.toHaveBeenCalled()
    // iOS worktree -> session mapping must remain intact.
    expect(registry.getActiveForWorktree('wt-1')?.deviceUdid).toBe('ios-device-1')
  })
})

describe('AndroidBridge re-attach reuse', () => {
  it('reuses the active session instead of forcing a container rebuild', async () => {
    // M1 regression: a null reuse stub routed re-attach through stopActiveForWorktree
    // -> docker rm -f + ~60s cold boot every time. Reuse must return the live session.
    const { bridge } = await attachedBridge()
    const reused = await bridge.getReusableActiveForWorktree('wt-1')
    expect(reused?.kind).toBe('android')
    expect(reused?.deviceUdid).toBe(bridge.getActiveForWorktree('wt-1')?.deviceUdid)
  })

  it('returns null when the worktree has no active session', async () => {
    const { bridge } = await attachedBridge()
    expect(await bridge.getReusableActiveForWorktree('wt-other')).toBeNull()
  })
})

describe('AndroidBridge teardown registry keying', () => {
  it('clears the host-keyed session record on kill (SEC-3)', async () => {
    // Android sessions are keyed hostId::serial; tearing down by the raw serial
    // would strand the keyed record and leak the session.
    const registry = new EmulatorSessionRegistry()
    const { executor } = recordingExecutor()
    const bridge = new AndroidBridge({
      registry,
      backend: provisioningBackend(),
      resolveHost: () => ({ mode: 'local' }),
      getExecutor: async () => executor
    })
    const info = await bridge.startHelperForDevice('sess1')
    bridge.registerActiveEmulator('wt-1', info, { managed: true })
    const key = `local::${SERIAL}`
    expect(registry.getSession(key)).toBeDefined()

    await bridge.kill(undefined, 'wt-1')

    expect(registry.getSession(key)).toBeUndefined()
    expect(registry.getActiveForWorktree('wt-1')).toBeNull()
  })

  it('destroyAllSessions reaps only its own kind on the shared registry (SEC-1a)', async () => {
    const registry = new EmulatorSessionRegistry()
    registry.registerActive('wt-ios', iosSession('ios-1'), { managed: true })
    const androidTeardown = vi.fn(async () => {})
    const { executor } = recordingExecutor()
    const bridge = new AndroidBridge({
      registry,
      backend: {
        provision: vi.fn(async () => ({ serial: SERIAL, host: { mode: 'local' }, hostId: 'local' })),
        startStream: vi.fn(async () => fakeStreamHandle()),
        teardown: androidTeardown
      } as unknown as AndroidDeviceBackend,
      resolveHost: () => ({ mode: 'local' }),
      getExecutor: async () => executor
    })
    const info = await bridge.startHelperForDevice('sess1')
    bridge.registerActiveEmulator('wt-android', info, { managed: true })

    await bridge.destroyAllSessions()

    // Android session reaped...
    expect(registry.getSession(`local::${SERIAL}`)).toBeUndefined()
    expect(registry.getActiveForWorktree('wt-android')).toBeNull()
    // ...but the iOS session on the shared registry survives untouched.
    expect(registry.getActiveForWorktree('wt-ios')?.deviceUdid).toBe('ios-1')
    expect(androidTeardown).toHaveBeenCalled()
  })
})

describe('AndroidBridge input wiring', () => {
  it('provisions, starts a real h264 stream, and registers the handle by streamId', async () => {
    const { executor } = recordingExecutor()
    const bridge = new AndroidBridge({
      registry: new EmulatorSessionRegistry(),
      backend: provisioningBackend(),
      resolveHost: () => ({ mode: 'local' }),
      getExecutor: async () => executor
    })
    const info = await bridge.startHelperForDevice('sess1')
    expect(info).toMatchObject({
      deviceUdid: SERIAL,
      kind: 'android',
      streamKind: 'h264',
      hostId: 'local'
    })
    // streamUrl carries the streamId; the handle is resolvable from the registry.
    expect(info.streamUrl).toMatch(/^android-stream-/)
    expect(androidStreamHandleRegistry.get(info.streamUrl)).toBeDefined()
  })

  it('stops and unregisters the stream handle on session teardown', async () => {
    const { executor } = recordingExecutor()
    const bridge = new AndroidBridge({
      registry: new EmulatorSessionRegistry(),
      backend: provisioningBackend(),
      resolveHost: () => ({ mode: 'local' }),
      getExecutor: async () => executor
    })
    const info = await bridge.startHelperForDevice('sess1')
    bridge.registerActiveEmulator('wt-teardown', info, { managed: true })
    const handle = androidStreamHandleRegistry.get(info.streamUrl)
    await bridge.stopActiveForWorktree('wt-teardown', { shutdownDevice: true })
    expect(handle?.stop).toHaveBeenCalled()
    expect(androidStreamHandleRegistry.get(info.streamUrl)).toBeUndefined()
  })

  it('maps a normalized tap to device pixels via adb shell input', async () => {
    const { bridge, calls } = await attachedBridge()
    await bridge.tap(0.5, 0.5, { worktreeId: 'wt-1' })
    expect(calls).toContainEqual([
      'adb',
      '-s',
      SERIAL,
      'shell',
      'input',
      'tap',
      '540',
      '960'
    ])
  })

  it('records rotation so later taps map against the rotated box', async () => {
    const { bridge, calls } = await attachedBridge()
    await bridge.rotate('landscape_left', { worktreeId: 'wt-1' })
    expect(calls).toContainEqual([
      'adb',
      '-s',
      SERIAL,
      'shell',
      'settings',
      'put',
      'system',
      'user_rotation',
      '1'
    ])
    calls.length = 0
    await bridge.tap(0.5, 0.5, { worktreeId: 'wt-1' })
    // rotation 1 swaps width/height: center of 1920x1080 -> 960,540.
    expect(calls).toContainEqual(['adb', '-s', SERIAL, 'shell', 'input', 'tap', '960', '540'])
  })

  it('escapes spaces in typed text and maps button names to keycodes', async () => {
    const { bridge, calls } = await attachedBridge()
    await bridge.type('a b', { worktreeId: 'wt-1' })
    await bridge.button('back', { worktreeId: 'wt-1' })
    expect(calls).toContainEqual(['adb', '-s', SERIAL, 'shell', 'input', 'text', 'a%sb'])
    expect(calls).toContainEqual(['adb', '-s', SERIAL, 'shell', 'input', 'keyevent', 'KEYCODE_BACK'])
  })

  it('emits one discrete swipe per gesture segment', async () => {
    const { bridge, calls } = await attachedBridge()
    await bridge.gesture(
      [
        { type: 'begin', x: 0, y: 0 },
        { type: 'move', x: 0.5, y: 0.5 },
        { type: 'end', x: 1, y: 1 }
      ],
      { worktreeId: 'wt-1' }
    )
    const swipes = calls.filter((c) => c.includes('swipe'))
    expect(swipes).toHaveLength(2)
  })

  it('throws when no session is active for the worktree', async () => {
    const { executor } = recordingExecutor()
    const bridge = new AndroidBridge({
      registry: new EmulatorSessionRegistry(),
      backend: provisioningBackend(),
      resolveHost: () => ({ mode: 'local' }),
      getExecutor: async () => executor
    })
    await expect(bridge.tap(0.5, 0.5, { worktreeId: 'missing' })).rejects.toMatchObject({
      code: 'emulator_no_active'
    })
  })
})
