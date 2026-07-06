import { describe, expect, it, vi } from 'vitest'
import type { PluginHostRegistration } from '../../shared/plugins/plugin-host-protocol'
import type { PluginHostHandle } from './plugin-host-process'
import { createCodeProviderProxy } from './plugin-code-provider-proxy'

const CONTEXT = { workspaceRoot: '/ws' }

function createHost(result: unknown): PluginHostHandle & { invoke: ReturnType<typeof vi.fn> } {
  return {
    registrations: [],
    invoke: vi.fn(async () => result),
    dispose: async () => undefined,
    onExit: () => undefined
  }
}

function registration(methods: string[]): PluginHostRegistration {
  return {
    extensionPoint: 'codeProvider',
    providerId: 'prov',
    methods: methods as PluginHostRegistration['methods']
  }
}

describe('createCodeProviderProxy', () => {
  it('attaches only registered methods and forwards calls to the host', async () => {
    const symbols = [{ name: 'foo', kind: 'function', file: 'a.ts', line: 3 }]
    const host = createHost(symbols)
    const proxy = createCodeProviderProxy(host, registration(['searchSymbols']))

    expect(proxy.provideHover).toBeUndefined()
    expect(proxy.provideDefinition).toBeUndefined()
    await expect(proxy.searchSymbols!('foo', CONTEXT)).resolves.toEqual(symbols)
    expect(host.invoke).toHaveBeenCalledWith('codeProvider', 'prov', 'searchSymbols', [
      'foo',
      CONTEXT
    ])
  })

  it('rejects malformed results at the fork boundary instead of passing them through', async () => {
    const host = createHost({ echoed: 'not-a-symbol-array' })
    const proxy = createCodeProviderProxy(
      host,
      registration(['searchSymbols', 'provideDefinition'])
    )

    await expect(proxy.searchSymbols!('foo', CONTEXT)).rejects.toThrow(
      'malformed searchSymbols result'
    )
    await expect(proxy.provideDefinition!('a.ts', 1, 1, CONTEXT)).rejects.toThrow(
      'malformed provideDefinition result'
    )
  })

  it('normalizes nullish hover results to null and validates real ones', async () => {
    const proxy = (result: unknown) =>
      createCodeProviderProxy(createHost(result), registration(['provideHover']))

    await expect(proxy(undefined).provideHover!('a.ts', 1, 1, CONTEXT)).resolves.toBeNull()
    await expect(proxy(null).provideHover!('a.ts', 1, 1, CONTEXT)).resolves.toBeNull()
    await expect(proxy({ contents: 'docs' }).provideHover!('a.ts', 1, 1, CONTEXT)).resolves.toEqual(
      { contents: 'docs' }
    )
    await expect(proxy({ contents: 42 }).provideHover!('a.ts', 1, 1, CONTEXT)).rejects.toThrow(
      'malformed provideHover result'
    )
  })
})
