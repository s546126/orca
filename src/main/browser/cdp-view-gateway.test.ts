import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCdpViewGateway } from './cdp-view-gateway'
import { cdpCall, createController, openBrowserSocket } from './cdp-view-gateway-harness'
import type { CdpViewGateway } from './cdp-view-gateway-protocol'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

describe('CdpViewGateway', () => {
  const gateways: CdpViewGateway[] = []

  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()))
  })

  it('exposes Chrome-shaped HTTP discovery for a view', async () => {
    const gateway = await startCdpViewGateway(
      createController([
        { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true }
      ])
    )
    gateways.push(gateway)

    const version = await (await fetch(`${gateway.httpUrl}/json/version`)).json()
    expect(version.webSocketDebuggerUrl).toBe(gateway.browserWebSocketUrl)
    expect(version.Browser).toMatch(/^Chrome\//)

    const list = (await (await fetch(`${gateway.httpUrl}/json/list`)).json()) as {
      id: string
      webSocketDebuggerUrl: string
    }[]
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('page-1')
    expect(list[0].webSocketDebuggerUrl).toBe(gateway.pageWebSocketUrl('page-1'))
  })

  it('creates, activates, and closes targets through HTTP and Target domain', async () => {
    const controller = createController([
      { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true }
    ])
    const gateway = await startCdpViewGateway(controller)
    gateways.push(gateway)

    const created = await (
      await fetch(`${gateway.httpUrl}/json/new?url=${encodeURIComponent('https://created.test')}`, {
        method: 'PUT'
      })
    ).json()
    expect(created.id).toBe('page-new')

    const ws = await openBrowserSocket(gateway.browserWebSocketUrl)
    const targets = await cdpCall(ws, 1, 'Target.getTargets')
    const infos = (targets.result as { targetInfos: { targetId: string }[] }).targetInfos
    expect(infos.map((info) => info.targetId)).toEqual(['page-1', 'page-new'])

    await cdpCall(ws, 2, 'Target.activateTarget', { targetId: 'page-new' })
    expect((await controller.listTabs()).find((tab) => tab.targetId === 'page-new')?.active).toBe(
      true
    )

    await cdpCall(ws, 3, 'Target.closeTarget', { targetId: 'page-1' })
    expect((await controller.listTabs()).map((tab) => tab.targetId)).toEqual(['page-new'])
    ws.close()
  })

  it('rejects foreign targets and treats Browser.close as client disconnect', async () => {
    const gateway = await startCdpViewGateway(
      createController([
        { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true }
      ])
    )
    gateways.push(gateway)

    const ws = await openBrowserSocket(gateway.browserWebSocketUrl)
    const error = await cdpCall(ws, 1, 'Target.activateTarget', { targetId: 'other-view-page' })
    expect(error.error).toMatchObject({
      message: expect.stringContaining('not owned by browser view wt-1')
    })

    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()))
    await cdpCall(ws, 2, 'Browser.close')
    await closed
    expect((await fetch(`${gateway.httpUrl}/json/version`)).ok).toBe(true)
  })

  it('attaches a page session and forwards Runtime.evaluate', async () => {
    const controller = createController([
      { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true }
    ])
    const gateway = await startCdpViewGateway(controller)
    gateways.push(gateway)
    const guest = controller.getWebContents('page-1')
    if (!guest) {
      throw new Error('expected page-1 webContents')
    }
    guest.debugger.sendCommand = vi.fn(async () => ({
      result: { value: 'ok' }
    }))

    const ws = await openBrowserSocket(gateway.browserWebSocketUrl)
    const attached = await cdpCall(ws, 1, 'Target.attachToTarget', {
      targetId: 'page-1',
      flatten: true
    })
    const sessionId = (attached.result as { sessionId: string }).sessionId
    const evaluated = await cdpCall(ws, 2, 'Runtime.evaluate', { expression: '1+1' }, sessionId)
    expect(evaluated.result).toEqual({ result: { value: 'ok' } })
    expect(evaluated.sessionId).toBe(sessionId)
    expect(guest.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: '1+1'
    })
    ws.close()
  })
})
