import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const detectRemoteHostPlatformMock = vi.hoisted(() => vi.fn())
const ensureRemoteOrcaServerBinaryMock = vi.hoisted(() => vi.fn())
const launchRemoteOrcaServerMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-remote-platform-detection', () => ({
  detectRemoteHostPlatform: detectRemoteHostPlatformMock
}))
vi.mock('./ssh-remote-orca-server-install', () => ({
  ensureRemoteOrcaServerBinary: ensureRemoteOrcaServerBinaryMock
}))
vi.mock('./ssh-remote-orca-server-launch', () => ({
  launchRemoteOrcaServer: launchRemoteOrcaServerMock
}))

// Why: await import() is required so vi.mock() above registers before the
// module under test is evaluated. Static import would bypass the mock.
const { convertSshHostToOrcaRuntime } = await import('./ssh-remote-orca-server-conversion')

const conn = {} as SshConnection

describe('convertSshHostToOrcaRuntime', () => {
  beforeEach(() => {
    detectRemoteHostPlatformMock.mockReset()
    ensureRemoteOrcaServerBinaryMock.mockReset()
    launchRemoteOrcaServerMock.mockReset()
  })

  it('detects, installs, and launches on a Linux remote', async () => {
    detectRemoteHostPlatformMock.mockResolvedValueOnce(getRemoteHostPlatform('linux-x64'))
    ensureRemoteOrcaServerBinaryMock.mockResolvedValueOnce('/opt/orca/orca-linux.AppImage')
    launchRemoteOrcaServerMock.mockResolvedValueOnce({
      pairingUrl: 'orca://pair?code=abc123',
      endpoint: 'ws://100.64.1.20:6768'
    })

    await expect(
      convertSshHostToOrcaRuntime(conn, { pairingAddress: '100.64.1.20' })
    ).resolves.toEqual({
      pairingUrl: 'orca://pair?code=abc123',
      endpoint: 'ws://100.64.1.20:6768'
    })
    expect(ensureRemoteOrcaServerBinaryMock).toHaveBeenCalledWith(conn)
    expect(launchRemoteOrcaServerMock).toHaveBeenCalledWith(conn, '/opt/orca/orca-linux.AppImage', {
      pairingAddress: '100.64.1.20'
    })
  })

  it('proceeds when the remote platform cannot be detected', async () => {
    detectRemoteHostPlatformMock.mockResolvedValueOnce(null)
    ensureRemoteOrcaServerBinaryMock.mockResolvedValueOnce('/opt/orca/orca-linux.AppImage')
    launchRemoteOrcaServerMock.mockResolvedValueOnce({
      pairingUrl: 'orca://pair?code=abc123',
      endpoint: null
    })

    await expect(
      convertSshHostToOrcaRuntime(conn, { pairingAddress: '100.64.1.20' })
    ).resolves.toMatchObject({ pairingUrl: 'orca://pair?code=abc123' })
  })

  it('rejects a non-Linux remote before installing or launching anything', async () => {
    detectRemoteHostPlatformMock.mockResolvedValueOnce(getRemoteHostPlatform('darwin-arm64'))

    await expect(
      convertSshHostToOrcaRuntime(conn, { pairingAddress: '100.64.1.20' })
    ).rejects.toThrow(/only supported on Linux/)
    expect(ensureRemoteOrcaServerBinaryMock).not.toHaveBeenCalled()
    expect(launchRemoteOrcaServerMock).not.toHaveBeenCalled()
  })
})
