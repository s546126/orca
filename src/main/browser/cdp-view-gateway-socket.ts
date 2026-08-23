import type { CdpMessage, CdpViewGatewayController } from './cdp-view-gateway-protocol'
import { parseCdpMessage } from './cdp-view-gateway-protocol'
import {
  handleBrowserTargetCommand,
  handlePageTargetCommand
} from './cdp-view-gateway-target-commands'
import {
  sendCdpError,
  sendCdpResult,
  targetIdForSession,
  type CdpGatewayClient,
  type PageSessionRegistry
} from './cdp-view-gateway-client'
import { chromeBrowserVersion } from './cdp-view-gateway-targets'

export type {
  CdpGatewayClient,
  CdpGatewaySocketKind,
  PageSessionRegistry
} from './cdp-view-gateway-client'
export { createGatewayClient, sendCdp } from './cdp-view-gateway-client'

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
      sendCdpResult(client.socket, message.id, {}, message.sessionId)
      setTimeout(() => client.socket.close(1000, 'automation client disconnected'), 10)
      return
    }
    if (client.kind === 'page' && client.pageTargetId) {
      await handlePageSocketCommand(client, controller, sessions, message, client.pageTargetId)
      return
    }
    await handleBrowserSocketCommand(client, controller, sessions, message)
  } catch (error) {
    sendCdpError(client.socket, message.id, error, message.sessionId)
  }
}

async function handleBrowserSocketCommand(
  client: CdpGatewayClient,
  controller: CdpViewGatewayController,
  sessions: PageSessionRegistry,
  message: CdpMessage
): Promise<void> {
  const routedTargetId = targetIdForSession(client, message)
  if (routedTargetId) {
    await handlePageSocketCommand(client, controller, sessions, message, routedTargetId)
    return
  }

  if (message.method === 'Browser.getVersion') {
    sendCdpResult(client.socket, message.id, chromeBrowserVersion())
    return
  }
  if (message.method?.startsWith('Browser.')) {
    // Why: Playwright context init sends Browser.setDownloadBehavior and other
    // Browser.* calls. Stub them so connectOverCDP can attach to the live view.
    sendCdpResult(client.socket, message.id, {})
    return
  }
  if (await handleBrowserTargetCommand(client, controller, sessions, message)) {
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
      message.method === 'Target.closeTarget' ? { success: true } : {},
      message.sessionId
    )
    return
  }
  if (message.method === 'Page.bringToFront' || message.method === 'Target.activateTarget') {
    await controller.activateTarget(targetId)
    sendCdpResult(client.socket, message.id, {}, message.sessionId)
    return
  }
  if (await handlePageTargetCommand(client, controller, message, targetId)) {
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
