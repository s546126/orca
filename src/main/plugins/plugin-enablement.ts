import { normalizePluginIdList } from '../../shared/plugins/plugin-extension-registry'
import type { Store } from '../persistence'
import type { PluginListEntry, PluginService } from './plugin-service'

/** Single write path for enabling/disabling a plugin. Enabling also records
 *  consent (approvedPlugins), so the desktop IPC handler, the headless RPC
 *  method, and the first-run consent prompt all behave identically. */
export async function applyPluginEnablement(input: {
  store: Store
  pluginService: PluginService
  pluginId: string
  enabled: boolean
  originWebContentsId?: number
}): Promise<PluginListEntry[]> {
  const { store, pluginService, pluginId, enabled } = input
  const settings = store.getSettings()
  const disabled = new Set(normalizePluginIdList(settings.disabledPlugins))
  const approved = new Set(normalizePluginIdList(settings.approvedPlugins))
  if (enabled) {
    disabled.delete(pluginId)
    approved.add(pluginId)
  } else {
    disabled.add(pluginId)
  }
  store.updateSettings(
    { disabledPlugins: [...disabled], approvedPlugins: [...approved] },
    { notifyListeners: true, originWebContentsId: input.originWebContentsId }
  )
  await pluginService.setPluginEnabled(pluginId, enabled)
  return pluginService.listPlugins()
}
