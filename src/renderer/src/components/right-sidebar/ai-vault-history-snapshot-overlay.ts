import { useSyncExternalStore } from 'react'
import type { AiVaultHistorySnapshot, AiVaultSession } from '../../../../shared/ai-vault-types'

type OverlayValue = AiVaultHistorySnapshot | null

const overlays = new Map<string, OverlayValue>()
const listeners = new Set<() => void>()
let version = 0

export function historySnapshotKey(
  session: Pick<AiVaultSession, 'executionHostId' | 'agent' | 'sessionId'>
): string {
  return `${session.executionHostId}\n${session.agent}\n${session.sessionId}`
}

export function setHistorySnapshotOverlay(
  session: Pick<AiVaultSession, 'executionHostId' | 'agent' | 'sessionId'>,
  snapshot: OverlayValue
): void {
  overlays.set(historySnapshotKey(session), snapshot)
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

export function visibleHistorySnapshot(
  session: Pick<AiVaultSession, 'executionHostId' | 'agent' | 'sessionId'> & {
    historySnapshot?: AiVaultHistorySnapshot
  }
): AiVaultHistorySnapshot | null {
  const overlay = overlays.get(historySnapshotKey(session))
  if (overlay !== undefined) {
    return overlay
  }
  return session.historySnapshot ?? null
}

export function sessionWithVisibleSnapshot(session: AiVaultSession): AiVaultSession {
  const snapshot = visibleHistorySnapshot(session)
  if ((session.historySnapshot ?? null) === snapshot) {
    return session
  }
  if (!snapshot) {
    const { historySnapshot: _removed, ...rest } = session
    return rest
  }
  return { ...session, historySnapshot: snapshot }
}

export function useSessionWithVisibleSnapshot(session: AiVaultSession): AiVaultSession {
  useSyncExternalStore(subscribeHistorySnapshotOverlay, getHistorySnapshotOverlayVersion)
  return sessionWithVisibleSnapshot(session)
}

function subscribeHistorySnapshotOverlay(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getHistorySnapshotOverlayVersion(): number {
  return version
}
