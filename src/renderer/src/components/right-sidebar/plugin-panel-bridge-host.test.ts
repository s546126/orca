import { describe, expect, it, vi } from 'vitest'
import type { PluginPanelActionOutcome } from '../../../../shared/plugins/plugin-panel-bridge'
import { createPanelBridgeMessageHandler } from './plugin-panel-bridge-host'

type FakePanelWindow = Window & { postMessage: ReturnType<typeof vi.fn> }

function createFakePanelWindow(): FakePanelWindow {
  return { postMessage: vi.fn() } as unknown as FakePanelWindow
}

function messageEvent(data: unknown, source: unknown): MessageEvent {
  // The handler only reads .data and .source, so a plain object stands in for
  // a real MessageEvent without needing a DOM environment.
  return { data, source } as unknown as MessageEvent
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const VALID_DATA = {
  type: 'orca-panel-action',
  requestId: 'req-1',
  action: 'terminal.sendText',
  params: { text: '/model haiku', enter: true }
}

function createHandler(
  panelWindow: FakePanelWindow,
  outcome: PluginPanelActionOutcome = { ok: true, value: { accepted: true } }
): { handler: (event: MessageEvent) => void; callPanelAction: ReturnType<typeof vi.fn> } {
  const callPanelAction = vi.fn().mockResolvedValue(outcome)
  const handler = createPanelBridgeMessageHandler({
    pluginId: 'model-shift',
    panelId: 'gear-shifter',
    getPanelWindow: () => panelWindow,
    callPanelAction
  })
  return { handler, callPanelAction }
}

describe('createPanelBridgeMessageHandler', () => {
  it('relays a valid request and posts the success result back into the panel', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelAction } = createHandler(panelWindow)

    handler(messageEvent(VALID_DATA, panelWindow))
    await flush()

    expect(callPanelAction).toHaveBeenCalledWith({
      pluginId: 'model-shift',
      panelId: 'gear-shifter',
      action: 'terminal.sendText',
      params: { text: '/model haiku', enter: true }
    })
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      {
        type: 'orca-panel-action-result',
        requestId: 'req-1',
        ok: true,
        value: { accepted: true }
      },
      '*'
    )
  })

  it('ignores messages whose source is not the panel iframe window', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelAction } = createHandler(panelWindow)

    handler(messageEvent(VALID_DATA, createFakePanelWindow()))
    handler(messageEvent(VALID_DATA, null))
    await flush()

    expect(callPanelAction).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).not.toHaveBeenCalled()
  })

  it('ignores unrelated window messages without replying', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelAction } = createHandler(panelWindow)

    handler(messageEvent({ type: 'react-devtools-bridge' }, panelWindow))
    handler(messageEvent('plain string', panelWindow))
    await flush()

    expect(callPanelAction).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).not.toHaveBeenCalled()
  })

  it('answers a malformed bridge request with invalid_request instead of relaying it', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelAction } = createHandler(panelWindow)

    handler(messageEvent({ ...VALID_DATA, action: 'fs.readFile' }, panelWindow))
    await flush()

    expect(callPanelAction).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-panel-action-result',
        requestId: 'req-1',
        ok: false,
        errorCode: 'invalid_request'
      }),
      '*'
    )
  })

  it('relays a denial outcome (missing manifest permission) back to the panel', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler } = createHandler(panelWindow, {
      ok: false,
      code: 'permission_denied',
      error: 'plugin does not have the "terminal.sendText" permission'
    })

    handler(messageEvent(VALID_DATA, panelWindow))
    await flush()

    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      {
        type: 'orca-panel-action-result',
        requestId: 'req-1',
        ok: false,
        errorCode: 'permission_denied',
        error: 'plugin does not have the "terminal.sendText" permission'
      },
      '*'
    )
  })

  it('reports a rejected relay call as action_failed', async () => {
    const panelWindow = createFakePanelWindow()
    const callPanelAction = vi.fn().mockRejectedValue(new Error('ipc broke'))
    const handler = createPanelBridgeMessageHandler({
      pluginId: 'model-shift',
      panelId: 'gear-shifter',
      getPanelWindow: () => panelWindow,
      callPanelAction
    })

    handler(messageEvent(VALID_DATA, panelWindow))
    await flush()

    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, errorCode: 'action_failed', error: 'ipc broke' }),
      '*'
    )
  })
})
