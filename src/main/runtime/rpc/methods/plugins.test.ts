import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext, RpcMethod } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { PluginService } from '../../../plugins/plugin-service'
import { PLUGIN_METHODS, setPluginServiceForRpc } from './plugins'

// Why: importing RpcDispatcher would transitively load orca-runtime and its
// node-pty native module; parsing with the method's own schema exercises the
// same validation the dispatcher applies without the native dependency.
function callMethod(
  method: RpcMethod,
  params: unknown,
  runtime: OrcaRuntimeService
): Promise<unknown> | unknown {
  const parsed = method.params ? method.params.parse(params) : undefined
  return method.handler(parsed, { runtime } as RpcContext)
}

function getPanelActionMethod(): RpcMethod {
  const method = PLUGIN_METHODS.find((entry) => entry.name === 'plugins.panelAction')
  if (!method) {
    throw new Error('plugins.panelAction method is not registered')
  }
  return method
}

function makeRuntime(): { runtime: OrcaRuntimeService; sendTerminal: ReturnType<typeof vi.fn> } {
  const sendTerminal = vi
    .fn()
    .mockResolvedValue({ handle: 'term-1', accepted: true, bytesWritten: 10 })
  const runtime = {
    resolveActiveTerminal: vi.fn().mockResolvedValue('term-1'),
    sendTerminal
  } as unknown as OrcaRuntimeService
  return { runtime, sendTerminal }
}

function stubPluginService(permissions: string[] | null): PluginService {
  return {
    getGrantedPermissions: () => permissions,
    whenReady: async () => undefined,
    listPlugins: () => []
  } as unknown as PluginService
}

function getMethod(name: string): RpcMethod {
  const method = PLUGIN_METHODS.find((entry) => entry.name === name)
  if (!method) {
    throw new Error(`${name} method is not registered`)
  }
  return method
}

afterEach(() => {
  setPluginServiceForRpc(null)
})

describe('plugins.panelAction RPC method', () => {
  it('relays a permitted terminal.sendText action to the runtime pty path', async () => {
    setPluginServiceForRpc(stubPluginService(['terminal.sendText']))
    const { runtime, sendTerminal } = makeRuntime()

    const result = await callMethod(
      getPanelActionMethod(),
      {
        pluginId: 'model-shift',
        panelId: 'gear-shifter',
        action: 'terminal.sendText',
        params: { text: '/model opus', enter: true }
      },
      runtime
    )

    expect(result).toEqual({ outcome: { ok: true, value: { accepted: true } } })
    expect(sendTerminal).toHaveBeenCalledWith('term-1', { text: '/model opus', enter: true })
  })

  it('denies the action when the manifest grants no permission', async () => {
    setPluginServiceForRpc(stubPluginService([]))
    const { runtime, sendTerminal } = makeRuntime()

    const result = await callMethod(
      getPanelActionMethod(),
      {
        pluginId: 'model-shift',
        action: 'terminal.sendText',
        params: { text: '/model opus', enter: true }
      },
      runtime
    )

    expect(result).toMatchObject({ outcome: { ok: false, code: 'permission_denied' } })
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('rejects malformed call params at the schema boundary', () => {
    const method = getPanelActionMethod()
    expect(() => method.params?.parse({ action: 'terminal.sendText' })).toThrow()
    expect(() => method.params?.parse({ pluginId: '', action: 'terminal.sendText' })).toThrow()
  })

  it('errors when no plugin service is wired on this runtime', async () => {
    const { runtime } = makeRuntime()

    await expect(
      Promise.resolve(
        callMethod(
          getPanelActionMethod(),
          { pluginId: 'model-shift', action: 'terminal.sendText', params: { text: 'hi' } },
          runtime
        )
      )
    ).rejects.toThrow('Plugin service is not available')
  })
})

describe('plugins.setEnabled RPC method', () => {
  it('routes through the injected enablement closure (headless consent path)', async () => {
    const applyEnablement = vi.fn().mockResolvedValue([{ pluginId: 'model-shift' }])
    setPluginServiceForRpc(stubPluginService([]), applyEnablement)
    const { runtime } = makeRuntime()

    const result = await callMethod(
      getMethod('plugins.setEnabled'),
      { pluginId: 'model-shift', enabled: true },
      runtime
    )

    expect(applyEnablement).toHaveBeenCalledWith('model-shift', true)
    expect(result).toEqual([{ pluginId: 'model-shift' }])
  })

  it('errors when enablement is not wired', async () => {
    setPluginServiceForRpc(stubPluginService([]))
    const { runtime } = makeRuntime()

    await expect(
      Promise.resolve(
        callMethod(getMethod('plugins.setEnabled'), { pluginId: 'x', enabled: false }, runtime)
      )
    ).rejects.toThrow('Plugin enablement is not available')
  })

  it('rejects malformed params at the schema boundary', () => {
    const method = getMethod('plugins.setEnabled')
    expect(() => method.params?.parse({ pluginId: 'x' })).toThrow()
    expect(() => method.params?.parse({ pluginId: '', enabled: true })).toThrow()
  })
})
