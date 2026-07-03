import { basename, resolve, sep } from 'node:path'
import { pluginPanelTabKey } from '../../shared/plugins/plugin-manifest'
import {
  CODE_PROVIDER_EXTENSION_POINT,
  createPluginExtensionRegistry,
  isPluginEnabled,
  type PluginExtensionRegistry
} from '../../shared/plugins/plugin-extension-registry'
import {
  discoverPlugins,
  getUserPluginsDir,
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { createCodeProviderProxy } from './plugin-code-provider-proxy'
import { startPluginHost, type PluginHostHandle } from './plugin-host-process'

// Why: this is the wire shape of plugins:list / plugins.list — it must stay
// assignable to the renderer's PluginHostListEntry (preload/api-types.ts).
export type PluginPanelListEntry = {
  id: string
  title: string
  icon?: string
  /** Right-sidebar tab key (`plugin:<pluginId>/<panelId>`). */
  tabKey: `plugin:${string}`
}

export type PluginListEntry = {
  pluginId: string
  name: string
  version: string
  status: 'active' | 'disabled' | 'error'
  error?: string
  panels: PluginPanelListEntry[]
}

export type PluginHostFactory = (options: {
  pluginId: string
  rootDir: string
  mainEntry: string
  entryPath: string
}) => Promise<PluginHostHandle>

export type PluginServiceOptions = {
  userDataPath: string
  getDisabledPlugins: () => string[]
  /** Absolute path to the compiled plugin-host-entry.js. Unused with a custom hostFactory. */
  hostEntryPath?: string
  hostFactory?: PluginHostFactory
}

export class PluginService {
  private readonly options: PluginServiceOptions
  private readonly hostFactory: PluginHostFactory
  private readonly registry: PluginExtensionRegistry = createPluginExtensionRegistry()
  private readonly hosts = new Map<string, PluginHostHandle>()
  private readonly runtimeErrors = new Map<string, string>()
  private discovered: DiscoveredPlugin[] = []
  private disposed = false

  constructor(options: PluginServiceOptions) {
    this.options = options
    this.hostFactory =
      options.hostFactory ??
      ((hostOptions) => {
        if (!hostOptions.entryPath) {
          throw new Error('PluginService requires hostEntryPath when no hostFactory is provided')
        }
        return startPluginHost(hostOptions)
      })
  }

  async initialize(): Promise<void> {
    this.discovered = await discoverPlugins(getUserPluginsDir(this.options.userDataPath))
    const disabledPlugins = this.options.getDisabledPlugins()
    for (const plugin of this.discovered) {
      if (isInvalidDiscoveredPlugin(plugin) || !isPluginEnabled(plugin.pluginId, disabledPlugins)) {
        continue
      }
      await this.activatePlugin(plugin)
    }
  }

  listPlugins(): PluginListEntry[] {
    const disabledPlugins = this.options.getDisabledPlugins()
    return this.discovered.map((plugin) => {
      if (isInvalidDiscoveredPlugin(plugin)) {
        // The directory name stands in for the id/name when the manifest is
        // unreadable, so the entry stays addressable in the plugins UI.
        const fallbackId = plugin.pluginId ?? basename(plugin.rootDir)
        return {
          pluginId: fallbackId,
          name: fallbackId,
          version: '0.0.0',
          status: 'error' as const,
          error: plugin.error,
          panels: []
        }
      }
      const runtimeError = this.runtimeErrors.get(plugin.pluginId)
      const status = !isPluginEnabled(plugin.pluginId, disabledPlugins)
        ? ('disabled' as const)
        : runtimeError
          ? ('error' as const)
          : ('active' as const)
      return {
        pluginId: plugin.pluginId,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        status,
        ...(status === 'error' ? { error: runtimeError } : {}),
        panels: plugin.manifest.contributes.panels.map((panel) => ({
          id: panel.id,
          title: panel.title,
          ...(panel.icon ? { icon: panel.icon } : {}),
          tabKey: pluginPanelTabKey(plugin.pluginId, panel.id)
        }))
      }
    })
  }

  /** Starts/stops the host for `pluginId`. The caller persists the setting. */
  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const plugin = this.findValidPlugin(pluginId)
    if (!plugin) {
      return
    }
    if (enabled) {
      this.runtimeErrors.delete(pluginId)
      await this.activatePlugin(plugin)
    } else {
      await this.deactivatePlugin(pluginId)
      this.runtimeErrors.delete(pluginId)
    }
  }

  getRegistry(): PluginExtensionRegistry {
    return this.registry
  }

  getPanelEntryPath(pluginId: string, panelId: string): string | null {
    const plugin = this.findValidPlugin(pluginId)
    const panel = plugin?.manifest.contributes.panels.find((entry) => entry.id === panelId)
    if (!plugin || !panel) {
      return null
    }
    const rootDir = resolve(plugin.rootDir)
    const entryPath = resolve(rootDir, panel.entry)
    // Why: the manifest schema already rejects traversal, but this path is
    // handed to file reads — keep a containment check as defense in depth.
    if (!entryPath.startsWith(rootDir + sep)) {
      return null
    }
    return entryPath
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const hosts = [...this.hosts.values()]
    this.hosts.clear()
    await Promise.all(hosts.map((host) => host.dispose().catch(() => undefined)))
  }

  private findValidPlugin(pluginId: string): ValidDiscoveredPlugin | null {
    for (const plugin of this.discovered) {
      if (!isInvalidDiscoveredPlugin(plugin) && plugin.pluginId === pluginId) {
        return plugin
      }
    }
    return null
  }

  private async activatePlugin(plugin: ValidDiscoveredPlugin): Promise<void> {
    const { pluginId, rootDir, manifest } = plugin
    // Panels/commands need no host process; only `main` runs code.
    if (!manifest.main || this.hosts.has(pluginId) || this.disposed) {
      return
    }
    let host: PluginHostHandle
    try {
      host = await this.hostFactory({
        pluginId,
        rootDir,
        mainEntry: manifest.main,
        entryPath: this.options.hostEntryPath ?? ''
      })
    } catch (error) {
      this.runtimeErrors.set(pluginId, error instanceof Error ? error.message : String(error))
      return
    }
    if (this.disposed) {
      void host.dispose()
      return
    }
    this.hosts.set(pluginId, host)
    for (const registration of host.registrations) {
      if (registration.extensionPoint === CODE_PROVIDER_EXTENSION_POINT.key) {
        this.registry.register(
          CODE_PROVIDER_EXTENSION_POINT,
          pluginId,
          createCodeProviderProxy(host, registration)
        )
      }
    }
    host.onExit(() => {
      // Why: identity check distinguishes a crash from an intentional
      // deactivate, which removes the host from the map before disposing.
      if (this.hosts.get(pluginId) === host) {
        this.hosts.delete(pluginId)
        this.registry.clearPlugin(pluginId)
        this.runtimeErrors.set(pluginId, 'plugin host exited unexpectedly')
      }
    })
  }

  private async deactivatePlugin(pluginId: string): Promise<void> {
    const host = this.hosts.get(pluginId)
    if (!host) {
      return
    }
    this.hosts.delete(pluginId)
    this.registry.clearPlugin(pluginId)
    await host.dispose()
  }
}
