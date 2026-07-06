import { readFile } from 'node:fs/promises'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { isCodeProviderMethod } from '../../shared/plugins/code-provider'
import { CODE_PROVIDER_EXTENSION_POINT } from '../../shared/plugins/plugin-extension-registry'
import { applyPluginEnablement } from '../plugins/plugin-enablement'
import {
  panelActionCallSchema,
  type PluginPanelActionOutcome
} from '../../shared/plugins/plugin-panel-bridge'
import { executePluginPanelAction, type PanelActionRuntime } from '../plugins/plugin-panel-actions'
import type { PluginService } from '../plugins/plugin-service'

export function registerPluginHandlers(
  store: Store,
  pluginService: PluginService,
  runtime: PanelActionRuntime | null
): void {
  // Why: startup discovery is fire-and-forget; every handler awaits it so an
  // early renderer fetch can't observe the empty pre-discovery list.
  ipcMain.handle('plugins:list', async () => {
    await pluginService.whenReady()
    return pluginService.listPlugins()
  })

  ipcMain.handle(
    'plugins:setEnabled',
    async (event, args: { pluginId: string; enabled: boolean }) => {
      await pluginService.whenReady()
      const { pluginId, enabled } = args
      if (typeof pluginId !== 'string' || pluginId.length === 0) {
        throw new Error('plugins:setEnabled requires a pluginId')
      }
      return applyPluginEnablement({
        store,
        pluginService,
        pluginId,
        enabled: enabled === true,
        originWebContentsId: event.sender.id
      })
    }
  )

  // Why: the renderer renders panel HTML via a sandboxed iframe srcdoc, so it
  // needs file contents — never a file:// path — across the IPC boundary.
  ipcMain.handle(
    'plugins:readPanelEntry',
    async (_event, args: { pluginId: string; panelId: string }) => {
      await pluginService.whenReady()
      const entryPath = pluginService.getPanelEntryPath(args.pluginId, args.panelId)
      if (!entryPath) {
        return null
      }
      try {
        return { html: await readFile(entryPath, 'utf8') }
      } catch {
        return null
      }
    }
  )

  // Panel-originated actions relayed by PluginPanel's postMessage bridge.
  // Permission enforcement happens here (main), never in the renderer.
  ipcMain.handle(
    'plugins:panelAction',
    async (_event, args: unknown): Promise<PluginPanelActionOutcome> => {
      await pluginService.whenReady()
      const call = panelActionCallSchema.safeParse(args)
      if (!call.success) {
        return { ok: false, code: 'invalid_request', error: 'malformed panel action call' }
      }
      return executePluginPanelAction({
        pluginId: call.data.pluginId,
        action: call.data.action,
        params: call.data.params,
        grantedPermissions: pluginService.getGrantedPermissions(call.data.pluginId),
        runtime
      })
    }
  )

  ipcMain.handle(
    'plugins:invokeCodeProvider',
    async (
      _event,
      args: { pluginId: string; providerId?: string; method: string; args: unknown[] }
    ) => {
      await pluginService.whenReady()
      const { pluginId, method } = args
      if (!isCodeProviderMethod(method)) {
        throw new Error(`unknown code provider method: ${method}`)
      }
      const providerId = typeof args.providerId === 'string' ? args.providerId : undefined
      const provider = pluginService
        .getRegistry()
        .resolve(CODE_PROVIDER_EXTENSION_POINT, pluginId, providerId)
      const implementation = provider?.[method]
      if (!provider || typeof implementation !== 'function') {
        throw new Error(`plugin ${pluginId} does not provide ${method}`)
      }
      const callArgs = Array.isArray(args.args) ? args.args : []
      return await (implementation as (...callArgs: unknown[]) => unknown).apply(provider, callArgs)
    }
  )
}
