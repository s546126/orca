import { basename, resolve, sep } from 'node:path'
import { pluginPanelTabKey } from '../../shared/plugins/plugin-manifest'
import {
  CODE_PROVIDER_EXTENSION_POINT,
  createPluginExtensionRegistry,
  getPluginActivationState,
  type PluginActivationState,
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
  /** `pending` = discovered but never approved by the user; nothing ran. */
  status: 'active' | 'pending' | 'disabled' | 'error'
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
  /** Plugin ids the user consented to. Anything else stays pending/inert. */
  getApprovedPlugins: () => string[]
  /** Absolute path to the compiled plugin-host-entry.js. Unused with a custom hostFactory. */
  hostEntryPath?: string
  hostFactory?: PluginHostFactory
}

export class PluginService {
  private readonly options: PluginServiceOptions
  private readonly hostFactory: PluginHostFactory
  private readonly registry: PluginExtensionRegistry = createPluginExtensionRegistry()
  private readonly hosts = new Map<string, PluginHostHandle>()
  private readonly activating = new Map<string, Promise<void>>()
  private readonly runtimeErrors = new Map<string, string>()
  private discovered: DiscoveredPlugin[] = []
  private initPromise: Promise<void> | null = null
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
    this.initPromise ??= this.runInitialize()
    return this.initPromise
  }

  /** Resolves once startup discovery settled (even if it failed). IPC/RPC
   *  handlers await this so an early plugins:list can't observe the empty
   *  pre-discovery state and leave the sidebar permanently pluginless. */
  async whenReady(): Promise<void> {
    try {
      await (this.initPromise ?? Promise.resolve())
    } catch {
      // initialize() failures are logged by its caller; readiness only means
      // discovery is no longer in flight.
    }
  }

  private async runInitialize(): Promise<void> {
    this.discovered = await discoverPlugins(getUserPluginsDir(this.options.userDataPath))
    for (const plugin of this.discovered) {
      if (isInvalidDiscoveredPlugin(plugin)) {
        continue
      }
      if (this.getActivationState(plugin.pluginId) !== 'approved') {
        continue
      }
      await this.activatePlugin(plugin)
    }
  }

  private getActivationState(pluginId: string): PluginActivationState {
    return getPluginActivationState(pluginId, {
      approvedPlugins: this.options.getApprovedPlugins(),
      disabledPlugins: this.options.getDisabledPlugins()
    })
  }

  listPlugins(): PluginListEntry[] {
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
      const activation = this.getActivationState(plugin.pluginId)
      const status =
        activation !== 'approved'
          ? activation === 'disabled'
            ? ('disabled' as const)
            : ('pending' as const)
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
      // Consent invariant: callers persist approval before enabling; refuse to
      // start a host for a plugin the user never approved.
      if (this.getActivationState(pluginId) !== 'approved') {
        return
      }
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

  /** Manifest permissions for an *approved* plugin; `null` when the plugin is
   *  unknown, invalid, pending, or disabled so callers deny uniformly. */
  getGrantedPermissions(pluginId: string): string[] | null {
    const plugin = this.findValidPlugin(pluginId)
    if (!plugin || this.getActivationState(pluginId) !== 'approved') {
      return null
    }
    return plugin.manifest.contributes.permissions
  }

  getPanelEntryPath(pluginId: string, panelId: string): string | null {
    const plugin = this.findValidPlugin(pluginId)
    const panel = plugin?.manifest.contributes.panels.find((entry) => entry.id === panelId)
    if (!plugin || !panel || this.getActivationState(pluginId) !== 'approved') {
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

  private activatePlugin(plugin: ValidDiscoveredPlugin): Promise<void> {
    // Why: the hosts.has guard below runs before an await; two concurrent
    // enables would otherwise both fork a host and orphan the untracked one.
    const inFlight = this.activating.get(plugin.pluginId)
    if (inFlight) {
      return inFlight
    }
    const task = this.doActivatePlugin(plugin).finally(() => {
      this.activating.delete(plugin.pluginId)
    })
    this.activating.set(plugin.pluginId, task)
    return task
  }

  private async doActivatePlugin(plugin: ValidDiscoveredPlugin): Promise<void> {
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
          createCodeProviderProxy(host, registration),
          registration.providerId
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
    // Why: a disable racing an in-flight enable must wait for the host to
    // land in the map; otherwise it no-ops and leaves the host running.
    await this.activating.get(pluginId)
    const host = this.hosts.get(pluginId)
    if (!host) {
      return
    }
    this.hosts.delete(pluginId)
    this.registry.clearPlugin(pluginId)
    await host.dispose()
  }
}
