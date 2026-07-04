import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { isCodeProviderMethod } from '../../../../shared/plugins/code-provider'
import { CODE_PROVIDER_EXTENSION_POINT } from '../../../../shared/plugins/plugin-extension-registry'
import { panelActionCallSchema } from '../../../../shared/plugins/plugin-panel-bridge'
import { executePluginPanelAction } from '../../../plugins/plugin-panel-actions'
import type { PluginService } from '../../../plugins/plugin-service'

// Why: RpcContext only carries the OrcaRuntimeService, and plugins are a
// separate composition-root service — inject it via module setter the way the
// desktop entry wires it, instead of widening the shared RPC context type.
let pluginServiceForRpc: PluginService | null = null

export function setPluginServiceForRpc(service: PluginService | null): void {
  pluginServiceForRpc = service
}

function requirePluginService(): PluginService {
  if (!pluginServiceForRpc) {
    throw new Error('Plugin service is not available on this runtime')
  }
  return pluginServiceForRpc
}

const PluginInvokeCodeProviderParams = z.object({
  pluginId: z.string().min(1),
  method: z.string().min(1),
  args: z.array(z.unknown()).default([])
})

const PluginReadPanelEntryParams = z.object({
  pluginId: z.string().min(1),
  panelId: z.string().min(1)
})

export const PLUGIN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'plugins.list',
    params: null,
    handler: () => requirePluginService().listPlugins()
  }),
  defineMethod({
    name: 'plugins.invokeCodeProvider',
    params: PluginInvokeCodeProviderParams,
    handler: async (params) => {
      if (!isCodeProviderMethod(params.method)) {
        throw new Error(`unknown code provider method: ${params.method}`)
      }
      const provider = requirePluginService()
        .getRegistry()
        .resolve(CODE_PROVIDER_EXTENSION_POINT, params.pluginId)
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
    handler: async (params, { runtime }) => ({
      outcome: await executePluginPanelAction({
        action: params.action,
        params: params.params,
        grantedPermissions: requirePluginService().getGrantedPermissions(params.pluginId),
        runtime
      })
    })
  }),
  defineMethod({
    name: 'plugins.readPanelEntry',
    params: PluginReadPanelEntryParams,
    handler: async (params) => {
      const entryPath = requirePluginService().getPanelEntryPath(params.pluginId, params.panelId)
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
