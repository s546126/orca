import { chromium } from 'playwright-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCdpViewGateway } from './cdp-view-gateway'
import {
  cdpCall,
  cdpCallCollectingEvents,
  createController,
  openBrowserSocket
} from './cdp-view-gateway-harness'
import type { CdpViewGateway } from './cdp-view-gateway-protocol'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

describe('CdpViewGateway Playwright handshake', () => {
  const gateways: CdpViewGateway[] = []

  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()))
  })

  it('emits attachedToTarget for existing pages the way connectOverCDP expects', async () => {
    const controller = createController([
      { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true }
    ])
    const gateway = await startCdpViewGateway(controller)
    gateways.push(gateway)

    const version = await (await fetch(`${gateway.httpUrl}/json/version/`)).json()
    expect(version.webSocketDebuggerUrl).toBe(gateway.browserWebSocketUrl)

    const ws = await openBrowserSocket(gateway.browserWebSocketUrl)
    const browserVersion = await cdpCall(ws, 1, 'Browser.getVersion')
    expect(browserVersion.result).toMatchObject({ product: expect.stringMatching(/^Chrome\//) })

    const autoAttach = await cdpCallCollectingEvents(ws, 2, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    })
    expect(autoAttach.response.result).toEqual({})
    expect(autoAttach.events).toEqual([
      {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: expect.stringMatching(/^orca-view-page-1-/),
          waitingForDebugger: true,
          targetInfo: {
            targetId: 'page-1',
            type: 'page',
            title: 'Example',
            url: 'https://example.com',
            attached: true,
            canAccessOpener: false,
            browserContextId: 'orca-view-wt-1'
          }
        }
      }
    ])

    const dummyInfo = await cdpCall(ws, 3, 'Target.getTargetInfo')
    expect(dummyInfo.result).toEqual({
      targetInfo: {
        targetId: 'orca-browser-wt-1',
        type: 'browser',
        title: '',
        url: '',
        attached: true,
        canAccessOpener: false
      }
    })

    const sessionId = (autoAttach.events[0].params as { sessionId: string }).sessionId
    const pageEnable = await cdpCall(ws, 4, 'Page.enable', {}, sessionId)
    expect(pageEnable).toMatchObject({ id: 4, result: {}, sessionId })

    const frameTree = await cdpCall(ws, 40, 'Page.getFrameTree', {}, sessionId)
    expect(frameTree).toMatchObject({
      id: 40,
      sessionId,
      result: {
        frameTree: {
          frame: expect.objectContaining({ id: 'page-1', url: 'https://example.com' })
        }
      }
    })

    const pageAutoAttach = await cdpCall(
      ws,
      5,
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId
    )
    expect(pageAutoAttach).toMatchObject({ id: 5, result: {}, sessionId })

    const created = await cdpCallCollectingEvents(ws, 6, 'Target.createTarget', {
      url: 'about:blank'
    })
    expect(created.response.result).toEqual({ targetId: 'page-new' })
    expect(created.events).toContainEqual({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: expect.stringMatching(/^orca-view-page-new-/),
        waitingForDebugger: true,
        targetInfo: expect.objectContaining({
          targetId: 'page-new',
          type: 'page',
          url: 'about:blank',
          browserContextId: 'orca-view-wt-1'
        })
      }
    })
    ws.close()
  })

  it('discovers existing tabs and auto-attaches tabs created outside CDP', async () => {
    const controller = createController([
      { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true }
    ])
    const gateway = await startCdpViewGateway(controller)
    gateways.push(gateway)
    const ws = await openBrowserSocket(gateway.browserWebSocketUrl)

    const discovered = await cdpCallCollectingEvents(ws, 1, 'Target.setDiscoverTargets', {
      discover: true
    })
    expect(discovered.events).toEqual([
      {
        method: 'Target.targetCreated',
        params: {
          targetInfo: expect.objectContaining({
            targetId: 'page-1',
            type: 'page',
            attached: false,
            browserContextId: 'orca-view-wt-1'
          })
        }
      }
    ])

    await cdpCall(ws, 2, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    })

    const incoming: Record<string, unknown>[] = []
    ws.on('message', (data) => {
      incoming.push(JSON.parse(data.toString()) as Record<string, unknown>)
    })
    const opened = {
      targetId: 'page-ui',
      url: 'https://opened.test',
      title: 'Opened',
      active: true
    }
    controller.addTab(opened)
    gateway.notifyTargetCreated(opened)
    await vi.waitFor(() => {
      expect(incoming).toContainEqual({
        method: 'Target.targetCreated',
        params: {
          targetInfo: expect.objectContaining({ targetId: 'page-ui', url: 'https://opened.test' })
        }
      })
      expect(incoming).toContainEqual({
        method: 'Target.attachedToTarget',
        params: expect.objectContaining({
          waitingForDebugger: true,
          targetInfo: expect.objectContaining({ targetId: 'page-ui', attached: true })
        })
      })
    })
    ws.close()
  })

  it('lets playwright-core connectOverCDP attach to the visible page', async () => {
    const controller = createController([
      { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true }
    ])
    const gateway = await startCdpViewGateway(controller)
    gateways.push(gateway)

    const browser = await chromium.connectOverCDP(gateway.httpUrl, { timeout: 8_000 })
    try {
      const context = browser.contexts()[0]
      expect(context).toBeDefined()
      const page = context.pages()[0]
      expect(page).toBeDefined()
      expect(page.url()).toBe('https://example.com')

      const created = await context.newPage()
      expect(created).toBeDefined()
      expect((await controller.listTabs()).map((tab) => tab.targetId)).toContain('page-new')
    } finally {
      await browser.close()
    }
  })
})
