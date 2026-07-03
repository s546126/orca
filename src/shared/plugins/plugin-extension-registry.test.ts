import { describe, expect, it } from 'vitest'
import type { CodeProvider } from './code-provider'
import { supportsCodeProviderMethod } from './code-provider'
import {
  CODE_PROVIDER_EXTENSION_POINT,
  createPluginExtensionRegistry,
  isPluginEnabled,
  normalizeDisabledPlugins
} from './plugin-extension-registry'

const provider = (id: string): CodeProvider => ({
  id,
  searchSymbols: async () => []
})

describe('createPluginExtensionRegistry', () => {
  it('registers, resolves, and unregisters implementations per point', () => {
    const registry = createPluginExtensionRegistry()
    const unregister = registry.register(CODE_PROVIDER_EXTENSION_POINT, 'plugin-a', provider('a'))
    registry.register(CODE_PROVIDER_EXTENSION_POINT, 'plugin-b', provider('b'))

    expect(registry.resolveAll(CODE_PROVIDER_EXTENSION_POINT).map((r) => r.pluginId)).toEqual([
      'plugin-a',
      'plugin-b'
    ])
    expect(registry.resolve(CODE_PROVIDER_EXTENSION_POINT, 'plugin-a')?.id).toBe('a')

    unregister()
    expect(registry.resolve(CODE_PROVIDER_EXTENSION_POINT, 'plugin-a')).toBeNull()
    expect(registry.resolveAll(CODE_PROVIDER_EXTENSION_POINT)).toHaveLength(1)
  })

  it('clears every registration owned by a plugin', () => {
    const registry = createPluginExtensionRegistry()
    registry.register(CODE_PROVIDER_EXTENSION_POINT, 'plugin-a', provider('a1'))
    registry.register(CODE_PROVIDER_EXTENSION_POINT, 'plugin-a', provider('a2'))
    registry.register(CODE_PROVIDER_EXTENSION_POINT, 'plugin-b', provider('b'))

    registry.clearPlugin('plugin-a')
    expect(registry.resolveAll(CODE_PROVIDER_EXTENSION_POINT).map((r) => r.pluginId)).toEqual([
      'plugin-b'
    ])
  })
})

describe('code provider capability probing', () => {
  it('reports only implemented methods', () => {
    const p = provider('a')
    expect(supportsCodeProviderMethod(p, 'searchSymbols')).toBe(true)
    expect(supportsCodeProviderMethod(p, 'provideHover')).toBe(false)
  })
})

describe('plugin enablement', () => {
  it('treats unlisted plugins as enabled', () => {
    expect(isPluginEnabled('a', [])).toBe(true)
    expect(isPluginEnabled('a', ['b'])).toBe(true)
    expect(isPluginEnabled('a', ['a'])).toBe(false)
  })

  it('normalizes persisted disabled lists defensively', () => {
    expect(normalizeDisabledPlugins(['a', 'a', '', 42, null, 'b'])).toEqual(['a', 'b'])
    expect(normalizeDisabledPlugins('not-an-array')).toEqual([])
  })
})
