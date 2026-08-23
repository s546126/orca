import { describe, expect, it } from 'vitest'
import { buildBrowserCdpConnectSnippets } from './browser-cdp-types'

describe('buildBrowserCdpConnectSnippets', () => {
  it('builds herdr-compatible attach snippets from the HTTP endpoint', () => {
    const snippets = buildBrowserCdpConnectSnippets('http://127.0.0.1:9333')
    expect(snippets.playwrightMcp).toBe(
      'npx @playwright/mcp@latest --cdp-endpoint=http://127.0.0.1:9333'
    )
    expect(snippets.browserUseEnv).toBe('BU_CDP_URL=http://127.0.0.1:9333 browser-use')
    expect(snippets.playwrightConnectOverCdp).toBe(
      'const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");'
    )
    expect(snippets.chromeDevtoolsMcp).toBe(
      'npx chrome-devtools-mcp --browser-url=http://127.0.0.1:9333'
    )
  })
})
