import type {
  BrowserCdpConnectResult,
  BrowserCdpStopResult,
  BrowserCdpViewsResult
} from '../shared/browser-cdp-types'

export function formatCdpViews(result: BrowserCdpViewsResult): string {
  if (result.views.length === 0) {
    return 'No browser views'
  }
  return result.views
    .map((view) => {
      const status = view.connected ? view.cdpHttpUrl : 'not connected'
      const active = view.activeTargetId ?? 'none'
      return `${view.viewId}  tabs=${view.tabs.length}  active=${active}  ${status}`
    })
    .join('\n')
}

export function formatCdpConnect(result: BrowserCdpConnectResult): string {
  return [
    `view ${result.viewId}`,
    `cdpHttpUrl ${result.cdpHttpUrl}`,
    `browserWsUrl ${result.browserWsUrl}`,
    `activeTargetId ${result.activeTargetId ?? 'none'}`,
    `playwright ${result.snippets.playwrightConnectOverCdp}`,
    `playwrightMcp ${result.snippets.playwrightMcp}`,
    `browserUse ${result.snippets.browserUseEnv}`,
    `chromeDevtoolsMcp ${result.snippets.chromeDevtoolsMcp}`
  ].join('\n')
}

export function formatCdpStop(result: BrowserCdpStopResult): string {
  return result.stopped
    ? `Stopped CDP gateway for view ${result.viewId}`
    : `No CDP gateway was running for view ${result.viewId}`
}
