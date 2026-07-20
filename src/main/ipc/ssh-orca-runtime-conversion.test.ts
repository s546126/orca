import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { listEnvironments } from '../../shared/runtime-environment-store'

const handlers = new Map<string, (_event: unknown, args: never) => Promise<unknown>>()
const { handleMock, removeHandlerMock, getPathMock, convertSshHostToOrcaRuntimeMock } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    getPathMock: vi.fn(),
    convertSshHostToOrcaRuntimeMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  },
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('../ssh/ssh-remote-orca-server-conversion', () => ({
  convertSshHostToOrcaRuntime: convertSshHostToOrcaRuntimeMock
}))

const getSshConnectionStoreMock = vi.hoisted(() => vi.fn())
const getSshConnectionManagerMock = vi.hoisted(() => vi.fn())
vi.mock('./ssh', () => ({
  getSshConnectionStore: getSshConnectionStoreMock,
  getSshConnectionManager: getSshConnectionManagerMock
}))

const { registerSshOrcaRuntimeConversionHandlers } = await import('./ssh-orca-runtime-conversion')

const tempDirs: string[] = []

function makeUserDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ssh-runtime-conversion-'))
  tempDirs.push(dir)
  return dir
}

function makePairingCode(endpoint = 'wss://100.64.1.20:6768'): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint,
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('registerSshOrcaRuntimeConversionHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    getPathMock.mockReset()
    convertSshHostToOrcaRuntimeMock.mockReset()
    getSshConnectionStoreMock.mockReset()
    getSshConnectionManagerMock.mockReset()
    handlers.clear()
    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler as never)
    })
  })

  function getHandler(): (_event: unknown, args: { targetId: string }) => Promise<unknown> {
    registerSshOrcaRuntimeConversionHandlers()
    const handler = handlers.get('ssh:convertToOrcaRuntime')
    if (!handler) {
      throw new Error('handler not registered')
    }
    return handler as never
  }

  it('registers and unregisters the channel idempotently', () => {
    registerSshOrcaRuntimeConversionHandlers()
    expect(removeHandlerMock).toHaveBeenCalledWith('ssh:convertToOrcaRuntime')
    expect(handleMock).toHaveBeenCalledWith('ssh:convertToOrcaRuntime', expect.any(Function))
  })

  it('converts a connected SSH host and registers a runtime environment', async () => {
    const userDataPath = makeUserDataDir()
    getPathMock.mockReturnValue(userDataPath)
    getSshConnectionStoreMock.mockReturnValue({
      getTarget: vi.fn().mockReturnValue({ id: 't1', label: 'my-box', host: '100.64.1.20' })
    })
    const conn = {}
    getSshConnectionManagerMock.mockReturnValue({
      getState: vi.fn().mockReturnValue({ status: 'connected' }),
      getConnection: vi.fn().mockReturnValue(conn)
    })
    convertSshHostToOrcaRuntimeMock.mockResolvedValue({
      pairingUrl: makePairingCode(),
      endpoint: 'ws://100.64.1.20:6768'
    })

    const handler = getHandler()
    const result = (await handler({}, { targetId: 't1' })) as {
      environment: { name: string }
    }

    expect(result.environment.name).toBe('my-box (SSH)')
    expect(convertSshHostToOrcaRuntimeMock).toHaveBeenCalledWith(conn, {
      pairingAddress: '100.64.1.20'
    })
    expect(listEnvironments(userDataPath)).toHaveLength(1)
    expect(listEnvironments(userDataPath)[0]?.source).toBe('manual')
  })

  it('rejects when the SSH host is not connected', async () => {
    getSshConnectionStoreMock.mockReturnValue({
      getTarget: vi.fn().mockReturnValue({ id: 't1', label: 'my-box', host: '100.64.1.20' })
    })
    getSshConnectionManagerMock.mockReturnValue({
      getState: vi.fn().mockReturnValue({ status: 'disconnected' }),
      getConnection: vi.fn().mockReturnValue(undefined)
    })

    const handler = getHandler()
    await expect(handler({}, { targetId: 't1' })).rejects.toThrow(/Connect to "my-box"/)
    expect(convertSshHostToOrcaRuntimeMock).not.toHaveBeenCalled()
  })

  it('rejects when the target does not exist', async () => {
    getSshConnectionStoreMock.mockReturnValue({ getTarget: vi.fn().mockReturnValue(undefined) })
    getSshConnectionManagerMock.mockReturnValue({
      getState: vi.fn(),
      getConnection: vi.fn()
    })

    const handler = getHandler()
    await expect(handler({}, { targetId: 'missing' })).rejects.toThrow(/SSH host not found/)
  })
})
