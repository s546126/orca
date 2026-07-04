import {
  PANEL_ACTION_RESULT_TYPE,
  looksLikePanelActionRequest,
  parsePanelActionRequest,
  type PluginPanelActionOutcome,
  type PluginPanelActionResultMessage
} from '../../../../shared/plugins/plugin-panel-bridge'

/**
 * Host side of the plugin panel postMessage bridge. Framework-free so message
 * validation and relay behavior are directly unit-testable; PluginPanel wires
 * the returned listener to `window` while the panel iframe is mounted.
 */

export type PanelActionCall = {
  pluginId: string
  panelId: string
  action: string
  params?: unknown
}

export type PanelBridgeHostOptions = {
  pluginId: string
  panelId: string
  /** The mounted panel iframe's contentWindow, or null when unmounted. */
  getPanelWindow: () => Window | null
  callPanelAction: (call: PanelActionCall) => Promise<PluginPanelActionOutcome>
}

/** Relays a bridge call through the preload API, degrading to a bridge-level
 *  error when the preload predates the plugins.panelAction surface. */
export function callPanelActionViaPreload(
  call: PanelActionCall
): Promise<PluginPanelActionOutcome> {
  const panelAction = window.api?.plugins?.panelAction
  if (!panelAction) {
    return Promise.resolve({
      ok: false,
      code: 'unavailable',
      error: 'plugin actions are not available in this client'
    })
  }
  return panelAction(call)
}

export function createPanelBridgeMessageHandler(
  options: PanelBridgeHostOptions
): (event: MessageEvent) => void {
  return (event: MessageEvent): void => {
    const panelWindow = options.getPanelWindow()
    // Why: the sandboxed srcdoc frame has an opaque origin ("null"), so the
    // sending window's identity — not event.origin — is the only trustworthy
    // check that this message came from our panel and not another frame.
    if (!panelWindow || event.source !== panelWindow) {
      return
    }
    if (!looksLikePanelActionRequest(event.data)) {
      return
    }
    const respond = (message: PluginPanelActionResultMessage): void => {
      // Why: targetOrigin must be '*' — an opaque origin never matches a
      // concrete origin, so anything stricter would silently drop the reply.
      options.getPanelWindow()?.postMessage(message, '*')
    }
    const parsed = parsePanelActionRequest(event.data)
    if (!parsed.ok) {
      if (parsed.requestId) {
        respond({
          type: PANEL_ACTION_RESULT_TYPE,
          requestId: parsed.requestId,
          ok: false,
          errorCode: 'invalid_request',
          error: parsed.error
        })
      }
      return
    }
    const { requestId, action, params } = parsed.request
    options
      .callPanelAction({ pluginId: options.pluginId, panelId: options.panelId, action, params })
      .then((outcome) => {
        respond(
          outcome.ok
            ? { type: PANEL_ACTION_RESULT_TYPE, requestId, ok: true, value: outcome.value }
            : {
                type: PANEL_ACTION_RESULT_TYPE,
                requestId,
                ok: false,
                errorCode: outcome.code,
                error: outcome.error
              }
        )
      })
      .catch((error: unknown) => {
        respond({
          type: PANEL_ACTION_RESULT_TYPE,
          requestId,
          ok: false,
          errorCode: 'action_failed',
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }
}
