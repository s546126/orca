import { describe, expect, it } from 'vitest'
import {
  applyAutoAttachCommand,
  browserTargetInfo,
  defaultViewBrowserContextId,
  emptyAutoAttachState,
  targetInfoFromTab
} from './cdp-view-gateway-targets'

describe('cdp view gateway target helpers', () => {
  it('stores waitForDebuggerOnStart from Target.setAutoAttach', () => {
    const state = applyAutoAttachCommand(emptyAutoAttachState(), {
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }
    })
    expect(state).toEqual({
      discoverTargets: false,
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true
    })
  })

  it('builds Playwright-shaped page and browser target info', () => {
    expect(
      targetInfoFromTab(
        { targetId: 'page-1', url: 'https://example.com', title: 'Example', active: true },
        true,
        defaultViewBrowserContextId('wt-1')
      )
    ).toEqual({
      targetId: 'page-1',
      type: 'page',
      title: 'Example',
      url: 'https://example.com',
      attached: true,
      canAccessOpener: false,
      browserContextId: 'orca-view-wt-1'
    })
    expect(browserTargetInfo('wt-1')).toEqual({
      targetId: 'orca-browser-wt-1',
      type: 'browser',
      title: '',
      url: '',
      attached: true,
      canAccessOpener: false
    })
  })
})
