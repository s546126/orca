import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { startCdpViewGateway } from './cdp-view-gateway'
import type {
  CdpViewGateway,
  CdpViewGatewayController,
  CdpViewTab
} from './cdp-view-gateway-protocol'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

type DebuggerListener = (...args: unknown[]) => void

function createMockWebContents() {
  const listeners = new Map<string, DebuggerListener[]>()
  let debuggerAttached = false
  const debuggerObj = {
    isAttached: vi.fn(() => debuggerAttached),
    attach: vi.fn(() => {
      debuggerAttached = true
    }),
    detach: vi.fn(() => {
      debuggerAttached = false
    }),
    sendCommand: vi.fn(async () => ({})),
    on: vi.fn((event: string, handler: DebuggerListener) => {
      const arr = listeners.get(event) ?? []
      arr.push(handler)
      listeners.set(event, arr)
    }),
    removeListener: vi.fn((event: string, handler: DebuggerListener) => {
      const arr = listeners.get(event) ?? []
      listeners.set(
        event,
        arr.filter((item) => item !== handler)
      )
    })
  }
  return {
    debugger: debuggerObj,
    isDestroyed: () => false,
    focus: vi.fn(),
    getTitle: vi.fn(() => 'Example'),
    getURL: vi.fn(() => 'https://example.com')
  }
}

function createController(tabs: CdpViewTab[]): CdpViewGatewayController {
  const owned = new Set(tabs.map((tab) => tab.targetId))
  const guests = new Map(tabs.map((tab) => [tab.targetId, createMockWebContents()]))
  return {
    viewId: 'wt-1',
    listTabs: async () => tabs,
    ownsTarget: (targetId) => owned.has(targetId),
    getWebContents: (targetId) => guests.get(targetId) as never,
    createTarget: async (url) => {
      const tab = { targetId: 'page-new', url, title: 'New', active: true }
      tabs.push(tab)
      owned.add(tab.targetId)
      guests.set(tab.targetId, createMockWebContents())
      return tab
    },
    activateTarget: async (targetId) => {
      for (const tab of tabs) {
        tab.active = tab.targetId === targetId
      }
      const tab = tabs.find((entry) => entry.targetId === targetId)
      if (!tab) {
        throw new Error(`missing ${targetId}`)
      }
      return tab
    },
    closeTarget: async (targetId) => {
      const index = tabs.findIndex((tab) => tab.targetId === targetId)
      if (index >= 0) {
        tabs.splice(index, 1)
      }
      owned.delete(targetId)
    }
  }
}

async function cdpCall(
  ws: WebSocket,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (message.id !== id) {
        return
      }
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params, sessionId }))
    setTimeout(() => reject(new Error(`CDP timeout for ${method}`)), 2_000)
  })
}

describe('CdpViewGateway', () => {
  const gateways: CdpViewGateway[] = []

  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()))
  })

  it('exposes Chrome-shaped HTTP discovery for a view', async () => {
    const gateway = await startCdpViewGateway(
      createController([
        { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true }
      ])
    )
    gateways.push(gateway)

    const version = await (await fetch(`${gateway.httpUrl}/json/version`)).json()
    expect(version.webSocketDebuggerUrl).toBe(gateway.browserWebSocketUrl)
    expect(version.Browser).toMatch(/^Chrome\//)

    const list = (await (await fetch(`${gateway.httpUrl}/json/list`)).json()) as {
      id: string
      webSocketDebuggerUrl: string
    }[]
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('page-1')
    expect(list[0].webSocketDebuggerUrl).toBe(gateway.pageWebSocketUrl('page-1'))
  })

  it('creates, activates, and closes targets through HTTP and Target domain', async () => {
    const controller = createController([
      { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true }
    ])
    const gateway = await startCdpViewGateway(controller)
    gateways.push(gateway)

    const created = await (
      await fetch(`${gateway.httpUrl}/json/new?url=${encodeURIComponent('https://created.test')}`, {
        method: 'PUT'
      })
    ).json()
    expect(created.id).toBe('page-new')

    const ws = new WebSocket(gateway.browserWebSocketUrl)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    const targets = await cdpCall(ws, 1, 'Target.getTargets')
    const infos = (targets.result as { targetInfos: { targetId: string }[] }).targetInfos
    expect(infos.map((info) => info.targetId)).toEqual(['page-1', 'page-new'])

    await cdpCall(ws, 2, 'Target.activateTarget', { targetId: 'page-new' })
    expect((await controller.listTabs()).find((tab) => tab.targetId === 'page-new')?.active).toBe(
      true
    )

    await cdpCall(ws, 3, 'Target.closeTarget', { targetId: 'page-1' })
    expect((await controller.listTabs()).map((tab) => tab.targetId)).toEqual(['page-new'])
    ws.close()
  })

  it('rejects foreign targets and treats Browser.close as client disconnect', async () => {
    const gateway = await startCdpViewGateway(
      createController([
        { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true }
      ])
    )
    gateways.push(gateway)

    const ws = new WebSocket(gateway.browserWebSocketUrl)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    const error = await cdpCall(ws, 1, 'Target.activateTarget', { targetId: 'other-view-page' })
    expect(error.error).toMatchObject({
      message: expect.stringContaining('not owned by browser view wt-1')
    })

    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()))
    await cdpCall(ws, 2, 'Browser.close')
    await closed
    expect((await fetch(`${gateway.httpUrl}/json/version`)).ok).toBe(true)
  })

  it('attaches a page session and forwards Runtime.evaluate', async () => {
    const controller = createController([
      { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true }
    ])
    const gateway = await startCdpViewGateway(controller)
    gateways.push(gateway)
    const guest = controller.getWebContents('page-1')
    if (!guest) {
      throw new Error('expected page-1 webContents')
    }
    ;(guest.debugger.sendCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: { value: 'ok' }
    })

    const ws = new WebSocket(gateway.browserWebSocketUrl)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    const attached = await cdpCall(ws, 1, 'Target.attachToTarget', {
      targetId: 'page-1',
      flatten: true
    })
    const sessionId = (attached.result as { sessionId: string }).sessionId
    const evaluated = await cdpCall(ws, 2, 'Runtime.evaluate', { expression: '1+1' }, sessionId)
    expect(evaluated.result).toEqual({ result: { value: 'ok' } })
    expect(guest.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: '1+1'
    })
    ws.close()
  })
})
