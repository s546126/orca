import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { PluginHostListEntry, PluginHostPanel } from '../../../preload/api-types'

/** A panel contribution from an active plugin, flattened for sidebar use. */
export type ActivePluginPanel = PluginHostPanel & {
  pluginId: string
  pluginName: string
}

type PluginPanelsFetchStatus = 'idle' | 'loading' | 'ready' | 'error'

type PluginPanelsState = {
  plugins: PluginHostListEntry[]
  fetchStatus: PluginPanelsFetchStatus
  fetchPlugins: () => Promise<void>
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<void>
}

export const usePluginPanelsStore = create<PluginPanelsState>()((set) => ({
  plugins: [],
  fetchStatus: 'idle',
  fetchPlugins: async () => {
    // Why: preload may predate the plugins namespace (web client pairing an
    // older desktop build); treat a missing bridge as "no plugins" fail-soft.
    const pluginsApi = window.api?.plugins
    if (!pluginsApi) {
      set({ fetchStatus: 'ready', plugins: [] })
      return
    }
    set({ fetchStatus: 'loading' })
    try {
      const plugins = await pluginsApi.list()
      set({ plugins, fetchStatus: 'ready' })
    } catch {
      set({ fetchStatus: 'error' })
    }
  },
  setPluginEnabled: async (pluginId, enabled) => {
    const pluginsApi = window.api?.plugins
    if (!pluginsApi) {
      return
    }
    const plugins = await pluginsApi.setEnabled({ pluginId, enabled })
    set({ plugins, fetchStatus: 'ready' })
  }
}))

/** Kicks off the one-shot startup fetch; safe to call repeatedly. */
export function ensurePluginPanelsLoaded(): void {
  const { fetchStatus, fetchPlugins } = usePluginPanelsStore.getState()
  if (fetchStatus === 'idle') {
    void fetchPlugins()
  }
}

export function collectActivePluginPanels(plugins: PluginHostListEntry[]): ActivePluginPanel[] {
  return plugins
    .filter((plugin) => plugin.status === 'active')
    .flatMap((plugin) =>
      plugin.panels.map((panel) => ({
        ...panel,
        pluginId: plugin.pluginId,
        pluginName: plugin.name
      }))
    )
}

/** Panel contributions of active plugins, loading the list on first use. */
export function usePluginPanels(): ActivePluginPanel[] {
  const plugins = usePluginPanelsStore((s) => s.plugins)
  useEffect(() => {
    ensurePluginPanelsLoaded()
  }, [])
  // Why: derive in useMemo (not the selector) so the store snapshot stays
  // referentially stable and doesn't retrigger useSyncExternalStore loops.
  return useMemo(() => collectActivePluginPanels(plugins), [plugins])
}
