import { webContents } from 'electron'
import {
  buildBrowserCdpConnectSnippets,
  type BrowserCdpConnectResult,
  type BrowserCdpStopResult,
  type BrowserCdpViewInfo,
  type BrowserCdpViewsResult
} from '../../shared/browser-cdp-types'
import type { BrowserTabInfo } from '../../shared/runtime-types'
import { browserManager } from '../browser/browser-manager'
import { BrowserError } from '../browser/cdp-bridge'
import { cdpViewGatewayManager } from '../browser/cdp-view-gateway-manager'
import type { CdpViewGatewayController, CdpViewTab } from '../browser/cdp-view-gateway-protocol'
import type { RuntimeBrowserCommandHost, RuntimeBrowserCommands } from './orca-runtime-browser'

export class RuntimeBrowserCdpCommands {
  constructor(
    private readonly host: RuntimeBrowserCommandHost,
    private readonly browserCommands: RuntimeBrowserCommands
  ) {}

  async browserCdpViews(params: { worktree?: string }): Promise<BrowserCdpViewsResult> {
    const scopedWorktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const tabs = (await this.browserCommands.browserTabList({ worktree: params.worktree })).tabs
    const viewIds = new Set<string>()
    const tabsByView = new Map<string, BrowserTabInfo[]>()
    for (const tab of tabs) {
      const viewId = tab.worktreeId ?? scopedWorktreeId
      if (!viewId) {
        continue
      }
      if (scopedWorktreeId && viewId !== scopedWorktreeId) {
        continue
      }
      viewIds.add(viewId)
      const list = tabsByView.get(viewId) ?? []
      list.push(tab)
      tabsByView.set(viewId, list)
    }
    if (scopedWorktreeId) {
      viewIds.add(scopedWorktreeId)
    } else {
      for (const gateway of cdpViewGatewayManager.listRunning()) {
        viewIds.add(gateway.viewId)
      }
    }
    return {
      views: [...viewIds].map((viewId) => this.describeView(viewId, tabsByView.get(viewId) ?? []))
    }
  }

  async browserCdpConnect(params: {
    worktree?: string
    page?: string
    view?: string
  }): Promise<BrowserCdpConnectResult> {
    const worktreeId = await this.resolveConnectWorktreeId(params)
    let tabs = (await this.browserCommands.browserTabList({ worktree: `id:${worktreeId}` })).tabs
    if (tabs.length === 0) {
      // Why: Playwright/Browser Use expect a live view. Creating a blank tab
      // matches herdr-browser's ensureView so connect can return endpoints.
      await this.browserCommands.browserTabCreate({
        worktree: `id:${worktreeId}`,
        url: 'about:blank'
      })
      tabs = (await this.browserCommands.browserTabList({ worktree: `id:${worktreeId}` })).tabs
    }
    if (params.page) {
      await this.browserCommands.browserTabSwitch({
        worktree: `id:${worktreeId}`,
        page: params.page
      })
      tabs = (await this.browserCommands.browserTabList({ worktree: `id:${worktreeId}` })).tabs
    }
    const gateway = await cdpViewGatewayManager.ensure(this.createController(worktreeId))
    const active = tabs.find((tab) => tab.active) ?? tabs[0] ?? null
    return {
      contractVersion: 1,
      viewId: worktreeId,
      cdpScope: 'view',
      tabAuthority: 'external-cdp',
      cdpHttpUrl: gateway.httpUrl,
      browserWsUrl: gateway.browserWebSocketUrl,
      activeTargetId: active?.browserPageId ?? null,
      activePageWsUrl: active ? gateway.pageWebSocketUrl(active.browserPageId) : null,
      url: active?.url ?? '',
      title: active?.title ?? '',
      tabs,
      snippets: buildBrowserCdpConnectSnippets(gateway.httpUrl)
    }
  }

  async browserCdpStop(params: {
    worktree?: string
    view?: string
  }): Promise<BrowserCdpStopResult> {
    const viewId = params.view
      ? (await this.host.resolveWorktreeSelector(params.view)).id
      : params.worktree
        ? (await this.host.resolveWorktreeSelector(params.worktree)).id
        : undefined
    if (!viewId) {
      throw new BrowserError('invalid_argument', 'Missing required --worktree or --view')
    }
    const stopped = await cdpViewGatewayManager.stop(viewId)
    return { stopped, viewId }
  }

  private async resolveConnectWorktreeId(params: {
    worktree?: string
    page?: string
    view?: string
  }): Promise<string> {
    if (params.view) {
      return (await this.host.resolveWorktreeSelector(params.view)).id
    }
    if (params.worktree) {
      return (await this.host.resolveWorktreeSelector(params.worktree)).id
    }
    if (params.page) {
      const worktreeId = browserManager.getWorktreeIdForTab(params.page)
      if (worktreeId) {
        return worktreeId
      }
    }
    const tabs = (await this.browserCommands.browserTabList({})).tabs
    const active = tabs.find((tab) => tab.active)
    if (active?.worktreeId) {
      return active.worktreeId
    }
    if (tabs[0]?.worktreeId) {
      return tabs[0].worktreeId
    }
    throw new BrowserError(
      'browser_no_tab',
      'No browser view is available. Pass --worktree or open a browser tab first.'
    )
  }

  private describeView(viewId: string, tabs: BrowserTabInfo[]): BrowserCdpViewInfo {
    const gateway = cdpViewGatewayManager.get(viewId)
    const active = tabs.find((tab) => tab.active) ?? tabs[0] ?? null
    return {
      viewId,
      worktreeId: viewId,
      connected: Boolean(gateway),
      cdpHttpUrl: gateway?.httpUrl ?? null,
      browserWsUrl: gateway?.browserWebSocketUrl ?? null,
      activeTargetId: active?.browserPageId ?? null,
      url: active?.url ?? '',
      title: active?.title ?? '',
      tabs
    }
  }

  private createController(worktreeId: string): CdpViewGatewayController {
    return {
      viewId: worktreeId,
      listTabs: async () => this.listControllerTabs(worktreeId),
      ownsTarget: (targetId) => browserManager.getWorktreeIdForTab(targetId) === worktreeId,
      getWebContents: (targetId) => {
        const webContentsId = this.host
          .getAgentBrowserBridge()
          ?.getRegisteredTabs(worktreeId)
          .get(targetId)
        if (webContentsId == null) {
          return null
        }
        const guest = webContents.fromId(webContentsId)
        return guest && !guest.isDestroyed() ? guest : null
      },
      createTarget: async (url) => {
        const created = await this.browserCommands.browserTabCreate({
          worktree: `id:${worktreeId}`,
          url
        })
        const tab = await this.requireControllerTab(worktreeId, created.browserPageId)
        cdpViewGatewayManager.notifyTargetCreated(worktreeId, tab)
        return tab
      },
      activateTarget: async (targetId) => {
        await this.browserCommands.browserTabSwitch({
          worktree: `id:${worktreeId}`,
          page: targetId
        })
        return this.requireControllerTab(worktreeId, targetId)
      },
      closeTarget: async (targetId) => {
        await this.browserCommands.browserTabClose({
          worktree: `id:${worktreeId}`,
          page: targetId
        })
        cdpViewGatewayManager.notifyTargetDestroyed(worktreeId, targetId)
      }
    }
  }

  private async listControllerTabs(worktreeId: string): Promise<CdpViewTab[]> {
    const tabs = (await this.browserCommands.browserTabList({ worktree: `id:${worktreeId}` })).tabs
    return tabs.map((tab) => ({
      targetId: tab.browserPageId,
      url: tab.url,
      title: tab.title,
      active: tab.active
    }))
  }

  private async requireControllerTab(worktreeId: string, targetId: string): Promise<CdpViewTab> {
    const tab = (await this.listControllerTabs(worktreeId)).find(
      (entry) => entry.targetId === targetId
    )
    if (!tab) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${targetId} was not found in this view`
      )
    }
    return tab
  }
}
