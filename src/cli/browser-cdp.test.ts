import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const isRemoteMock = { value: false }

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
    get isRemote(): boolean {
      return isRemoteMock.value
    }
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from './index'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'

describe('orca cli cdp commands', () => {
  beforeEach(() => {
    callMock.mockReset()
    isRemoteMock.value = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists views for the current worktree', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_cdp_views', { views: [] })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['cdp', 'views', '--json'], '/tmp/repo/feature')

    expect(callMock).toHaveBeenLastCalledWith('browser.cdpViews', {
      worktree: 'id:repo::/tmp/repo/feature'
    })
  })

  it('connects the current worktree and prints snippets', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_cdp_connect', {
        contractVersion: 1,
        viewId: 'wt-1',
        cdpScope: 'view',
        tabAuthority: 'external-cdp',
        cdpHttpUrl: 'http://127.0.0.1:9333',
        browserWsUrl: 'ws://127.0.0.1:9333/devtools/browser/wt-1',
        activeTargetId: 'page-1',
        activePageWsUrl: 'ws://127.0.0.1:9333/devtools/page/page-1',
        url: 'https://example.com',
        title: 'Example',
        tabs: [],
        snippets: {
          playwrightMcp: 'npx @playwright/mcp@latest --cdp-endpoint=http://127.0.0.1:9333',
          browserUseEnv: 'BU_CDP_URL=http://127.0.0.1:9333 browser-use',
          playwrightConnectOverCdp:
            'const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");',
          chromeDevtoolsMcp: 'npx chrome-devtools-mcp --browser-url=http://127.0.0.1:9333'
        }
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['cdp', 'connect', '--json'], '/tmp/repo/feature')

    expect(callMock).toHaveBeenLastCalledWith('browser.cdpConnect', {
      worktree: 'id:repo::/tmp/repo/feature',
      view: undefined
    })
    expect(log.mock.calls.at(-1)?.[0]).toContain('http://127.0.0.1:9333')
  })

  it('rejects remote CDP attach', async () => {
    isRemoteMock.value = true
    const priorExitCode = process.exitCode
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['cdp', 'connect', '--json'], '/tmp/repo/feature')

    expect(process.exitCode).toBe(1)
    expect(callMock).not.toHaveBeenCalled()
    expect(log.mock.calls.at(-1)?.[0]).toContain('localhost-only')
    process.exitCode = priorExitCode
  })
})
