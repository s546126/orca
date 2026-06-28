import type { EmulatorSessionInfo } from './emulator-types'
import type { EmulatorSessionState } from './emulator-bridge-types'

// Why: two remote Android hosts can both expose 127.0.0.1:5555, so serials are
// keyed by (hostId, serial). When hostId is undefined (all iOS sessions today)
// the key is just the serial, preserving existing behavior exactly.
function sessionKey(deviceUdid: string, hostId?: string): string {
  return hostId ? `${hostId}::${deviceUdid}` : deviceUdid
}

export class EmulatorSessionRegistry {
  private readonly activeByWorktree = new Map<string, string>()
  private readonly sessions = new Map<string, EmulatorSessionState>()

  registerActive(
    worktreeId: string,
    info: EmulatorSessionInfo,
    options: { managed?: boolean } = {}
  ): void {
    const key = sessionKey(info.deviceUdid, info.hostId)
    this.sessions.set(key, {
      deviceUdid: info.deviceUdid,
      wsUrl: info.wsUrl,
      streamUrl: info.streamUrl,
      axUrl: info.axUrl,
      pid: info.helperPid,
      managed: options.managed === true,
      initialized: true,
      kind: info.kind ?? 'ios',
      streamKind: info.streamKind,
      hostId: info.hostId
    })
    this.activeByWorktree.set(worktreeId, key)
  }

  unregisterWorktree(worktreeId: string): void {
    this.activeByWorktree.delete(worktreeId)
  }

  getActiveForWorktree(worktreeId?: string): EmulatorSessionInfo | null {
    if (!worktreeId) {
      return null
    }
    const key = this.activeByWorktree.get(worktreeId)
    if (!key) {
      return null
    }
    const session = this.sessions.get(key)
    return session ? toSessionInfo(session) : null
  }

  getActiveSessionKey(worktreeId: string): string | null {
    return this.activeByWorktree.get(worktreeId) ?? null
  }

  getSession(key: string): EmulatorSessionState | undefined {
    return this.sessions.get(key)
  }

  // Resolve the composite session key (hostId::serial for Android, bare udid for
  // iOS) from a raw device udid. WHY: kill/shutdown receive only the serial, but
  // Android sessions are keyed by host, so clearing by the raw serial would strand
  // the keyed record. First match only — callers disambiguate by worktree first.
  getSessionKeyForUdid(udid: string): string | null {
    for (const [key, session] of this.sessions.entries()) {
      if (session.deviceUdid === udid) {
        return key
      }
    }
    return null
  }

  listSessions(): EmulatorSessionState[] {
    return [...this.sessions.values()]
  }

  clearSessionAndWorktrees(key: string): void {
    this.sessions.delete(key)
    for (const [worktreeId, activeKey] of this.activeByWorktree.entries()) {
      if (activeKey === key) {
        this.activeByWorktree.delete(worktreeId)
      }
    }
  }

  clear(): void {
    this.sessions.clear()
    this.activeByWorktree.clear()
  }

  // Clear only the sessions (and their worktree mappings) owned by one bridge
  // kind. WHY: the registry is shared across iOS/Android bridges, so a blanket
  // clear() during one kind's destroyAll would wipe the other kind's live
  // sessions. Sessions stored without a kind are legacy iOS (see registerActive).
  clearSessionsOfKind(kind: 'ios' | 'android'): void {
    // Map iteration tolerates deleting the current/visited entries, so collecting
    // matching keys first keeps the delete loop independent of iterator order.
    const keys: string[] = []
    for (const [key, session] of this.sessions.entries()) {
      if ((session.kind ?? 'ios') === kind) {
        keys.push(key)
      }
    }
    for (const key of keys) {
      this.clearSessionAndWorktrees(key)
    }
  }
}

function toSessionInfo(session: EmulatorSessionState): EmulatorSessionInfo {
  return {
    deviceUdid: session.deviceUdid,
    wsUrl: session.wsUrl,
    streamUrl: session.streamUrl,
    axUrl: session.axUrl,
    helperPid: session.pid,
    streamKind: session.streamKind,
    hostId: session.hostId,
    // Why: only emit kind when 'android' so iOS session info stays structurally
    // identical to today (a defined kind:'ios' would break deep-equality tests).
    ...(session.kind === 'android' ? { kind: 'android' as const } : {})
  }
}
