import type {
  BrowserCdpConnectResult,
  BrowserCdpStopResult,
  BrowserCdpViewsResult
} from '../../shared/browser-cdp-types'
import { formatCdpConnect, formatCdpStop, formatCdpViews } from '../browser-cdp-format'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  getBrowserCommandTarget,
  getBrowserWorktreeSelector,
  getOptionalWorktreeSelector
} from '../selectors'

const REMOTE_CDP_ERROR =
  'CDP attach is localhost-only on the machine running Orca. From a remote or SSH session use `orca snapshot` / `orca click` instead.'

export const BROWSER_CDP_HANDLERS: Record<string, CommandHandler> = {
  'cdp views': async ({ flags, client, cwd, json }) => {
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    const result = await client.call<BrowserCdpViewsResult>('browser.cdpViews', { worktree })
    printResult(result, json, formatCdpViews)
  },
  'cdp connect': async ({ flags, client, cwd, json }) => {
    if (client.isRemote) {
      throw new RuntimeClientError('invalid_argument', REMOTE_CDP_ERROR)
    }
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const view = await getOptionalWorktreeSelector(flags, 'view', cwd, client)
    const result = await client.call<BrowserCdpConnectResult>('browser.cdpConnect', {
      ...target,
      view
    })
    printResult(result, json, formatCdpConnect)
  },
  'cdp stop': async ({ flags, client, cwd, json }) => {
    if (client.isRemote) {
      throw new RuntimeClientError('invalid_argument', REMOTE_CDP_ERROR)
    }
    const worktree = await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
    const view = await getOptionalWorktreeSelector(flags, 'view', cwd, client)
    if (!worktree && !view) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --worktree or --view')
    }
    const result = await client.call<BrowserCdpStopResult>('browser.cdpStop', { worktree, view })
    printResult(result, json, formatCdpStop)
  }
}
