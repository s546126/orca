import WebSocket from 'ws'
import type { CdpViewGatewayController, CdpViewTab } from './cdp-view-gateway-protocol'

type DebuggerListener = (...args: unknown[]) => void

export type MockCdpWebContents = {
  debugger: {
    isAttached: () => boolean
    attach: () => void
    detach: () => void
    sendCommand: (...args: unknown[]) => Promise<unknown>
    on: (event: string, handler: DebuggerListener) => void
    removeListener: (event: string, handler: DebuggerListener) => void
  }
  isDestroyed: () => boolean
  focus: () => void
  getTitle: () => string
  getURL: () => string
}

export function createMockWebContents(): MockCdpWebContents {
  const listeners = new Map<string, DebuggerListener[]>()
  let debuggerAttached = false
  return {
    debugger: {
      isAttached: () => debuggerAttached,
      attach: () => {
        debuggerAttached = true
      },
      detach: () => {
        debuggerAttached = false
      },
      sendCommand: async () => ({}),
      on: (event: string, handler: DebuggerListener) => {
        const arr = listeners.get(event) ?? []
        arr.push(handler)
        listeners.set(event, arr)
      },
      removeListener: (event: string, handler: DebuggerListener) => {
        const arr = listeners.get(event) ?? []
        listeners.set(
          event,
          arr.filter((item) => item !== handler)
        )
      }
    },
    isDestroyed: () => false,
    focus: () => undefined,
    getTitle: () => 'Example',
    getURL: () => 'https://example.com'
  }
}

export type TestCdpController = CdpViewGatewayController & {
  addTab: (tab: CdpViewTab) => void
}

export function createController(tabs: CdpViewTab[]): TestCdpController {
  const owned = new Set(tabs.map((tab) => tab.targetId))
  const guests = new Map(tabs.map((tab) => [tab.targetId, createMockWebContents()]))
  return {
    viewId: 'wt-1',
    listTabs: async () => tabs,
    ownsTarget: (targetId) => owned.has(targetId),
    getWebContents: (targetId) => guests.get(targetId) as never,
    addTab: (tab) => {
      tabs.push(tab)
      owned.add(tab.targetId)
      guests.set(tab.targetId, createMockWebContents())
    },
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

export async function openBrowserSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  return ws
}

export async function cdpCall(
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

export async function cdpCallCollectingEvents(
  ws: WebSocket,
  id: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<{ response: Record<string, unknown>; events: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const events: Record<string, unknown>[] = []
    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (typeof message.method === 'string') {
        events.push(message)
      }
      if (message.id !== id) {
        return
      }
      ws.off('message', onMessage)
      resolve({ response: message, events })
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => reject(new Error(`CDP timeout for ${method}`)), 2_000)
  })
}
