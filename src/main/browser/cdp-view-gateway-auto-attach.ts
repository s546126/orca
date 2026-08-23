import type { CdpViewGatewayController, CdpViewTab } from './cdp-view-gateway-protocol'
import {
  attachClientToTarget,
  sendCdp,
  type CdpGatewayClient,
  type PageSessionRegistry
} from './cdp-view-gateway-client'
import {
  defaultViewBrowserContextId,
  targetInfoFromTab,
  type CdpTargetInfo
} from './cdp-view-gateway-targets'

export function contextIdForTab(client: CdpGatewayClient, tab: CdpViewTab, viewId: string): string {
  return client.targetBrowserContexts.get(tab.targetId) ?? defaultViewBrowserContextId(viewId)
}

export function pageTargetInfo(
  client: CdpGatewayClient,
  tab: CdpViewTab,
  viewId: string,
  attached: boolean
): CdpTargetInfo {
  return targetInfoFromTab(tab, attached, contextIdForTab(client, tab, viewId))
}

export function emitAttachedToTarget(
  client: CdpGatewayClient,
  sessionId: string,
  tab: CdpViewTab,
  viewId: string
): void {
  sendCdp(client.socket, {
    method: 'Target.attachedToTarget',
    params: {
      sessionId,
      targetInfo: pageTargetInfo(client, tab, viewId, true),
      waitingForDebugger: client.autoAttach.waitForDebuggerOnStart
    }
  })
}

export function emitDetachedFromTarget(client: CdpGatewayClient, targetId: string): void {
  let sessionId: string | null = null
  for (const [id, attachedTargetId] of client.sessionTargets) {
    if (attachedTargetId === targetId) {
      sessionId = id
      client.sessionTargets.delete(id)
      break
    }
  }
  sendCdp(client.socket, {
    method: 'Target.detachedFromTarget',
    params: sessionId ? { sessionId, targetId } : { targetId }
  })
}

export async function attachExistingPageTargets(
  client: CdpGatewayClient,
  controller: CdpViewGatewayController,
  sessions: PageSessionRegistry
): Promise<void> {
  const tabs = await controller.listTabs()
  const attached = new Set(client.sessionTargets.values())
  for (const tab of tabs) {
    if (attached.has(tab.targetId)) {
      continue
    }
    const sessionId = await attachClientToTarget(client, sessions, tab.targetId)
    emitAttachedToTarget(client, sessionId, tab, controller.viewId)
  }
}

export async function discoverExistingPageTargets(
  client: CdpGatewayClient,
  controller: CdpViewGatewayController
): Promise<void> {
  const tabs = await controller.listTabs()
  for (const tab of tabs) {
    sendCdp(client.socket, {
      method: 'Target.targetCreated',
      params: { targetInfo: pageTargetInfo(client, tab, controller.viewId, false) }
    })
  }
}

export async function announceCreatedTarget(
  clients: Iterable<CdpGatewayClient>,
  tab: CdpViewTab,
  viewId: string,
  sessions: PageSessionRegistry
): Promise<void> {
  for (const client of clients) {
    if (client.kind !== 'browser') {
      continue
    }
    if (client.autoAttach.discoverTargets) {
      sendCdp(client.socket, {
        method: 'Target.targetCreated',
        params: { targetInfo: pageTargetInfo(client, tab, viewId, false) }
      })
    }
    if (!client.autoAttach.autoAttach) {
      continue
    }
    if ([...client.sessionTargets.values()].includes(tab.targetId)) {
      continue
    }
    const sessionId = await attachClientToTarget(client, sessions, tab.targetId)
    emitAttachedToTarget(client, sessionId, tab, viewId)
  }
}

export function announceDestroyedTarget(
  clients: Iterable<CdpGatewayClient>,
  targetId: string
): void {
  for (const client of clients) {
    if (client.kind !== 'browser') {
      continue
    }
    if ([...client.sessionTargets.values()].includes(targetId)) {
      emitDetachedFromTarget(client, targetId)
    }
    if (client.autoAttach.discoverTargets) {
      sendCdp(client.socket, { method: 'Target.targetDestroyed', params: { targetId } })
    }
  }
}
