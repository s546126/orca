import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { cdpViewGatewayManager } from '../browser/cdp-view-gateway-manager'
import type { RuntimeBrowserCommandHost, RuntimeBrowserCommands } from './orca-runtime-browser'
import { RuntimeBrowserCdpCommands } from './orca-runtime-browser-cdp'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

function createHost(): RuntimeBrowserCommandHost {
  return {
    getAgentBrowserBridge: () =>
      ({
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]]))
      }) as unknown as AgentBrowserBridge,
    resolveWorktreeSelector: async (selector) => ({ id: selector.replace(/^id:/, '') }),
    getAuthoritativeWindow: vi.fn(),
    getAvailableAuthoritativeWindow: vi.fn(() => null),
    getOffscreenBrowserBackend: vi.fn(() => null)
  } as unknown as RuntimeBrowserCommandHost
}

function createBrowserCommands(
  tabs: {
    browserPageId: string
    url: string
    title: string
    active: boolean
    worktreeId?: string | null
  }[]
): RuntimeBrowserCommands {
  return {
    browserTabList: vi.fn(async () => ({ tabs })),
    browserTabCreate: vi.fn(async () => ({ browserPageId: 'page-1' })),
    browserTabSwitch: vi.fn(async () => ({ switched: 0, browserPageId: 'page-1' })),
    browserTabClose: vi.fn(async () => ({ closed: true }))
  } as unknown as RuntimeBrowserCommands
}

describe('RuntimeBrowserCdpCommands', () => {
  afterEach(async () => {
    await cdpViewGatewayManager.stopAll()
  })

  it('lists unconnected views grouped by worktree', async () => {
    const commands = new RuntimeBrowserCdpCommands(
      createHost(),
      createBrowserCommands([
        {
          browserPageId: 'page-1',
          url: 'https://example.com',
          title: 'Example',
          active: true,
          worktreeId: 'wt-1'
        }
      ])
    )

    await expect(commands.browserCdpViews({})).resolves.toEqual({
      views: [
        expect.objectContaining({
          viewId: 'wt-1',
          connected: false,
          cdpHttpUrl: null,
          activeTargetId: 'page-1'
        })
      ]
    })
  })

  it('starts a localhost gateway and returns attach snippets', async () => {
    const commands = new RuntimeBrowserCdpCommands(
      createHost(),
      createBrowserCommands([
        {
          browserPageId: 'page-1',
          url: 'https://example.com',
          title: 'Example',
          active: true,
          worktreeId: 'wt-1'
        }
      ])
    )

    const result = await commands.browserCdpConnect({ worktree: 'id:wt-1' })
    expect(result.viewId).toBe('wt-1')
    expect(result.cdpHttpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(result.browserWsUrl).toContain('/devtools/browser/wt-1')
    expect(result.snippets.playwrightConnectOverCdp).toContain(result.cdpHttpUrl)
    expect(result.snippets.playwrightMcp).toContain(`--cdp-endpoint=${result.cdpHttpUrl}`)

    const version = await (await fetch(`${result.cdpHttpUrl}/json/version`)).json()
    expect(version.webSocketDebuggerUrl).toBe(result.browserWsUrl)

    await expect(commands.browserCdpStop({ worktree: 'id:wt-1' })).resolves.toEqual({
      stopped: true,
      viewId: 'wt-1'
    })
  })

  it('creates a blank tab when the view has none', async () => {
    const browserCommands = createBrowserCommands([])
    const commands = new RuntimeBrowserCdpCommands(createHost(), browserCommands)
    vi.mocked(browserCommands.browserTabList)
      .mockResolvedValueOnce({ tabs: [] })
      .mockResolvedValueOnce({
        tabs: [
          {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: '',
            active: true,
            worktreeId: 'wt-1'
          }
        ]
      })

    await commands.browserCdpConnect({ worktree: 'id:wt-1' })
    expect(browserCommands.browserTabCreate).toHaveBeenCalledWith({
      worktree: 'id:wt-1',
      url: 'about:blank'
    })
  })
})
