import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODE_PROVIDER_EXTENSION_POINT } from '../../shared/plugins/plugin-extension-registry'
import { PLUGIN_MANIFEST_FILENAME } from '../../shared/plugins/plugin-manifest'
import type { PluginHostHandle } from './plugin-host-process'
import { PluginService, type PluginHostFactory } from './plugin-service'

type StubHost = PluginHostHandle & {
  exitCallbacks: ((code: number | null) => void)[]
}

function createStubHost(providerId: string): StubHost {
  const exitCallbacks: ((code: number | null) => void)[] = []
  return {
    registrations: [{ extensionPoint: 'codeProvider', providerId, methods: ['searchSymbols'] }],
    invoke: vi.fn(async (...args: unknown[]) => ({ echoed: args })),
    dispose: vi.fn(async () => undefined),
    onExit: (callback) => exitCallbacks.push(callback),
    exitCallbacks
  }
}

function manifestJson(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    name: `Plugin ${id}`,
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    main: 'index.js',
    contributes: {
      codeProviders: [{ id: `${id}-provider`, displayName: `${id} provider` }],
      panels: [{ id: 'panel', title: 'Panel', icon: 'puzzle', entry: 'panel/index.html' }]
    },
    ...overrides
  })
}

describe('PluginService', () => {
  let userDataPath: string
  let disabledPlugins: string[]
  let hosts: Map<string, StubHost>
  let hostFactory: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'orca-plugin-service-'))
    disabledPlugins = []
    hosts = new Map()
    hostFactory = vi.fn(async (options: { pluginId: string }) => {
      const host = createStubHost(`${options.pluginId}-provider`)
      hosts.set(options.pluginId, host)
      return host
    })
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  async function writePlugin(id: string, manifestText: string = manifestJson(id)): Promise<void> {
    const dir = join(userDataPath, 'plugins', id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, PLUGIN_MANIFEST_FILENAME), manifestText)
  }

  function createService(): PluginService {
    return new PluginService({
      userDataPath,
      getDisabledPlugins: () => disabledPlugins,
      hostFactory: hostFactory as unknown as PluginHostFactory
    })
  }

  it('activates enabled plugins with a main entry and populates the registry', async () => {
    await writePlugin('alpha')
    const service = createService()
    await service.initialize()

    expect(hostFactory).toHaveBeenCalledTimes(1)
    expect(hostFactory.mock.calls[0]![0]).toMatchObject({
      pluginId: 'alpha',
      mainEntry: 'index.js'
    })

    const provider = service.getRegistry().resolve(CODE_PROVIDER_EXTENSION_POINT, 'alpha')
    expect(provider?.id).toBe('alpha-provider')
    // Capability probing: only registered methods exist on the proxy.
    expect(typeof provider?.searchSymbols).toBe('function')
    expect(provider?.provideHover).toBeUndefined()

    await provider!.searchSymbols!('foo', { workspaceRoot: '/ws' })
    expect(hosts.get('alpha')!.invoke).toHaveBeenCalledWith(
      'codeProvider',
      'alpha-provider',
      'searchSymbols',
      ['foo', { workspaceRoot: '/ws' }]
    )
  })

  it('does not activate disabled plugins or plugins without main', async () => {
    await writePlugin('alpha')
    await writePlugin('beta', manifestJson('beta', { main: undefined }))
    disabledPlugins = ['alpha']
    const service = createService()
    await service.initialize()
    expect(hostFactory).not.toHaveBeenCalled()
    const entries = service.listPlugins()
    expect(entries.find((entry) => entry.pluginId === 'alpha')?.status).toBe('disabled')
    expect(entries.find((entry) => entry.pluginId === 'beta')?.status).toBe('active')
  })

  it('lists plugins with panel tab keys and invalid manifests as errors', async () => {
    await writePlugin('alpha')
    await writePlugin('broken', '{ nope')
    const service = createService()
    await service.initialize()
    const entries = service.listPlugins()
    expect(entries).toHaveLength(2)
    const alpha = entries.find((entry) => entry.pluginId === 'alpha')!
    expect(alpha.status).toBe('active')
    expect(alpha.name).toBe('Plugin alpha')
    expect(alpha.version).toBe('1.0.0')
    expect(alpha.panels).toEqual([
      { id: 'panel', title: 'Panel', icon: 'puzzle', tabKey: 'plugin:alpha/panel' }
    ])
    // Unreadable manifests fall back to the directory name as the id.
    const broken = entries.find((entry) => entry.pluginId === 'broken')!
    expect(broken.status).toBe('error')
    expect(broken.error).toContain('invalid JSON')
    expect(broken.panels).toEqual([])
  })

  it('disable stops the host and clears the registry; enable restarts it', async () => {
    await writePlugin('alpha')
    const service = createService()
    await service.initialize()
    const firstHost = hosts.get('alpha')!

    disabledPlugins = ['alpha']
    await service.setPluginEnabled('alpha', false)
    expect(firstHost.dispose).toHaveBeenCalledTimes(1)
    expect(service.getRegistry().resolve(CODE_PROVIDER_EXTENSION_POINT, 'alpha')).toBeNull()
    expect(service.listPlugins()[0]!.status).toBe('disabled')

    disabledPlugins = []
    await service.setPluginEnabled('alpha', true)
    expect(hostFactory).toHaveBeenCalledTimes(2)
    expect(service.getRegistry().resolve(CODE_PROVIDER_EXTENSION_POINT, 'alpha')).not.toBeNull()
    expect(service.listPlugins()[0]!.status).toBe('active')
  })

  it('marks a plugin errored and clears its registrations when the host crashes', async () => {
    await writePlugin('alpha')
    const service = createService()
    await service.initialize()
    for (const callback of hosts.get('alpha')!.exitCallbacks) {
      callback(1)
    }
    expect(service.listPlugins()[0]!.status).toBe('error')
    expect(service.listPlugins()[0]!.error).toContain('exited unexpectedly')
    expect(service.getRegistry().resolve(CODE_PROVIDER_EXTENSION_POINT, 'alpha')).toBeNull()
  })

  it('marks a plugin errored when the host fails to start', async () => {
    await writePlugin('alpha')
    hostFactory.mockRejectedValueOnce(new Error('spawn failed'))
    const service = createService()
    await service.initialize()
    expect(service.listPlugins()[0]!).toMatchObject({ status: 'error', error: 'spawn failed' })
  })

  it('resolves panel entry paths and returns null for unknown ids', async () => {
    await writePlugin('alpha')
    const service = createService()
    await service.initialize()
    expect(service.getPanelEntryPath('alpha', 'panel')).toBe(
      join(userDataPath, 'plugins', 'alpha', 'panel', 'index.html')
    )
    expect(service.getPanelEntryPath('alpha', 'nope')).toBeNull()
    expect(service.getPanelEntryPath('ghost', 'panel')).toBeNull()
  })

  it('rejects traversal panel entries at the manifest boundary', async () => {
    await writePlugin(
      'sneaky',
      manifestJson('sneaky', {
        contributes: { panels: [{ id: 'panel', title: 'Panel', entry: '../../outside.html' }] }
      })
    )
    const service = createService()
    await service.initialize()
    // Traversal entries fail manifest validation, so the plugin never loads.
    expect(service.listPlugins()[0]!.status).toBe('error')
    expect(service.getPanelEntryPath('sneaky', 'panel')).toBeNull()
  })

  it('dispose shuts down all hosts', async () => {
    await writePlugin('alpha')
    await writePlugin('beta')
    const service = createService()
    await service.initialize()
    await service.dispose()
    expect(hosts.get('alpha')!.dispose).toHaveBeenCalledTimes(1)
    expect(hosts.get('beta')!.dispose).toHaveBeenCalledTimes(1)
  })
})
