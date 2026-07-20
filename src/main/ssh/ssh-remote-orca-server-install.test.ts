import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

// Why: await import() is required so vi.mock() above registers before the
// module under test is evaluated. Static import would bypass the mock.
const { detectRemoteOrcaServerBinary, ensureRemoteOrcaServerBinary } =
  await import('./ssh-remote-orca-server-install')

const conn = {} as SshConnection

describe('detectRemoteOrcaServerBinary', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it('returns the managed install path when present', async () => {
    execCommandMock.mockResolvedValueOnce('$HOME/.orca-runtime/orca-linux.AppImage\n')
    await expect(detectRemoteOrcaServerBinary(conn)).resolves.toBe(
      '$HOME/.orca-runtime/orca-linux.AppImage'
    )
  })

  it('returns the shared /opt/orca path when the managed path is absent', async () => {
    execCommandMock.mockResolvedValueOnce('/opt/orca/orca-linux.AppImage\n')
    await expect(detectRemoteOrcaServerBinary(conn)).resolves.toBe('/opt/orca/orca-linux.AppImage')
  })

  it('returns null when nothing is installed', async () => {
    execCommandMock.mockResolvedValueOnce('')
    await expect(detectRemoteOrcaServerBinary(conn)).resolves.toBeNull()
  })

  it('returns null when the probe command itself fails', async () => {
    execCommandMock.mockRejectedValueOnce(new Error('connection reset'))
    await expect(detectRemoteOrcaServerBinary(conn)).resolves.toBeNull()
  })
})

describe('ensureRemoteOrcaServerBinary', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it('skips the download when already installed', async () => {
    execCommandMock.mockResolvedValueOnce('/opt/orca/orca-linux.AppImage\n')
    await expect(ensureRemoteOrcaServerBinary(conn)).resolves.toBe('/opt/orca/orca-linux.AppImage')
    expect(execCommandMock).toHaveBeenCalledTimes(1)
  })

  it('downloads via curl and verifies the result when nothing is installed', async () => {
    execCommandMock
      .mockResolvedValueOnce('') // detect: nothing found
      .mockResolvedValueOnce('curl\n') // resolveRemoteDownloader
      .mockResolvedValueOnce('') // mkdir + download + chmod
      .mockResolvedValueOnce('ok\n') // verify

    await expect(ensureRemoteOrcaServerBinary(conn)).resolves.toBe(
      '$HOME/.orca-runtime/orca-linux.AppImage'
    )
    expect(execCommandMock.mock.calls[2]![1]).toContain('curl -fsSL')
    expect(execCommandMock.mock.calls[2]![1]).toContain(
      'https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage'
    )
  })

  it('falls back to wget when curl is unavailable', async () => {
    execCommandMock
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('wget\n')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('ok\n')

    await ensureRemoteOrcaServerBinary(conn)
    expect(execCommandMock.mock.calls[2]![1]).toContain('wget -q')
  })

  it('throws a clear error when neither curl nor wget is available', async () => {
    execCommandMock.mockResolvedValueOnce('').mockResolvedValueOnce('')

    await expect(ensureRemoteOrcaServerBinary(conn)).rejects.toThrow(/curl nor wget/)
  })

  it('throws guidance when the download command fails', async () => {
    execCommandMock
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('curl\n')
      .mockRejectedValueOnce(new Error('curl: (6) Could not resolve host'))

    await expect(ensureRemoteOrcaServerBinary(conn)).rejects.toThrow(
      /Could not download Orca to the remote host/
    )
  })

  it('throws when the binary is not executable after download', async () => {
    execCommandMock
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('curl\n')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')

    await expect(ensureRemoteOrcaServerBinary(conn)).rejects.toThrow(/not executable/)
  })
})
