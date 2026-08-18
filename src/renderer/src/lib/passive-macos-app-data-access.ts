import type {
  ActiveRightSidebarTab,
  OpenFile,
  RightSidebarExplorerView
} from '@/store/slices/editor'

const MAC_APP_DATA_SEGMENT_RE = /(^|\/)Library\/(Containers|Group Containers)\//

function getUserAgent(userAgent?: string): string {
  if (userAgent !== undefined) {
    return userAgent
  }
  return typeof navigator === 'undefined' ? '' : navigator.userAgent
}

export function isMacAppDataPath(path: string | null | undefined, userAgent?: string): boolean {
  if (!path || !getUserAgent(userAgent).includes('Mac')) {
    return false
  }
  return MAC_APP_DATA_SEGMENT_RE.test(path.replace(/\\/g, '/'))
}

export const GIT_STATUS_FOREGROUND_POLL_MS = 3_000
export const GIT_STATUS_IDLE_POLL_MS = 15_000

export function resolveGitStatusPollIntervalMs(
  args: Parameters<typeof shouldPollActiveGitStatus>[0]
): number | null {
  if (!shouldPollActiveGitStatus(args)) {
    return null
  }
  if (
    args.rightSidebarOpen &&
    (args.rightSidebarTab === 'source-control' || args.rightSidebarTab === 'checks')
  ) {
    return GIT_STATUS_FOREGROUND_POLL_MS
  }
  // Why: idle explorer / background identity can rely on file-watch plus a
  // slower backup. A 3s tick kept renderer IPC and store updates hot.
  return GIT_STATUS_IDLE_POLL_MS
}

export function shouldPollActiveGitStatus(args: {
  activeWorktreeId: string | null
  worktreePath: string | null
  rightSidebarOpen: boolean
  rightSidebarTab: ActiveRightSidebarTab
  rightSidebarExplorerView?: RightSidebarExplorerView
  openFiles?: OpenFile[]
  userAgent?: string
}): boolean {
  if (!args.activeWorktreeId || !args.worktreePath) {
    return false
  }
  if (
    args.rightSidebarOpen &&
    (args.rightSidebarTab === 'source-control' ||
      (args.rightSidebarTab === 'explorer' && args.rightSidebarExplorerView !== 'search') ||
      args.rightSidebarTab === 'checks')
  ) {
    return true
  }
  if ((args.openFiles ?? []).some((file) => file.worktreeId === args.activeWorktreeId)) {
    return true
  }
  // Why: macOS app-container paths can trigger the "data from other apps"
  // prompt. Keep terminal-only workspace switching from passively probing them.
  return !isMacAppDataPath(args.worktreePath, args.userAgent)
}
