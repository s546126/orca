import { z } from 'zod'

/**
 * postMessage protocol between a sandboxed plugin panel iframe and the host
 * renderer, plus the action call shape relayed to main. The frame has an
 * opaque origin (sandbox="allow-scripts"), so neither side can use origins
 * for trust: the host verifies the sending window's identity and re-validates
 * every payload here; main re-checks permissions before executing.
 */

/** Panel actions a plugin may call; each doubles as the manifest permission
 *  id (`contributes.permissions`) that must grant it. */
export const PLUGIN_PANEL_ACTIONS = ['terminal.sendText'] as const

export type PluginPanelAction = (typeof PLUGIN_PANEL_ACTIONS)[number]

export const PANEL_ACTION_REQUEST_TYPE = 'orca-panel-action'
export const PANEL_ACTION_RESULT_TYPE = 'orca-panel-action-result'

// Why: text is typed into a live pty; cap it so a plugin cannot flood the
// terminal (mirrors the runtime's own terminal-send input limit intent).
export const PANEL_ACTION_TEXT_MAX_LENGTH = 4096

export const terminalSendTextParamsSchema = z.object({
  text: z.string().min(1).max(PANEL_ACTION_TEXT_MAX_LENGTH),
  enter: z.boolean().default(false)
})

export const PANEL_ACTION_PARAM_SCHEMAS: Record<PluginPanelAction, z.ZodTypeAny> = {
  'terminal.sendText': terminalSendTextParamsSchema
}

export const panelActionRequestSchema = z.object({
  type: z.literal(PANEL_ACTION_REQUEST_TYPE),
  /** Plugin-chosen correlation id echoed back on the result message. */
  requestId: z.string().min(1).max(128),
  action: z.enum(PLUGIN_PANEL_ACTIONS),
  params: z.unknown().optional()
})

export type PluginPanelActionRequest = z.infer<typeof panelActionRequestSchema>

export type PluginPanelActionErrorCode =
  | 'invalid_request'
  | 'unknown_action'
  | 'permission_denied'
  | 'invalid_params'
  | 'unavailable'
  | 'action_failed'

/** Result message posted back into the panel iframe. */
export type PluginPanelActionResultMessage = {
  type: typeof PANEL_ACTION_RESULT_TYPE
  requestId: string
  ok: boolean
  value?: unknown
  errorCode?: PluginPanelActionErrorCode
  error?: string
}

/** Outcome of executing a panel action in main (wire shape of
 *  `plugins:panelAction` / `plugins.panelAction`). */
export type PluginPanelActionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; code: PluginPanelActionErrorCode; error: string }

/** Call shape the renderer relays to main for a panel-originated action. */
export const panelActionCallSchema = z.object({
  pluginId: z.string().min(1),
  /** Panel that originated the request; informational (permissions are
   *  plugin-scoped), kept for logging and future per-panel scoping. */
  panelId: z.string().min(1).optional(),
  action: z.string().min(1),
  params: z.unknown().optional()
})

export type PluginPanelActionCall = z.infer<typeof panelActionCallSchema>

export type PanelActionRequestParseResult =
  | { ok: true; request: PluginPanelActionRequest }
  | { ok: false; requestId: string | null; error: string }

/** Validates a raw `message` event payload from the panel iframe. On failure
 *  still surfaces a best-effort requestId so the host can answer with an
 *  error instead of silently dropping the request. */
export function parsePanelActionRequest(data: unknown): PanelActionRequestParseResult {
  const parsed = panelActionRequestSchema.safeParse(data)
  if (parsed.success) {
    return { ok: true, request: parsed.data }
  }
  let requestId: string | null = null
  if (typeof data === 'object' && data !== null && 'requestId' in data) {
    const raw = (data as { requestId?: unknown }).requestId
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 128) {
      requestId = raw
    }
  }
  const issue = parsed.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return {
    ok: false,
    requestId,
    error: `${path}: ${issue?.message ?? 'invalid panel action request'}`
  }
}

/** True when `data` even looks like a bridge request (right `type`). Used to
 *  ignore unrelated window messages without replying to them. */
export function looksLikePanelActionRequest(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === PANEL_ACTION_REQUEST_TYPE
  )
}
