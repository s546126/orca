import { z } from 'zod'
import { OptionalString } from '../schemas'
import { defineMethod, type RpcMethod } from '../core'

const CdpViews = z.object({
  worktree: OptionalString
})

const CdpConnect = z.object({
  worktree: OptionalString,
  page: OptionalString,
  view: OptionalString
})

const CdpStop = z.object({
  worktree: OptionalString,
  view: OptionalString
})

export const BROWSER_CDP_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'browser.cdpViews',
    params: CdpViews,
    handler: async (params, { runtime }) => runtime.browserCdpViews(params)
  }),
  defineMethod({
    name: 'browser.cdpConnect',
    params: CdpConnect,
    handler: async (params, { runtime }) => runtime.browserCdpConnect(params)
  }),
  defineMethod({
    name: 'browser.cdpStop',
    params: CdpStop,
    handler: async (params, { runtime }) => runtime.browserCdpStop(params)
  })
]
