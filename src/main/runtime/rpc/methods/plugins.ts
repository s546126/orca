import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { isCodeProviderMethod } from '../../../../shared/plugins/code-provider'
import { CODE_PROVIDER_EXTENSION_POINT } from '../../../../shared/plugins/plugin-extension-registry'
import { panelActionCallSchema } from '../../../../shared/plugins/plugin-panel-bridge'
import { executePluginPanelAction } from '../../../plugins/plugin-panel-actions'
import type { PluginListEntry, PluginService } from '../../../plugins/plugin-service'

// Why: RpcContext only carries the OrcaRuntimeService, and plugins are a
// separate composition-root service — inject it via module setter the way the
// desktop entry wires it, instead of widening the shared RPC context type.
let pluginServiceForRpc: PluginService | null = null
// Enablement needs the settings Store too, so the entry injects a bound
// closure instead of the store itself.
let pluginEnablementForRpc:
  | ((pluginId: string, enabled: boolean) => Promise<PluginListEntry[]>)
  | null = null

export function setPluginServiceForRpc(
  service: PluginService | null,
  applyEnablement?: (pluginId: string, enabled: boolean) => Promise<PluginListEntry[]>
): void {
  pluginServiceForRpc = service
  pluginEnablementForRpc = applyEnablement ?? null
}

function requirePluginService(): PluginService {
  if (!pluginServiceForRpc) {
    throw new Error('Plugin service is not available on this runtime')
  }
  return pluginServiceForRpc
}

const PluginInvokeCodeProviderParams = z.object({
  pluginId: z.string().min(1),
  /** Required to reach the second+ provider of a multi-provider plugin. */
  providerId: z.string().min(1).optional(),
  method: z.string().min(1),
  args: z.array(z.unknown()).default([])
})

const PluginReadPanelEntryParams = z.object({
  pluginId: z.string().min(1),
  panelId: z.string().min(1)
})

const PluginSetEnabledParams = z.object({
  pluginId: z.string().min(1),
  enabled: z.boolean()
})

export const PLUGIN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'plugins.list',
    params: null,
    handler: async () => {
      // Why: startup discovery is fire-and-forget; await it so an early call
      // can't observe the empty pre-discovery list.
      const service = requirePluginService()
      await service.whenReady()
      return service.listPlugins()
    }
  }),
  defineMethod({
    // Why: headless serve has no consent dialog — an explicit enable call is
    // the only way a pending (never-approved) plugin starts on a server.
    name: 'plugins.setEnabled',
    params: PluginSetEnabledParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      if (!pluginEnablementForRpc) {
        throw new Error('Plugin enablement is not available on this runtime')
      }
      return pluginEnablementForRpc(params.pluginId, params.enabled)
    }
  }),
  defineMethod({
    name: 'plugins.invokeCodeProvider',
    params: PluginInvokeCodeProviderParams,
    handler: async (params) => {
      if (!isCodeProviderMethod(params.method)) {
        throw new Error(`unknown code provider method: ${params.method}`)
      }
      const service = requirePluginService()
      await service.whenReady()
      const provider = service
        .getRegistry()
        .resolve(CODE_PROVIDER_EXTENSION_POINT, params.pluginId, params.providerId)
      const implementation = provider?.[params.method]
      if (!provider || typeof implementation !== 'function') {
        throw new Error(`plugin ${params.pluginId} does not provide ${params.method}`)
      }
      return await (implementation as (...args: unknown[]) => unknown).apply(provider, params.args)
    }
  }),
  defineMethod({
    // Why: headless serve clients relay panel bridge requests over RPC, so
    // permission enforcement must live behind this method too, not only in
    // the desktop IPC handler.
    name: 'plugins.panelAction',
    params: panelActionCallSchema,
    handler: async (params, { runtime }) => {
      const service = requirePluginService()
      await service.whenReady()
      return {
        outcome: await executePluginPanelAction({
          pluginId: params.pluginId,
          action: params.action,
          params: params.params,
          grantedPermissions: service.getGrantedPermissions(params.pluginId),
          runtime
        })
      }
    }
  }),
  defineMethod({
    name: 'plugins.readPanelEntry',
    params: PluginReadPanelEntryParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      const entryPath = service.getPanelEntryPath(params.pluginId, params.panelId)
      if (!entryPath) {
        return null
      }
      try {
        return { html: await readFile(entryPath, 'utf8') }
      } catch {
        return null
      }
    }
  })
]
