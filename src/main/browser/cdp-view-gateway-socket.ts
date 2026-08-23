import type { WebSocket } from 'ws'
import type { CdpMessage, CdpViewGatewayController, CdpViewTab } from './cdp-view-gateway-protocol'
import { parseCdpMessage } from './cdp-view-gateway-protocol'
import {
  applyAutoAttachCommand,
  chromeBrowserVersion,
  emptyAutoAttachState,
  requiredOwnedTargetId,
  targetInfoFromTab,
  type CdpAutoAttachState
} from './cdp-view-gateway-targets'
import type { CdpPageSessionSink, CdpViewPageSession } from './cdp-view-page-session'

export type CdpGatewaySocketKind = 'browser' | 'page'

export type CdpGatewayClient = {
  socket: WebSocket
  kind: CdpGatewaySocketKind
  pageTargetId: string | null
  autoAttach: CdpAutoAttachState
  sessionTargets: Map<string, string>
  ownedBrowserContexts: Set<string>
  sink: CdpPageSessionSink
}

type PageSessionRegistry = {
  attach: (
    targetId: string,
    sink: CdpPageSessionSink,
    sessionId: string
  ) => Promise<CdpViewPageSession>
  detachSink: (targetId: string, sink: CdpPageSessionSink) => void
}

let nextSessionSerial = 1
let nextContextSerial = 1

export function createGatewayClient(
  socket: WebSocket,
  kind: CdpGatewaySocketKind,
  pageTargetId: string | null
): CdpGatewayClient {
  const client: CdpGatewayClient = {
    socket,
    kind,
    pageTargetId,
    autoAttach: emptyAutoAttachState(),
    sessionTargets: new Map(),
    ownedBrowserContexts: new Set(),
    sink: {
      send: (payload) => sendCdp(socket, payload)
    }
  }
  return client
}

export function sendCdp(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

export function sendCdpResult(socket: WebSocket, id: number | undefined, result: unknown): void {
  if (id !== undefined) {
    sendCdp(socket, { id, result })
  }
}

export function sendCdpError(socket: WebSocket, id: number | undefined, error: unknown): void {
  if (id !== undefined) {
    sendCdp(socket, {
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error)
      }
    })
  }
}

export async function handleGatewayClientMessage(
  client: CdpGatewayClient,
  controller: CdpViewGatewayController,
  sessions: PageSessionRegistry,
  raw: string
): Promise<void> {
  const message = parseCdpMessage(raw)
  if (!message || message.id == null || !message.method) {
    return
  }

  try {
    if (message.method === 'Browser.close') {
      sendCdpResult(client.socket, message.id, {})
      setTimeout(() => client.socket.close(1000, 'automation client disconnected'), 10)
      return
    }
    if (client.kind === 'page' && client.pageTargetId) {
      await handlePageSocketCommand(client, controller, sessions, message, client.pageTargetId)
      return
    }
    await handleBrowserSocketCommand(client, controller, sessions, message)
  } catch (error) {
    sendCdpError(client.socket, message.id, error)
  }
}

async function handleBrowserSocketCommand(
  client: CdpGatewayClient,
  controller: CdpViewGatewayController,
  sessions: PageSessionRegistry,
  message: CdpMessage
): Promise<void> {
  const params = message.params ?? {}
  const routedTargetId = targetIdForSession(client, message)
  if (routedTargetId) {
    await handlePageSocketCommand(client, controller, sessions, message, routedTargetId)
    return
  }

  if (message.method === 'Browser.getVersion') {
    sendCdpResult(client.socket, message.id, chromeBrowserVersion())
    return
  }
  if (message.method === 'Target.setDiscoverTargets' || message.method === 'Target.setAutoAttach') {
    client.autoAttach = applyAutoAttachCommand(client.autoAttach, message)
    sendCdpResult(client.socket, message.id, {})
    return
  }
  if (message.method === 'Target.getTargets') {
    const tabs = await controller.listTabs()
    sendCdpResult(client.socket, message.id, {
      targetInfos: tabs.map((tab) =>
        targetInfoFromTab(tab, [...client.sessionTargets.values()].includes(tab.targetId))
      )
    })
    return
  }
  if (message.method === 'Target.getTargetInfo') {
    const targetId = requiredOwnedTargetId(params, controller.ownsTarget, controller.viewId)
    const tab = (await controller.listTabs()).find((entry) => entry.targetId === targetId)
    if (!tab) {
      throw new Error(`target is not owned by browser view ${controller.viewId}: ${targetId}`)
    }
    sendCdpResult(client.socket, message.id, {
      targetInfo: targetInfoFromTab(tab, [...client.sessionTargets.values()].includes(tab.targetId))
    })
    return
  }
  if (message.method === 'Target.attachToTarget') {
    const targetId = requiredOwnedTargetId(params, controller.ownsTarget, controller.viewId)
    const sessionId = await attachClientToTarget(client, sessions, targetId)
    sendCdpResult(client.socket, message.id, { sessionId })
    return
  }
  if (message.method === 'Target.detachFromTarget') {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null
    const targetId = sessionId ? client.sessionTargets.get(sessionId) : null
    if (sessionId) {
      client.sessionTargets.delete(sessionId)
    }
    if (targetId) {
      sessions.detachSink(targetId, client.sink)
    }
    sendCdpResult(client.socket, message.id, {})
    return
  }
  if (message.method === 'Target.createTarget') {
    const url = typeof params.url === 'string' && params.url !== '' ? params.url : 'about:blank'
    const tab = await controller.createTarget(url)
    if (client.autoAttach.autoAttach) {
      await attachClientToTarget(client, sessions, tab.targetId)
    }
    sendCdpResult(client.socket, message.id, { targetId: tab.targetId })
    return
  }
  if (message.method === 'Target.activateTarget') {
    const targetId = requiredOwnedTargetId(params, controller.ownsTarget, controller.viewId)
    await controller.activateTarget(targetId)
    sendCdpResult(client.socket, message.id, {})
    return
  }
  if (message.method === 'Target.closeTarget') {
    const targetId = requiredOwnedTargetId(params, controller.ownsTarget, controller.viewId)
    await controller.closeTarget(targetId)
    sendCdpResult(client.socket, message.id, { success: true })
    return
  }
  if (message.method === 'Target.getBrowserContexts') {
    sendCdpResult(client.socket, message.id, {
      browserContextIds: [...client.ownedBrowserContexts]
    })
    return
  }
  if (message.method === 'Target.createBrowserContext') {
    const browserContextId = `orca-view-context-${nextContextSerial++}`
    client.ownedBrowserContexts.add(browserContextId)
    sendCdpResult(client.socket, message.id, { browserContextId })
    return
  }
  if (message.method === 'Target.disposeBrowserContext') {
    const browserContextId =
      typeof params.browserContextId === 'string' ? params.browserContextId : null
    if (browserContextId) {
      client.ownedBrowserContexts.delete(browserContextId)
    }
    sendCdpResult(client.socket, message.id, {})
    return
  }

  throw new Error(`Unsupported browser CDP method: ${message.method}`)
}

async function handlePageSocketCommand(
  client: CdpGatewayClient,
  controller: CdpViewGatewayController,
  sessions: PageSessionRegistry,
  message: CdpMessage,
  targetId: string
): Promise<void> {
  if (!controller.ownsTarget(targetId)) {
    throw new Error(`target is not owned by browser view ${controller.viewId}: ${targetId}`)
  }
  if (message.method === 'Page.close' || message.method === 'Target.closeTarget') {
    await controller.closeTarget(targetId)
    sendCdpResult(
      client.socket,
      message.id,
      message.method === 'Target.closeTarget' ? { success: true } : {}
    )
    return
  }
  if (message.method === 'Page.bringToFront' || message.method === 'Target.activateTarget') {
    await controller.activateTarget(targetId)
    sendCdpResult(client.socket, message.id, {})
    return
  }
  const sessionId =
    message.sessionId && client.sessionTargets.has(message.sessionId)
      ? message.sessionId
      : `orca-view-root-${targetId}`
  const session = await sessions.attach(targetId, client.sink, sessionId)
  session.handleCommand(
    {
      id: message.id!,
      method: message.method ?? '',
      params: message.params ?? {},
      sessionId: message.sessionId
    },
    client.sink
  )
}

async function attachClientToTarget(
  client: CdpGatewayClient,
  sessions: PageSessionRegistry,
  targetId: string
): Promise<string> {
  const sessionId = `orca-view-${targetId}-${nextSessionSerial++}`
  client.sessionTargets.set(sessionId, targetId)
  await sessions.attach(targetId, client.sink, sessionId)
  return sessionId
}

function targetIdForSession(client: CdpGatewayClient, message: CdpMessage): string | null {
  if (message.sessionId) {
    return client.sessionTargets.get(message.sessionId) ?? null
  }
  return null
}

export function emitTargetLifecycle(
  clients: Iterable<CdpGatewayClient>,
  method: 'Target.targetCreated' | 'Target.targetDestroyed' | 'Target.targetInfoChanged',
  tabOrId: CdpViewTab | string
): void {
  for (const client of clients) {
    if (client.kind !== 'browser' || !client.autoAttach.discoverTargets) {
      continue
    }
    if (method === 'Target.targetDestroyed' && typeof tabOrId === 'string') {
      sendCdp(client.socket, { method, params: { targetId: tabOrId } })
      continue
    }
    if (typeof tabOrId !== 'string') {
      sendCdp(client.socket, {
        method,
        params: { targetInfo: targetInfoFromTab(tabOrId, false) }
      })
    }
  }
}
