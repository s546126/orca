import { describe, expect, it, vi } from 'vitest'
import { AndroidBridge } from './android-bridge'
import { EmulatorSessionRegistry } from './emulator-session-registry'
import type { AndroidDeviceBackend } from './android-device-backend'
import type { EmulatorSessionInfo } from './emulator-types'

function iosSession(deviceUdid: string): EmulatorSessionInfo {
  return {
    deviceUdid,
    streamUrl: `http://127.0.0.1:3100/${deviceUdid}`,
    wsUrl: `ws://127.0.0.1:3100/${deviceUdid}`,
    helperPid: 4321
  }
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
