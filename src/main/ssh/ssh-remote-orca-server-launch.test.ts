import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

// Why: await import() is required so vi.mock() above registers before the
// module under test is evaluated. Static import would bypass the mock.
const { assertRemoteDisplayAvailable, launchRemoteOrcaServer } =
  await import('./ssh-remote-orca-server-launch')

const conn = {} as SshConnection

const READY_JSON = JSON.stringify({
  type: 'orca_server_ready',
  endpoint: 'ws://100.64.1.20:6768',
  pairing: { url: 'orca://pair?code=abc123' }
})

describe('assertRemoteDisplayAvailable', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it('passes when $DISPLAY is set', async () => {
    execCommandMock.mockResolvedValueOnce('ok\n')
    await expect(assertRemoteDisplayAvailable(conn)).resolves.toBeUndefined()
  })

  it('throws actionable guidance when neither $DISPLAY nor Xvfb is available', async () => {
    execCommandMock.mockResolvedValueOnce('')
    await expect(assertRemoteDisplayAvailable(conn)).rejects.toThrow(/Xvfb/)
  })
})

describe('launchRemoteOrcaServer', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('launches detached and parses the pairing URL from the first ready line', async () => {
    execCommandMock
      .mockResolvedValueOnce('ok\n') // display check
      .mockResolvedValueOnce('') // launch command
      .mockResolvedValueOnce(`${READY_JSON}\n`) // first poll

    const resultPromise = launchRemoteOrcaServer(conn, '/opt/orca/orca-linux.AppImage', {
      pairingAddress: '100.64.1.20'
    })
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toEqual({
      pairingUrl: 'orca://pair?code=abc123',
      endpoint: 'ws://100.64.1.20:6768'
    })

    const launchCommand = execCommandMock.mock.calls[1]![1] as string
    expect(launchCommand).toContain('nohup')
    expect(launchCommand).toContain('setsid')
    expect(launchCommand).toContain('disown')
    expect(launchCommand).toContain("--pairing-address '100.64.1.20'")
  })

  it('polls until the ready line appears', async () => {
    execCommandMock
      .mockResolvedValueOnce('ok\n')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('') // not ready yet
      .mockResolvedValueOnce('some other log line\n') // still not ready
      .mockResolvedValueOnce(`${READY_JSON}\n`)

    const resultPromise = launchRemoteOrcaServer(conn, '/opt/orca/orca-linux.AppImage', {
      pairingAddress: '100.64.1.20'
    })
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toMatchObject({ pairingUrl: 'orca://pair?code=abc123' })
  })

  it('times out with the captured log when no ready line ever appears', async () => {
    execCommandMock.mockResolvedValueOnce('ok\n').mockResolvedValueOnce('')
    execCommandMock.mockResolvedValue('some startup error\n')

    const resultPromise = launchRemoteOrcaServer(conn, '/opt/orca/orca-linux.AppImage', {
      pairingAddress: '100.64.1.20'
    })
    const assertion = expect(resultPromise).rejects.toThrow(/Timed out waiting for Orca/)
    await vi.runAllTimersAsync()
    await assertion
  })
})
