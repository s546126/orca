import { createServer, type IncomingMessage, type Server } from 'http'
import { WebSocketServer } from 'ws'
import { handleCdpViewHttpRequest } from './cdp-view-gateway-http'
import {
  isBrowserSocketPath,
  normalizedHttpPath,
  pageTargetFromPath,
  type CdpViewGateway,
  type CdpViewGatewayController,
  type CdpViewTab
} from './cdp-view-gateway-protocol'
import { CdpViewPageSession, type CdpPageSessionSink } from './cdp-view-page-session'
import {
  announceCreatedTarget,
  announceDestroyedTarget,
  pageTargetInfo
} from './cdp-view-gateway-auto-attach'
import { sendCdp, type CdpGatewayClient } from './cdp-view-gateway-client'
import { createGatewayClient, handleGatewayClientMessage } from './cdp-view-gateway-socket'

export async function startCdpViewGateway(
  controller: CdpViewGatewayController
): Promise<CdpViewGateway> {
  const clients = new Set<CdpGatewayClient>()
  const pageSessions = new Map<string, CdpViewPageSession>()
  let closed = false
  let port = 0

  const httpServer = await listenLocalhost()
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    httpServer.close()
    throw new Error('Failed to bind CDP view gateway')
  }
  port = address.port
  const host = `127.0.0.1:${port}`

  const urls = {
    host,
    browserWebSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(controller.viewId)}`,
    pageWebSocketUrl: (targetId: string) =>
      `ws://127.0.0.1:${port}/devtools/page/${encodeURIComponent(targetId)}`
  }

  httpServer.on('request', (req, res) => {
    void handleCdpViewHttpRequest(req, res, controller, urls).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      }
      res.end(error instanceof Error ? error.message : String(error))
    })
  })

  const wss = new WebSocketServer({ noServer: true })
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = upgradePath(request)
    const pageTargetId = pageTargetFromPath(pathname)
    if (!isBrowserSocketPath(pathname) && !pageTargetId) {
      socket.destroy()
      return
    }
    if (pageTargetId && !controller.ownsTarget(pageTargetId)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const client = createGatewayClient(ws, pageTargetId ? 'page' : 'browser', pageTargetId)
      clients.add(client)
      if (pageTargetId) {
        void attachPageSession(pageTargetId, client.sink, `orca-view-root-${pageTargetId}`)
      }
      ws.on('message', (data) => {
        void handleGatewayClientMessage(client, controller, sessionRegistry, data.toString())
      })
      ws.on('close', () => {
        clients.delete(client)
        detachClientSessions(client)
      })
    })
  })

  const sessionRegistry = {
    attach: attachPageSession,
    detachSink: detachPageSink
  }

  async function attachPageSession(
    targetId: string,
    sink: CdpPageSessionSink,
    sessionId: string
  ): Promise<CdpViewPageSession> {
    let session = pageSessions.get(targetId)
    if (!session) {
      const webContents = controller.getWebContents(targetId)
      if (!webContents || webContents.isDestroyed()) {
        throw new Error(`Browser tab is no longer available: ${targetId}`)
      }
      session = new CdpViewPageSession(webContents, targetId)
      pageSessions.set(targetId, session)
      await session.attach()
    }
    session.addSink(sink, sessionId)
    return session
  }

  function detachPageSink(targetId: string, sink: CdpPageSessionSink): void {
    const session = pageSessions.get(targetId)
    if (!session) {
      return
    }
    session.removeSink(sink)
    if (session.sinkCount === 0) {
      session.dispose()
      pageSessions.delete(targetId)
    }
  }

  function detachClientSessions(client: CdpGatewayClient): void {
    const targetIds = new Set(client.sessionTargets.values())
    if (client.pageTargetId) {
      targetIds.add(client.pageTargetId)
    }
    for (const targetId of targetIds) {
      detachPageSink(targetId, client.sink)
    }
  }

  return {
    viewId: controller.viewId,
    httpUrl: `http://127.0.0.1:${port}`,
    browserWebSocketUrl: urls.browserWebSocketUrl,
    pageWebSocketUrl: urls.pageWebSocketUrl,
    notifyTargetCreated: (tab: CdpViewTab) => {
      void announceCreatedTarget(clients, tab, controller.viewId, sessionRegistry)
    },
    notifyTargetDestroyed: (targetId: string) => {
      const session = pageSessions.get(targetId)
      session?.dispose()
      pageSessions.delete(targetId)
      announceDestroyedTarget(clients, targetId)
    },
    notifyTargetInfoChanged: (tab: CdpViewTab) => {
      for (const client of clients) {
        if (client.kind !== 'browser' || !client.autoAttach.discoverTargets) {
          continue
        }
        sendCdp(client.socket, {
          method: 'Target.targetInfoChanged',
          params: { targetInfo: pageTargetInfo(client, tab, controller.viewId, false) }
        })
      }
    },
    close: async () => {
      if (closed) {
        return
      }
      closed = true
      for (const client of clients) {
        client.socket.close(1001, 'browser view closed')
      }
      clients.clear()
      for (const session of pageSessions.values()) {
        session.dispose()
      }
      pageSessions.clear()
      await closeServer(wss, httpServer)
    }
  }
}

function upgradePath(request: IncomingMessage): string {
  try {
    return normalizedHttpPath(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
  } catch {
    return '/'
  }
}

function listenLocalhost(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const onError = (error: Error): void => {
      server.off('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve(server)
    })
  })
}

function closeServer(wss: WebSocketServer, httpServer: Server): Promise<void> {
  return new Promise((resolve) => {
    wss.close()
    httpServer.close(() => resolve())
  })
}
