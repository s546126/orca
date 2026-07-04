import React, { useEffect, useRef, useState } from 'react'
import { isPluginPanelTabKey } from '../../../../shared/plugins/plugin-manifest'
import {
  callPanelActionViaPreload,
  createPanelBridgeMessageHandler
} from './plugin-panel-bridge-host'
import { usePluginPanels } from '@/store/plugin-panels'
import { translate } from '@/i18n/i18n'

type PluginPanelProps = {
  tabKey: string
}

type PluginPanelEntryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; html: string }

function PluginPanelMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function PluginPanel({ tabKey }: PluginPanelProps): React.JSX.Element {
  const panels = usePluginPanels()
  const panel = isPluginPanelTabKey(tabKey)
    ? (panels.find((entry) => entry.tabKey === tabKey) ?? null)
    : null
  const [entryState, setEntryState] = useState<PluginPanelEntryState>({ status: 'loading' })
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const pluginId = panel?.pluginId ?? null
  const panelId = panel?.id ?? null

  useEffect(() => {
    if (!pluginId || !panelId || entryState.status !== 'ready') {
      return
    }
    const handler = createPanelBridgeMessageHandler({
      pluginId,
      panelId,
      getPanelWindow: () => iframeRef.current?.contentWindow ?? null,
      callPanelAction: callPanelActionViaPreload
    })
    window.addEventListener('message', handler)
    return () => {
      window.removeEventListener('message', handler)
    }
  }, [pluginId, panelId, entryState.status])

  useEffect(() => {
    if (!pluginId || !panelId) {
      return
    }
    let cancelled = false
    setEntryState({ status: 'loading' })
    const pluginsApi = window.api?.plugins
    if (!pluginsApi) {
      setEntryState({ status: 'error' })
      return
    }
    pluginsApi
      .readPanelEntry({ pluginId, panelId })
      .then((entry) => {
        if (!cancelled) {
          setEntryState(entry ? { status: 'ready', html: entry.html } : { status: 'error' })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntryState({ status: 'error' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [pluginId, panelId])

  // Persisted plugin tabs can outlive their plugin (uninstalled/disabled);
  // render a graceful empty state instead of a broken frame.
  if (!panel) {
    return (
      <PluginPanelMessage>
        {translate(
          'auto.components.right.sidebar.PluginPanel.unavailable',
          'This plugin panel is no longer available.'
        )}
      </PluginPanelMessage>
    )
  }

  if (entryState.status === 'loading') {
    return (
      <PluginPanelMessage>
        {translate('auto.components.right.sidebar.PluginPanel.loading', 'Loading plugin panel...')}
      </PluginPanelMessage>
    )
  }

  if (entryState.status === 'error') {
    return (
      <PluginPanelMessage>
        {translate(
          'auto.components.right.sidebar.PluginPanel.loadFailed',
          'The plugin panel could not be loaded.'
        )}
      </PluginPanelMessage>
    )
  }

  return (
    <iframe
      ref={iframeRef}
      // SECURITY: never add allow-same-origin — the srcdoc frame must stay an
      // opaque origin so plugin UI cannot reach the app DOM, storage, or IPC.
      sandbox="allow-scripts"
      srcDoc={entryState.html}
      title={panel.title}
      className="h-full w-full flex-1 border-0 bg-background"
    />
  )
}

export default PluginPanel
