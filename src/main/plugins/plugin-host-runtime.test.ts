import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CodeProvider,
  CodeProviderContext,
  CodeSymbol
} from '../../shared/plugins/code-provider'
import type { PluginHostChildMessage } from '../../shared/plugins/plugin-host-protocol'
import { createPluginHostRuntime, type PluginHostOrcaApi } from './plugin-host-runtime'

type SentMessages = PluginHostChildMessage[]

function createHarness(activate: unknown): {
  sent: SentMessages
  exit: ReturnType<typeof vi.fn>
  handleMessage: (raw: unknown) => Promise<void>
} {
  const sent: SentMessages = []
  const exit = vi.fn()
  const runtime = createPluginHostRuntime({
    send: (message) => sent.push(message),
    importModule: async () => ({ default: activate }),
    exit
  })
  return { sent, exit, handleMessage: runtime.handleMessage }
}

const INIT = { type: 'init', pluginRoot: '/plugin', mainEntry: 'index.js', pluginId: 'alpha' }

function activateWithProvider(provider: CodeProvider) {
  return (orca: PluginHostOrcaApi) => {
    orca.registerCodeProvider(provider)
  }
}

describe('plugin-host-runtime', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('replies ready with the implemented method names', async () => {
    const { sent, handleMessage } = createHarness(
      activateWithProvider({ id: 'alpha-provider', searchSymbols: async () => [] })
    )
    await handleMessage(INIT)
    expect(sent).toEqual([
      {
        type: 'ready',
        registrations: [
          {
            extensionPoint: 'codeProvider',
            providerId: 'alpha-provider',
            methods: ['searchSymbols']
          }
        ]
      }
    ])
  })

  it('invokes a provider method and replies with the result', async () => {
    const searchSymbols = vi.fn(
      async (query: string, _context: CodeProviderContext): Promise<CodeSymbol[]> => [
        { name: query, kind: 'function', file: 'a.ts', line: 1 }
      ]
    )
    const { sent, handleMessage } = createHarness(
      activateWithProvider({ id: 'alpha-provider', searchSymbols })
    )
    await handleMessage(INIT)
    await handleMessage({
      type: 'invoke',
      callId: 7,
      extensionPoint: 'codeProvider',
      providerId: 'alpha-provider',
      method: 'searchSymbols',
      args: ['foo', { workspaceRoot: '/ws' }]
    })
    expect(searchSymbols).toHaveBeenCalledWith('foo', { workspaceRoot: '/ws' })
    expect(sent[1]).toEqual({
      type: 'result',
      callId: 7,
      ok: true,
      value: [{ name: 'foo', kind: 'function', file: 'a.ts', line: 1 }]
    })
  })

  it('replies with an error result for unknown providers, methods, and thrown errors', async () => {
    const { sent, handleMessage } = createHarness(
      activateWithProvider({
        id: 'alpha-provider',
        searchSymbols: async () => {
          throw new Error('provider blew up')
        }
      })
    )
    await handleMessage(INIT)
    const invoke = {
      type: 'invoke',
      extensionPoint: 'codeProvider',
      providerId: 'alpha-provider',
      method: 'searchSymbols',
      args: []
    }
    await handleMessage({ ...invoke, callId: 1, providerId: 'nobody' })
    await handleMessage({ ...invoke, callId: 2, method: 'notAMethod' })
    await handleMessage({ ...invoke, callId: 3, method: 'provideHover' })
    await handleMessage({ ...invoke, callId: 4 })
    const results = sent.filter((message) => message.type === 'result')
    expect(results.map((message) => message.ok)).toEqual([false, false, false, false])
    expect(results[0]!.error).toContain('unknown provider')
    expect(results[1]!.error).toContain('unknown code provider method')
    expect(results[2]!.error).toContain('does not implement')
    expect(results[3]!.error).toContain('provider blew up')
  })

  it('sends fatal and exits(1) when activation fails', async () => {
    const { sent, exit, handleMessage } = createHarness(() => {
      throw new Error('activation failed')
    })
    await handleMessage(INIT)
    expect(sent[0]?.type).toBe('fatal')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('sends fatal and exits(1) when the entry has no activate function', async () => {
    const { sent, exit, handleMessage } = createHarness(undefined)
    await handleMessage(INIT)
    expect(sent[0]?.type).toBe('fatal')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits(0) on shutdown and warns on malformed messages', async () => {
    const { sent, exit, handleMessage } = createHarness(activateWithProvider({ id: 'p' }))
    await handleMessage({ type: 'not-a-real-type' })
    expect(sent[0]).toMatchObject({ type: 'log', level: 'warn' })
    await handleMessage({ type: 'shutdown' })
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('imports a real plugin module from disk via the default importer', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-host-'))
    tempDirs.push(pluginRoot)
    await writeFile(
      join(pluginRoot, 'index.mjs'),
      `export default function activate(orca) {
        orca.registerCodeProvider({
          id: 'disk-provider',
          provideHover: async () => ({ contents: 'hi' })
        })
      }`
    )
    const sent: SentMessages = []
    const runtime = createPluginHostRuntime({
      send: (message) => sent.push(message),
      exit: vi.fn()
    })
    await runtime.handleMessage({
      type: 'init',
      pluginRoot,
      mainEntry: 'index.mjs',
      pluginId: 'disk'
    })
    expect(sent).toEqual([
      {
        type: 'ready',
        registrations: [
          { extensionPoint: 'codeProvider', providerId: 'disk-provider', methods: ['provideHover'] }
        ]
      }
    ])
  })
})
