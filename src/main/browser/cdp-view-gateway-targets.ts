import type { CdpMessage, CdpViewTab } from './cdp-view-gateway-protocol'
import { requiredTargetId } from './cdp-view-gateway-protocol'

export type CdpTargetInfo = {
  targetId: string
  type: 'page'
  title: string
  url: string
  attached: boolean
  canAccessOpener: boolean
}

export type CdpAutoAttachState = {
  discoverTargets: boolean
  autoAttach: boolean
  flatten: boolean
}

export function emptyAutoAttachState(): CdpAutoAttachState {
  return { discoverTargets: false, autoAttach: false, flatten: true }
}

export function targetInfoFromTab(tab: CdpViewTab, attached: boolean): CdpTargetInfo {
  return {
    targetId: tab.targetId,
    type: 'page',
    title: tab.title,
    url: tab.url,
    attached,
    canAccessOpener: false
  }
}

export function applyAutoAttachCommand(
  state: CdpAutoAttachState,
  message: CdpMessage
): CdpAutoAttachState {
  const params = message.params ?? {}
  if (message.method === 'Target.setDiscoverTargets') {
    return { ...state, discoverTargets: params.discover === true }
  }
  if (message.method === 'Target.setAutoAttach') {
    return {
      ...state,
      autoAttach: params.autoAttach === true,
      flatten: params.flatten !== false
    }
  }
  return state
}

export function requiredOwnedTargetId(
  params: Record<string, unknown>,
  ownsTarget: (targetId: string) => boolean,
  viewId: string
): string {
  const targetId = requiredTargetId(params)
  if (!ownsTarget(targetId)) {
    throw new Error(`target is not owned by browser view ${viewId}: ${targetId}`)
  }
  return targetId
}

export function chromeBrowserVersion(): Record<string, unknown> {
  const chromeVersion = process.versions.chrome ?? '134.0.0.0'
  return {
    protocolVersion: '1.3',
    product: `Chrome/${chromeVersion}`,
    userAgent: '',
    jsVersion: ''
  }
}
