import { ipcMain } from 'electron'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  isAiVaultSnapshotAgent,
  snapshotFailure,
  type AiVaultSnapshotFailure
} from '../../shared/ai-vault-session-snapshot'
import type { AiVaultHistorySnapshot, AiVaultSession } from '../../shared/ai-vault-types'
import { localAiVaultScanRoots } from '../ai-vault/cached-session-list'
import {
  indexListedSessionMessages,
  listedAiVaultSessions,
  replaceListedSessionSnapshot
} from '../ai-vault/listed-session-search'
import { AI_VAULT_AGENT_SOURCES } from '../ai-vault/session-scanner-agent-sources'
import {
  deleteSessionLogSnapshot,
  resolveListedSnapshotTarget,
  saveSessionLogSnapshot
} from '../ai-vault/session-log-snapshot'
import { historyArchiveRoot } from './ai-vault-history-archive-root'

export type SaveAiVaultSessionSnapshotArgs = {
  agent?: string
  sessionId?: string
  executionHostId?: string
  filePath?: string
}

export type DeleteAiVaultSessionSnapshotArgs = {
  archiveId?: string
  agent?: string
  sessionId?: string
  executionHostId?: string
  filePath?: string
}

export function registerAiVaultSnapshotHandlers(): void {
  ipcMain.handle('aiVault:saveSessionSnapshot', (_event, args?: SaveAiVaultSessionSnapshotArgs) =>
    saveListedSessionSnapshot(args)
  )
  ipcMain.handle(
    'aiVault:deleteSessionSnapshot',
    (_event, args?: DeleteAiVaultSessionSnapshotArgs) => deleteListedSessionSnapshot(args)
  )
}

export async function saveListedSessionSnapshot(
  args: SaveAiVaultSessionSnapshotArgs | undefined
): Promise<
  { outcome: 'saved' | 'already-saved'; snapshot: AiVaultHistorySnapshot } | AiVaultSnapshotFailure
> {
  const resolved = resolveListedSnapshotTarget(args ?? {}, listedAiVaultSessions())
  if ('outcome' in resolved) {
    return resolved
  }
  const archiveRoot = historyArchiveRoot()
  if (!archiveRoot) {
    return snapshotFailure('io', 'Could not write the snapshot.')
  }
  const namespace = await snapshotNamespaceForSession(resolved.session)
  if (!namespace) {
    return snapshotFailure('outside-root', 'That log is outside the authorized history folder.')
  }
  const saved = await saveSessionLogSnapshot({
    agent: resolved.session.agent === 'codex' ? 'codex' : 'claude',
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    executionBoundary: 'native',
    sessionId: resolved.session.sessionId,
    filePath: resolved.session.filePath,
    sourceNamespace: namespace,
    archiveRoot
  })
  if (saved.outcome !== 'failed') {
    const sessions = replaceListedSessionSnapshot(resolved.session, {
      ...saved.snapshot,
      sourceRemoved: false
    })
    void indexListedSessionMessages(sessions).catch((error) => {
      console.warn('[ai-vault] Failed to index a saved snapshot:', error)
    })
  }
  return saved
}

export async function deleteListedSessionSnapshot(
  args: DeleteAiVaultSessionSnapshotArgs | undefined
): Promise<{ outcome: 'deleted' | 'missing' } | AiVaultSnapshotFailure> {
  const archiveId = args?.archiveId?.trim() ?? ''
  if (!/^[a-f0-9]{32}$/.test(archiveId)) {
    return snapshotFailure('invalid-path', 'That saved copy could not be found.')
  }
  const archiveRoot = historyArchiveRoot()
  if (!archiveRoot) {
    return snapshotFailure('io', 'Could not delete the snapshot.')
  }
  const result = await deleteSessionLogSnapshot(archiveRoot, archiveId)
  if (result.outcome === 'deleted') {
    const listed = listedAiVaultSessions().find(
      (session) => session.historySnapshot?.archiveId === archiveId
    )
    if (listed) {
      const sessions = replaceListedSessionSnapshot(listed, null)
      void indexListedSessionMessages(sessions).catch((error) => {
        console.warn('[ai-vault] Failed to drop a deleted snapshot from the index:', error)
      })
    }
  }
  return result
}

async function snapshotNamespaceForSession(session: AiVaultSession): Promise<string | null> {
  if (!isAiVaultSnapshotAgent(session.agent)) {
    return null
  }
  const source = AI_VAULT_AGENT_SOURCES[session.agent]
  if (!source) {
    return null
  }
  const scanRoots = await localAiVaultScanRoots()
  const filePath = resolve(session.filePath)
  const matched = source
    .rootDirs(scanRoots, scanRoots.wslHomeDirs)
    .map((root) => resolve(root))
    .find((root) => root.length > 0 && isPathInsideOrEqual(root, filePath))
  if (!matched) {
    return null
  }
  try {
    return await realpath(matched)
  } catch {
    return null
  }
}
