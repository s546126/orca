import { readFile } from 'node:fs/promises'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { isCodeProviderMethod } from '../../shared/plugins/code-provider'
import {
  CODE_PROVIDER_EXTENSION_POINT,
  normalizeDisabledPlugins
} from '../../shared/plugins/plugin-extension-registry'
import type { PluginService } from '../plugins/plugin-service'

export function registerPluginHandlers(store: Store, pluginService: PluginService): void {
  ipcMain.handle('plugins:list', () => {
    return pluginService.listPlugins()
  })

  ipcMain.handle(
    'plugins:setEnabled',
    async (event, args: { pluginId: string; enabled: boolean }) => {
      const { pluginId, enabled } = args
      if (typeof pluginId !== 'string' || pluginId.length === 0) {
        throw new Error('plugins:setEnabled requires a pluginId')
      }
      const disabled = new Set(normalizeDisabledPlugins(store.getSettings().disabledPlugins))
      if (enabled) {
        disabled.delete(pluginId)
      } else {
        disabled.add(pluginId)
      }
      store.updateSettings(
        { disabledPlugins: [...disabled] },
        { notifyListeners: true, originWebContentsId: event.sender.id }
      )
      await pluginService.setPluginEnabled(pluginId, enabled === true)
      return pluginService.listPlugins()
    }
  )

  // Why: the renderer renders panel HTML via a sandboxed iframe srcdoc, so it
  // needs file contents — never a file:// path — across the IPC boundary.
  ipcMain.handle(
    'plugins:readPanelEntry',
    async (_event, args: { pluginId: string; panelId: string }) => {
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

  ipcMain.handle(
    'plugins:invokeCodeProvider',
    async (_event, args: { pluginId: string; method: string; args: unknown[] }) => {
      const { pluginId, method } = args
      if (!isCodeProviderMethod(method)) {
        throw new Error(`unknown code provider method: ${method}`)
      }
      const provider = pluginService.getRegistry().resolve(CODE_PROVIDER_EXTENSION_POINT, pluginId)
      const implementation = provider?.[method]
      if (!provider || typeof implementation !== 'function') {
        throw new Error(`plugin ${pluginId} does not provide ${method}`)
      }
      const callArgs = Array.isArray(args.args) ? args.args : []
      return await (implementation as (...callArgs: unknown[]) => unknown).apply(provider, callArgs)
    }
  )
}
