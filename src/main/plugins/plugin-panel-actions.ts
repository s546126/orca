import {
  PANEL_ACTION_PARAM_SCHEMAS,
  PLUGIN_PANEL_ACTIONS,
  type PluginPanelAction,
  type PluginPanelActionOutcome
} from '../../shared/plugins/plugin-panel-bridge'

/**
 * Executes a panel-originated plugin action after enforcing the plugin's
 * manifest permissions. Shared by the desktop IPC handler
 * (`plugins:panelAction`) and the runtime RPC method (`plugins.panelAction`)
 * so both surfaces enforce identical rules (SSH/headless parity).
 */

// Structural subset of OrcaRuntimeService so tests and the RPC layer can
// supply lightweight fakes without importing the runtime module.
export type PanelActionRuntime = {
  resolveActiveTerminal(worktreeSelector?: string): Promise<string>
  sendTerminal(
    handle: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean }
  ): Promise<{ handle: string; accepted: boolean; bytesWritten: number }>
  resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null>
  dispatchPluginNotification(input: {
    pluginId: string
    title: string
    body?: string
  }): Promise<{ delivered: boolean }>
}

export type ExecutePanelActionInput = {
  /** Attributed to notifications and logs; already validated by the caller. */
  pluginId: string
  action: string
  params: unknown
  /** Manifest-granted permissions; `null` means the plugin is unknown,
   *  invalid, pending, or disabled. */
  grantedPermissions: readonly string[] | null
  runtime: PanelActionRuntime | null
}

function isKnownAction(action: string): action is PluginPanelAction {
  return (PLUGIN_PANEL_ACTIONS as readonly string[]).includes(action)
}

async function runTerminalSendText(
  runtime: PanelActionRuntime,
  params: { text: string; enter: boolean }
): Promise<unknown> {
  // Active terminal, not a plugin-chosen one: panels may only type where the
  // user is already looking, never into arbitrary background terminals.
  const handle = await runtime.resolveActiveTerminal()
  const result = await runtime.sendTerminal(handle, { text: params.text, enter: params.enter })
  return { accepted: result.accepted }
}

export async function executePluginPanelAction(
  input: ExecutePanelActionInput
): Promise<PluginPanelActionOutcome> {
  const { action, grantedPermissions, runtime } = input
  if (!isKnownAction(action)) {
    return { ok: false, code: 'unknown_action', error: `unknown panel action: ${action}` }
  }
  // Why: a disabled/uninstalled plugin must fail exactly like an ungranted
  // permission — no probe-able distinction for panel code.
  if (!grantedPermissions || !grantedPermissions.includes(action)) {
    return {
      ok: false,
      code: 'permission_denied',
      error: `plugin does not have the "${action}" permission`
    }
  }
  const parsedParams = PANEL_ACTION_PARAM_SCHEMAS[action].safeParse(input.params)
  if (!parsedParams.success) {
    const issue = parsedParams.error.issues[0]
    const path = issue?.path.join('.') || '(root)'
    return {
      ok: false,
      code: 'invalid_params',
      error: `${path}: ${issue?.message ?? 'invalid action params'}`
    }
  }
  if (!runtime) {
    return { ok: false, code: 'unavailable', error: 'runtime is not available' }
  }
  try {
    switch (action) {
      case 'terminal.sendText': {
        const value = await runTerminalSendText(
          runtime,
          parsedParams.data as { text: string; enter: boolean }
        )
        return { ok: true, value }
      }
      case 'workspace.readContext': {
        // Read-only: worktree id/path/branch of the user's focused workspace,
        // or null when nothing is focused — never an error.
        return { ok: true, value: await runtime.resolveActiveWorktreeContext() }
      }
      case 'notifications.show': {
        const params = parsedParams.data as { title: string; body?: string }
        const value = await runtime.dispatchPluginNotification({
          pluginId: input.pluginId,
          title: params.title,
          body: params.body
        })
        return { ok: true, value }
      }
    }
  } catch (error) {
    return {
      ok: false,
      code: 'action_failed',
      error: error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: false, code: 'unknown_action', error: `unhandled panel action: ${action}` }
}
