import type { ActiveRightSidebarTab, RightSidebarExplorerView } from '../../../shared/types'
import { isPluginPanelTabKey } from '../../../shared/plugins/plugin-manifest'

export type RightSidebarRoute = {
  rightSidebarTab: ActiveRightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
}

function normalizeRightSidebarExplorerView(view: unknown): RightSidebarExplorerView {
  return view === 'search' ? 'search' : 'files'
}

export function normalizeRightSidebarRoute(
  tab: unknown,
  explorerView?: unknown
): RightSidebarRoute {
  // Why: older builds persisted Search as a standalone activity tab.
  if (tab === 'search') {
    return { rightSidebarTab: 'explorer', rightSidebarExplorerView: 'search' }
  }
  // Why: plugin tabs are open-ended keys; validate their shape so a persisted
  // plugin tab isn't reset to Explorer. Uninstalled plugins still fall back at
  // render time via resolveRightSidebarEffectiveTab.
  if (typeof tab === 'string' && isPluginPanelTabKey(tab)) {
    return { rightSidebarTab: tab, rightSidebarExplorerView: 'files' }
  }
  if (
    tab === 'explorer' ||
    tab === 'vault' ||
    tab === 'workspaces' ||
    tab === 'pr-checks' ||
    tab === 'source-control' ||
    tab === 'checks' ||
    tab === 'ports'
  ) {
    return {
      rightSidebarTab: tab,
      rightSidebarExplorerView:
        tab === 'explorer' ? normalizeRightSidebarExplorerView(explorerView) : 'files'
    }
  }
  return { rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files' }
}
