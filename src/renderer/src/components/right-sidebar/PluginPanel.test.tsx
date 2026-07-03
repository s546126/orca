// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginPanel } from '@/store/plugin-panels'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const { usePluginPanelsMock } = vi.hoisted(() => ({
  usePluginPanelsMock: vi.fn<() => ActivePluginPanel[]>(() => [])
}))

vi.mock('@/store/plugin-panels', () => ({
  usePluginPanels: usePluginPanelsMock
}))

import PluginPanel from './PluginPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const dashboardPanel: ActivePluginPanel = {
  id: 'dashboard',
  title: 'Dashboard',
  icon: 'gauge',
  tabKey: 'plugin:my-plugin/dashboard',
  pluginId: 'my-plugin',
  pluginName: 'My Plugin'
}

let container: HTMLDivElement
let root: Root
const readPanelEntryMock = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  readPanelEntryMock.mockReset()
  usePluginPanelsMock.mockReturnValue([dashboardPanel])
  globalThis.window.api = {
    plugins: { readPanelEntry: readPanelEntryMock }
  } as unknown as Window['api']
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

async function renderPanel(tabKey: string): Promise<void> {
  await act(async () => {
    root.render(<PluginPanel tabKey={tabKey} />)
  })
}

describe('PluginPanel', () => {
  it('renders the panel HTML in a scripts-only sandboxed iframe', async () => {
    readPanelEntryMock.mockResolvedValue({ html: '<h1>Hello plugin</h1>' })

    await renderPanel('plugin:my-plugin/dashboard')

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(readPanelEntryMock).toHaveBeenCalledWith({ pluginId: 'my-plugin', panelId: 'dashboard' })
    expect(iframe?.getAttribute('srcdoc')).toContain('<h1>Hello plugin</h1>')
    expect(iframe?.getAttribute('title')).toBe('Dashboard')
    // Why: allow-same-origin would let plugin HTML reach the app DOM/storage;
    // the sandbox must stay scripts-only.
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('shows an error state when the panel entry cannot be read', async () => {
    readPanelEntryMock.mockResolvedValue(null)

    await renderPanel('plugin:my-plugin/dashboard')

    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('The plugin panel could not be loaded.')
  })

  it('shows an unavailable state for a tab whose plugin is gone', async () => {
    usePluginPanelsMock.mockReturnValue([])

    await renderPanel('plugin:removed-plugin/dashboard')

    expect(readPanelEntryMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain('This plugin panel is no longer available.')
  })

  it('treats a malformed plugin tab key as unavailable', async () => {
    await renderPanel('plugin:not-a-valid-key')

    expect(readPanelEntryMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain('This plugin panel is no longer available.')
  })
})
