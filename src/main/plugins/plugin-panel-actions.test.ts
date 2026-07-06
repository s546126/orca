import { describe, expect, it, vi } from 'vitest'
import { executePluginPanelAction, type PanelActionRuntime } from './plugin-panel-actions'

function createRuntime(overrides: Partial<PanelActionRuntime> = {}): {
  runtime: PanelActionRuntime
  resolveActiveTerminal: ReturnType<typeof vi.fn>
  sendTerminal: ReturnType<typeof vi.fn>
  resolveActiveWorktreeContext: ReturnType<typeof vi.fn>
  dispatchPluginNotification: ReturnType<typeof vi.fn>
} {
  const resolveActiveTerminal = vi.fn().mockResolvedValue('term-1')
  const sendTerminal = vi
    .fn()
    .mockResolvedValue({ handle: 'term-1', accepted: true, bytesWritten: 12 })
  const resolveActiveWorktreeContext = vi.fn().mockResolvedValue({
    worktreeId: 'repo::/w/feature',
    path: '/w/feature',
    branch: 'feature/x',
    displayName: 'feature'
  })
  const dispatchPluginNotification = vi.fn().mockResolvedValue({ delivered: true })
  return {
    runtime: {
      resolveActiveTerminal,
      sendTerminal,
      resolveActiveWorktreeContext,
      dispatchPluginNotification,
      ...overrides
    },
    resolveActiveTerminal,
    sendTerminal,
    resolveActiveWorktreeContext,
    dispatchPluginNotification
  }
}

describe('executePluginPanelAction permission enforcement', () => {
  it('denies an action the manifest does not grant and never touches the runtime', async () => {
    const { runtime, sendTerminal } = createRuntime()
    const outcome = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'terminal.sendText',
      params: { text: '/model opus', enter: true },
      grantedPermissions: [],
      runtime
    })
    expect(outcome).toEqual({
      ok: false,
      code: 'permission_denied',
      error: 'plugin does not have the "terminal.sendText" permission'
    })
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('denies uniformly when the plugin is unknown or disabled (null grants)', async () => {
    const { runtime, sendTerminal } = createRuntime()
    const outcome = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'terminal.sendText',
      params: { text: 'hi' },
      grantedPermissions: null,
      runtime
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.code).toBe('permission_denied')
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('rejects unknown actions before consulting permissions', async () => {
    const { runtime } = createRuntime()
    const outcome = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'fs.readFile',
      params: {},
      grantedPermissions: ['terminal.sendText'],
      runtime
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.code).toBe('unknown_action')
  })
})

describe('executePluginPanelAction terminal.sendText relay', () => {
  it('types text into the active terminal and reports acceptance', async () => {
    const { runtime, resolveActiveTerminal, sendTerminal } = createRuntime()
    const outcome = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'terminal.sendText',
      params: { text: '/model sonnet[1m]', enter: true },
      grantedPermissions: ['terminal.sendText'],
      runtime
    })
    expect(resolveActiveTerminal).toHaveBeenCalledWith()
    expect(sendTerminal).toHaveBeenCalledWith('term-1', {
      text: '/model sonnet[1m]',
      enter: true
    })
    expect(outcome).toEqual({ ok: true, value: { accepted: true } })
  })

  it('defaults enter to false when omitted', async () => {
    const { runtime, sendTerminal } = createRuntime()
    await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'terminal.sendText',
      params: { text: 'plain text' },
      grantedPermissions: ['terminal.sendText'],
      runtime
    })
    expect(sendTerminal).toHaveBeenCalledWith('term-1', { text: 'plain text', enter: false })
  })

  it('rejects invalid params without touching the runtime', async () => {
    const { runtime, sendTerminal } = createRuntime()
    for (const params of [{}, { text: '' }, { text: 42 }, { text: 'ok', enter: 'yes' }, null]) {
      const outcome = await executePluginPanelAction({
        pluginId: 'model-shift',
        action: 'terminal.sendText',
        params,
        grantedPermissions: ['terminal.sendText'],
        runtime
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) {
        return
      }
      expect(outcome.code).toBe('invalid_params')
    }
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('reports unavailable when no terminal runtime is wired (e.g. early startup)', async () => {
    const outcome = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'terminal.sendText',
      params: { text: 'hi' },
      grantedPermissions: ['terminal.sendText'],
      runtime: null
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.code).toBe('unavailable')
  })

  it('maps runtime failures (no active terminal) to action_failed', async () => {
    const { runtime, resolveActiveTerminal } = createRuntime()
    resolveActiveTerminal.mockRejectedValue(new Error('no_active_terminal'))
    const outcome = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'terminal.sendText',
      params: { text: 'hi' },
      grantedPermissions: ['terminal.sendText'],
      runtime
    })
    expect(outcome).toEqual({ ok: false, code: 'action_failed', error: 'no_active_terminal' })
  })

  it('propagates a rejected write as accepted: false', async () => {
    const { runtime, sendTerminal } = createRuntime()
    sendTerminal.mockResolvedValue({ handle: 'term-1', accepted: false, bytesWritten: 0 })
    const outcome = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'terminal.sendText',
      params: { text: 'hi' },
      grantedPermissions: ['terminal.sendText'],
      runtime
    })
    expect(outcome).toEqual({ ok: true, value: { accepted: false } })
  })
})

describe('executePluginPanelAction workspace.readContext', () => {
  it('returns the focused worktree context and requires its own permission', async () => {
    const { runtime, resolveActiveWorktreeContext } = createRuntime()
    const outcome = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'workspace.readContext',
      params: undefined,
      grantedPermissions: ['workspace.readContext'],
      runtime
    })
    expect(resolveActiveWorktreeContext).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({
      ok: true,
      value: {
        worktreeId: 'repo::/w/feature',
        path: '/w/feature',
        branch: 'feature/x',
        displayName: 'feature'
      }
    })

    // terminal.sendText alone must not grant the read.
    const denied = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'workspace.readContext',
      params: undefined,
      grantedPermissions: ['terminal.sendText'],
      runtime
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.code).toBe('permission_denied')
    }
  })

  it('returns null (not an error) when nothing is focused, rejects junk params', async () => {
    const { runtime, resolveActiveWorktreeContext } = createRuntime()
    resolveActiveWorktreeContext.mockResolvedValue(null)
    const outcome = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'workspace.readContext',
      params: undefined,
      grantedPermissions: ['workspace.readContext'],
      runtime
    })
    expect(outcome).toEqual({ ok: true, value: null })

    const junk = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'workspace.readContext',
      params: { give: 'everything' },
      grantedPermissions: ['workspace.readContext'],
      runtime
    })
    expect(junk.ok).toBe(false)
    if (!junk.ok) {
      expect(junk.code).toBe('invalid_params')
    }
  })
})

describe('executePluginPanelAction notifications.show', () => {
  it('dispatches an attributed notification', async () => {
    const { runtime, dispatchPluginNotification } = createRuntime()
    const outcome = await executePluginPanelAction({
      pluginId: 'model-shift',
      action: 'notifications.show',
      params: { title: 'Shift done', body: 'Now on opus' },
      grantedPermissions: ['notifications.show'],
      runtime
    })
    expect(dispatchPluginNotification).toHaveBeenCalledWith({
      pluginId: 'model-shift',
      title: 'Shift done',
      body: 'Now on opus'
    })
    expect(outcome).toEqual({ ok: true, value: { delivered: true } })
  })

  it('rejects an empty or oversized title', async () => {
    const { runtime, dispatchPluginNotification } = createRuntime()
    for (const params of [{ title: '' }, { title: 'x'.repeat(121) }, {}]) {
      const outcome = await executePluginPanelAction({
        pluginId: 'model-shift',
        action: 'notifications.show',
        params,
        grantedPermissions: ['notifications.show'],
        runtime
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.code).toBe('invalid_params')
      }
    }
    expect(dispatchPluginNotification).not.toHaveBeenCalled()
  })
})
