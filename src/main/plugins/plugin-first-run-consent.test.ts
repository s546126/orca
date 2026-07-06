import { describe, expect, it, vi } from 'vitest'
import { promptForPendingPlugins } from './plugin-first-run-consent'
import type { PluginListEntry, PluginService } from './plugin-service'

function entry(pluginId: string, status: PluginListEntry['status']): PluginListEntry {
  return { pluginId, name: `Plugin ${pluginId}`, version: '1.0.0', status, panels: [] }
}

function stubService(entries: PluginListEntry[]): PluginService {
  return {
    whenReady: async () => undefined,
    listPlugins: () => entries
  } as unknown as PluginService
}

describe('promptForPendingPlugins', () => {
  it('prompts only for pending plugins and applies each answer', async () => {
    const showMessageBox = vi
      .fn()
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 1 })
    const applyEnablement = vi.fn().mockResolvedValue(undefined)

    await promptForPendingPlugins({
      pluginService: stubService([
        entry('already-active', 'active'),
        entry('new-one', 'pending'),
        entry('was-disabled', 'disabled'),
        entry('new-two', 'pending'),
        entry('broken', 'error')
      ]),
      showMessageBox,
      applyEnablement
    })

    expect(showMessageBox).toHaveBeenCalledTimes(2)
    expect(applyEnablement).toHaveBeenNthCalledWith(1, 'new-one', true)
    expect(applyEnablement).toHaveBeenNthCalledWith(2, 'new-two', false)
  })

  it('defaults the dialog to the safe answer and warns about system access', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 })
    await promptForPendingPlugins({
      pluginService: stubService([entry('new-one', 'pending')]),
      showMessageBox,
      applyEnablement: vi.fn().mockResolvedValue(undefined)
    })

    const options = showMessageBox.mock.calls[0]![0]
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
    expect(options.buttons[0]).toBe('Enable Plugin')
    expect(options.detail).toContain('same system access as Orca')
  })

  it('does nothing when no plugin is pending', async () => {
    const showMessageBox = vi.fn()
    await promptForPendingPlugins({
      pluginService: stubService([entry('already-active', 'active')]),
      showMessageBox,
      applyEnablement: vi.fn()
    })
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
