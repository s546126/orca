import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { applyPluginEnablement } from './plugin-enablement'
import type { PluginListEntry, PluginService } from './plugin-service'

function makeFixture(initial: { disabled?: string[]; approved?: string[] } = {}): {
  store: Store
  pluginService: PluginService
  updateSettings: ReturnType<typeof vi.fn>
  setPluginEnabled: ReturnType<typeof vi.fn>
  listed: PluginListEntry[]
} {
  const settings = {
    disabledPlugins: initial.disabled ?? [],
    approvedPlugins: initial.approved ?? []
  }
  const updateSettings = vi.fn((updates: Partial<typeof settings>) => {
    Object.assign(settings, updates)
    return settings
  })
  const setPluginEnabled = vi.fn().mockResolvedValue(undefined)
  const listed: PluginListEntry[] = [
    { pluginId: 'model-shift', name: 'ModelShift', version: '1.0.0', status: 'active', panels: [] }
  ]
  return {
    store: { getSettings: () => settings, updateSettings } as unknown as Store,
    pluginService: { setPluginEnabled, listPlugins: () => listed } as unknown as PluginService,
    updateSettings,
    setPluginEnabled,
    listed
  }
}

describe('applyPluginEnablement', () => {
  it('enable records consent and un-disables before starting the plugin', async () => {
    const fixture = makeFixture({ disabled: ['model-shift'] })
    const result = await applyPluginEnablement({
      store: fixture.store,
      pluginService: fixture.pluginService,
      pluginId: 'model-shift',
      enabled: true
    })

    expect(fixture.updateSettings).toHaveBeenCalledWith(
      { disabledPlugins: [], approvedPlugins: ['model-shift'] },
      { notifyListeners: true, originWebContentsId: undefined }
    )
    // Settings persist before the service starts the host, so the service's
    // own consent check sees the approval.
    expect(fixture.updateSettings.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.setPluginEnabled.mock.invocationCallOrder[0]!
    )
    expect(fixture.setPluginEnabled).toHaveBeenCalledWith('model-shift', true)
    expect(result).toBe(fixture.listed)
  })

  it('disable keeps the prior approval so re-enabling never re-prompts', async () => {
    const fixture = makeFixture({ approved: ['model-shift'] })
    await applyPluginEnablement({
      store: fixture.store,
      pluginService: fixture.pluginService,
      pluginId: 'model-shift',
      enabled: false
    })

    expect(fixture.updateSettings).toHaveBeenCalledWith(
      { disabledPlugins: ['model-shift'], approvedPlugins: ['model-shift'] },
      { notifyListeners: true, originWebContentsId: undefined }
    )
    expect(fixture.setPluginEnabled).toHaveBeenCalledWith('model-shift', false)
  })
})
