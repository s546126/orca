import type { WebSocket } from 'ws'
import type { CdpMessage } from './cdp-view-gateway-protocol'
import { emptyAutoAttachState, type CdpAutoAttachState } from './cdp-view-gateway-targets'
import type { CdpPageSessionSink, CdpViewPageSession } from './cdp-view-page-session'

export type CdpGatewaySocketKind = 'browser' | 'page'

export type CdpGatewayClient = {
  socket: WebSocket
  kind: CdpGatewaySocketKind
  pageTargetId: string | null
  autoAttach: CdpAutoAttachState
  sessionTargets: Map<string, string>
  ownedBrowserContexts: Set<string>
  targetBrowserContexts: Map<string, string>
  sink: CdpPageSessionSink
}

export type PageSessionRegistry = {
  attach: (
    targetId: string,
    sink: CdpPageSessionSink,
    sessionId: string
  ) => Promise<CdpViewPageSession>
  detachSink: (targetId: string, sink: CdpPageSessionSink) => void
}

let nextSessionSerial = 1

export function createGatewayClient(
  socket: WebSocket,
  kind: CdpGatewaySocketKind,
  pageTargetId: string | null
): CdpGatewayClient {
  return {
    socket,
    kind,
    pageTargetId,
    autoAttach: emptyAutoAttachState(),
    sessionTargets: new Map(),
    ownedBrowserContexts: new Set(),
    targetBrowserContexts: new Map(),
    sink: {
      send: (payload) => sendCdp(socket, payload)
    }
  }
}

export function sendCdp(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

export function sendCdpResult(
  socket: WebSocket,
  id: number | undefined,
  result: unknown,
  sessionId?: string
): void {
  if (id !== undefined) {
    sendCdp(socket, sessionId ? { id, result, sessionId } : { id, result })
  }
}

export function sendCdpError(
  socket: WebSocket,
  id: number | undefined,
  error: unknown,
  sessionId?: string
): void {
  if (id === undefined) {
    return
  }
  const payload = {
    id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error)
    },
    ...(sessionId ? { sessionId } : {})
  }
  sendCdp(socket, payload)
}

export async function attachClientToTarget(
  client: CdpGatewayClient,
  sessions: PageSessionRegistry,
  targetId: string
): Promise<string> {
  const sessionId = `orca-view-${targetId}-${nextSessionSerial++}`
  client.sessionTargets.set(sessionId, targetId)
  await sessions.attach(targetId, client.sink, sessionId)
  return sessionId
}

export function targetIdForSession(client: CdpGatewayClient, message: CdpMessage): string | null {
  if (message.sessionId) {
    return client.sessionTargets.get(message.sessionId) ?? null
  }
  return null
}
