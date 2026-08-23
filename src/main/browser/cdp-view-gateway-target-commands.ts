import type { CdpMessage, CdpViewGatewayController } from './cdp-view-gateway-protocol'
import {
  attachExistingPageTargets,
  discoverExistingPageTargets,
  emitAttachedToTarget,
  pageTargetInfo
} from './cdp-view-gateway-auto-attach'
import {
  attachClientToTarget,
  sendCdp,
  sendCdpResult,
  type CdpGatewayClient,
  type PageSessionRegistry
} from './cdp-view-gateway-client'
import {
  applyAutoAttachCommand,
  browserTargetId,
  browserTargetInfo,
  requiredOwnedTargetId
} from './cdp-view-gateway-targets'

let nextContextSerial = 1

export async function handleBrowserTargetCommand(
  client: CdpGatewayClient,
  controller: CdpViewGatewayController,
  sessions: PageSessionRegistry,
  message: CdpMessage
): Promise<boolean> {
  if (!message.method?.startsWith('Target.')) {
    return false
  }
  const params = message.params ?? {}
  if (message.method === 'Target.setDiscoverTargets') {
    client.autoAttach = applyAutoAttachCommand(client.autoAttach, message)
    if (client.autoAttach.discoverTargets) {
      await discoverExistingPageTargets(client, controller)
    }
    sendCdpResult(client.socket, message.id, {})
    return true
  }
  if (message.method === 'Target.setAutoAttach') {
    client.autoAttach = applyAutoAttachCommand(client.autoAttach, message)
    if (client.autoAttach.autoAttach) {
      // Why: Chrome attaches existing related targets during setAutoAttach.
      // Playwright connectOverCDP waits on those attachedToTarget events.
      await attachExistingPageTargets(client, controller, sessions)
    }
    sendCdpResult(client.socket, message.id, {})
    return true
  }
  if (message.method === 'Target.getTargets') {
    const tabs = await controller.listTabs()
    const attached = new Set(client.sessionTargets.values())
    sendCdpResult(client.socket, message.id, {
      targetInfos: tabs.map((tab) =>
        pageTargetInfo(client, tab, controller.viewId, attached.has(tab.targetId))
      )
    })
    return true
  }
  if (message.method === 'Target.getTargetInfo') {
    sendCdpResult(client.socket, message.id, {
      targetInfo: await resolveTargetInfo(client, controller, params)
    })
    return true
  }
  if (message.method === 'Target.attachToTarget') {
    const targetId = requiredOwnedTargetId(params, controller.ownsTarget, controller.viewId)
    const tab = await requireTab(controller, targetId)
    const sessionId = await attachClientToTarget(client, sessions, targetId)
    emitAttachedToTarget(client, sessionId, tab, controller.viewId)
    sendCdpResult(client.socket, message.id, { sessionId })
    return true
  }
  if (message.method === 'Target.detachFromTarget') {
    detachClientSession(client, sessions, params)
    sendCdpResult(client.socket, message.id, {})
    return true
  }
  if (message.method === 'Target.createTarget') {
    await createAndAttachTarget(client, controller, sessions, message)
    return true
  }
  if (message.method === 'Target.activateTarget') {
    const targetId = requiredOwnedTargetId(params, controller.ownsTarget, controller.viewId)
    await controller.activateTarget(targetId)
    sendCdpResult(client.socket, message.id, {})
    return true
  }
  if (message.method === 'Target.closeTarget') {
    const targetId = requiredOwnedTargetId(params, controller.ownsTarget, controller.viewId)
    await controller.closeTarget(targetId)
    sendCdpResult(client.socket, message.id, { success: true })
    return true
  }
  if (await handleBrowserContextCommand(client, message)) {
    return true
  }
  throw new Error(`Unsupported browser CDP method: ${message.method}`)
}

export async function handlePageTargetCommand(
  client: CdpGatewayClient,
  controller: CdpViewGatewayController,
  message: CdpMessage,
  targetId: string
): Promise<boolean> {
  if (message.method === 'Target.setAutoAttach' || message.method === 'Target.setDiscoverTargets') {
    // Why: Playwright page init awaits page-session setAutoAttach for OOPIFs.
    // Electron webview Target is incomplete; stub so connectOverCDP can finish.
    sendCdpResult(client.socket, message.id, {}, message.sessionId)
    return true
  }
  if (message.method === 'Target.getTargetInfo') {
    const tab = await requireTab(controller, targetId)
    sendCdpResult(
      client.socket,
      message.id,
      { targetInfo: pageTargetInfo(client, tab, controller.viewId, true) },
      message.sessionId
    )
    return true
  }
  return false
}

async function handleBrowserContextCommand(
  client: CdpGatewayClient,
  message: CdpMessage
): Promise<boolean> {
  const params = message.params ?? {}
  if (message.method === 'Target.getBrowserContexts') {
    sendCdpResult(client.socket, message.id, {
      browserContextIds: [...client.ownedBrowserContexts]
    })
    return true
  }
  if (message.method === 'Target.createBrowserContext') {
    const browserContextId = `orca-view-context-${nextContextSerial++}`
    client.ownedBrowserContexts.add(browserContextId)
    sendCdpResult(client.socket, message.id, { browserContextId })
    return true
  }
  if (message.method === 'Target.disposeBrowserContext') {
    const browserContextId =
      typeof params.browserContextId === 'string' ? params.browserContextId : null
    if (browserContextId) {
      client.ownedBrowserContexts.delete(browserContextId)
    }
    sendCdpResult(client.socket, message.id, {})
    return true
  }
  return false
}

async function createAndAttachTarget(
  client: CdpGatewayClient,
  controller: CdpViewGatewayController,
  sessions: PageSessionRegistry,
  message: CdpMessage
): Promise<void> {
  const params = message.params ?? {}
  const url = typeof params.url === 'string' && params.url !== '' ? params.url : 'about:blank'
  const tab = await controller.createTarget(url)
  if (typeof params.browserContextId === 'string' && params.browserContextId !== '') {
    client.targetBrowserContexts.set(tab.targetId, params.browserContextId)
  }
  if (client.autoAttach.discoverTargets) {
    sendCdp(client.socket, {
      method: 'Target.targetCreated',
      params: { targetInfo: pageTargetInfo(client, tab, controller.viewId, false) }
    })
  }
  if (client.autoAttach.autoAttach) {
    const sessionId = await attachClientToTarget(client, sessions, tab.targetId)
    // Why: Playwright newPage() reads _crPages immediately after createTarget
    // returns, so attachedToTarget must be emitted first.
    emitAttachedToTarget(client, sessionId, tab, controller.viewId)
  }
  sendCdpResult(client.socket, message.id, { targetId: tab.targetId })
}

async function resolveTargetInfo(
  client: CdpGatewayClient,
  controller: CdpViewGatewayController,
  params: Record<string, unknown>
) {
  // Why: Playwright issues a dummy Target.getTargetInfo with no targetId after
  // setAutoAttach. Chrome returns the browser target for that call.
  if (typeof params.targetId !== 'string' || params.targetId === '') {
    return browserTargetInfo(controller.viewId)
  }
  if (params.targetId === browserTargetId(controller.viewId)) {
    return browserTargetInfo(controller.viewId)
  }
  const targetId = requiredOwnedTargetId(params, controller.ownsTarget, controller.viewId)
  const tab = await requireTab(controller, targetId)
  return pageTargetInfo(
    client,
    tab,
    controller.viewId,
    [...client.sessionTargets.values()].includes(tab.targetId)
  )
}

function detachClientSession(
  client: CdpGatewayClient,
  sessions: PageSessionRegistry,
  params: Record<string, unknown>
): void {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null
  const targetId = sessionId ? client.sessionTargets.get(sessionId) : null
  if (sessionId) {
    client.sessionTargets.delete(sessionId)
  }
  if (targetId) {
    sessions.detachSink(targetId, client.sink)
  }
}

async function requireTab(controller: CdpViewGatewayController, targetId: string) {
  const tab = (await controller.listTabs()).find((entry) => entry.targetId === targetId)
  if (!tab) {
    throw new Error(`target is not owned by browser view ${controller.viewId}: ${targetId}`)
  }
  return tab
}
