import type { BrowserTabInfo } from './runtime-types'

export type BrowserCdpViewInfo = {
  viewId: string
  worktreeId: string
  connected: boolean
  cdpHttpUrl: string | null
  browserWsUrl: string | null
  activeTargetId: string | null
  url: string
  title: string
  tabs: BrowserTabInfo[]
}

export type BrowserCdpViewsResult = {
  views: BrowserCdpViewInfo[]
}

export type BrowserCdpConnectSnippets = {
  playwrightMcp: string
  browserUseEnv: string
  playwrightConnectOverCdp: string
  chromeDevtoolsMcp: string
}

export type BrowserCdpConnectResult = {
  contractVersion: 1
  viewId: string
  cdpScope: 'view'
  tabAuthority: 'external-cdp'
  cdpHttpUrl: string
  browserWsUrl: string
  activeTargetId: string | null
  activePageWsUrl: string | null
  url: string
  title: string
  tabs: BrowserTabInfo[]
  snippets: BrowserCdpConnectSnippets
}

export type BrowserCdpStopResult = {
  stopped: boolean
  viewId: string
}

export function buildBrowserCdpConnectSnippets(cdpHttpUrl: string): BrowserCdpConnectSnippets {
  return {
    playwrightMcp: `npx @playwright/mcp@latest --cdp-endpoint=${cdpHttpUrl}`,
    browserUseEnv: `BU_CDP_URL=${cdpHttpUrl} browser-use`,
    playwrightConnectOverCdp: `const browser = await chromium.connectOverCDP(${JSON.stringify(cdpHttpUrl)});`,
    chromeDevtoolsMcp: `npx chrome-devtools-mcp --browser-url=${cdpHttpUrl}`
  }
}
