import type { IncomingMessage, ServerResponse } from 'http'
import type { CdpViewGatewayController, CdpViewTab } from './cdp-view-gateway-protocol'
import {
  chromeProductString,
  normalizedHttpPath,
  requestUrl,
  targetIdFromHttpPath,
  writeJson,
  writeText
} from './cdp-view-gateway-protocol'

export type CdpViewHttpUrls = {
  host: string
  browserWebSocketUrl: string
  pageWebSocketUrl: (targetId: string) => string
}

export async function handleCdpViewHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  controller: CdpViewGatewayController,
  urls: CdpViewHttpUrls
): Promise<void> {
  const url = requestUrl(req, urls.host)
  const pathname = normalizedHttpPath(url.pathname)

  if (pathname === '/' || pathname === '/json/version') {
    writeJson(res, {
      Browser: chromeProductString(),
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: urls.browserWebSocketUrl
    })
    return
  }

  if (pathname === '/json' || pathname === '/json/list') {
    const tabs = await controller.listTabs()
    writeJson(
      res,
      tabs.map((tab) => targetDescriptor(tab, urls.pageWebSocketUrl))
    )
    return
  }

  if (pathname === '/json/new' && (req.method === 'PUT' || req.method === 'GET')) {
    const requestedUrl =
      url.searchParams.get('url') ??
      (url.search.length > 1 ? decodeURIComponent(url.search.slice(1)) : 'about:blank')
    const tab = await controller.createTarget(requestedUrl)
    writeJson(res, targetDescriptor(tab, urls.pageWebSocketUrl))
    return
  }

  const activateTargetId = targetIdFromHttpPath(pathname, '/json/activate/')
  if (activateTargetId) {
    if (!controller.ownsTarget(activateTargetId)) {
      writeText(res, 'target not owned by this browser view', 404)
      return
    }
    await controller.activateTarget(activateTargetId)
    writeText(res, 'Target activated')
    return
  }

  const closeTargetId = targetIdFromHttpPath(pathname, '/json/close/')
  if (closeTargetId) {
    if (!controller.ownsTarget(closeTargetId)) {
      writeText(res, 'target not owned by this browser view', 404)
      return
    }
    await controller.closeTarget(closeTargetId)
    writeText(res, 'Target is closing')
    return
  }

  writeText(res, 'not found', 404)
}

export function targetDescriptor(
  tab: CdpViewTab,
  pageWebSocketUrl: (targetId: string) => string
): Record<string, unknown> {
  return {
    description: '',
    devtoolsFrontendUrl: '',
    id: tab.targetId,
    title: tab.title,
    type: 'page',
    url: tab.url,
    webSocketDebuggerUrl: pageWebSocketUrl(tab.targetId)
  }
}
