import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID, normalizeExecutionHostId } from '../../shared/execution-host'
import {
  AI_VAULT_SNAPSHOT_FILE_NAME,
  isAiVaultSnapshotAgent
} from '../../shared/ai-vault-session-snapshot'
import type {
  AiVaultHistorySnapshot,
  AiVaultListResult,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { parseClaudeSessionFile } from './session-scanner-primary-parsers'
import { parseCodexSessionFile } from './session-scanner-codex-parser'
import type { FileWithMtime } from './session-scanner-types'
import {
  historySnapshotFromMeta,
  listPublishedSnapshots,
  publishedSnapshotDir,
  type AiVaultSnapshotMeta
} from './session-log-snapshot-store'

export async function mergeAiVaultHistorySnapshots(
  result: AiVaultListResult,
  archiveRoot: string
): Promise<AiVaultListResult> {
  const metas = await listPublishedSnapshots(archiveRoot)
  if (metas.length === 0) {
    return result
  }
  const realPaths = new Map<string, string | null>()
  const used = new Set<string>()
  const sessions: AiVaultSession[] = []
  for (const session of result.sessions) {
    const meta = await matchingSnapshot(session, metas, realPaths)
    if (!meta) {
      sessions.push(session)
      continue
    }
    used.add(meta.archiveId)
    sessions.push({
      ...session,
      historySnapshot: historySnapshotFromMeta(meta, archiveRoot, false)
    })
  }
  for (const meta of metas) {
    if (used.has(meta.archiveId)) {
      continue
    }
    const snapshot = historySnapshotFromMeta(meta, archiveRoot, true)
    sessions.push(await orphanSnapshotSession(meta, snapshot, archiveRoot))
  }
  const stamp = metas
    .map((meta) => `${meta.archiveId}:${meta.savedAt}`)
    .sort()
    .join(',')
  return {
    ...result,
    sessions,
    scannedAt: `${result.scannedAt}#snap:${stamp}`
  }
}

async function matchingSnapshot(
  session: AiVaultSession,
  metas: readonly AiVaultSnapshotMeta[],
  realPaths: Map<string, string | null>
): Promise<AiVaultSnapshotMeta | null> {
  if (!isAiVaultSnapshotAgent(session.agent) || session.subagent) {
    return null
  }
  const realFile = await rememberedRealpath(session.filePath, realPaths)
  return (
    metas.find(
      (meta) =>
        meta.agent === session.agent &&
        meta.sessionId === session.sessionId &&
        meta.executionHostId === session.executionHostId &&
        realFile !== null &&
        realFile === meta.sourcePath
    ) ?? null
  )
}

async function rememberedRealpath(
  filePath: string,
  realPaths: Map<string, string | null>
): Promise<string | null> {
  const cached = realPaths.get(filePath)
  if (cached !== undefined) {
    return cached
  }
  try {
    const resolved = await realpath(filePath)
    realPaths.set(filePath, resolved)
    return resolved
  } catch {
    realPaths.set(filePath, null)
    return null
  }
}

async function orphanSnapshotSession(
  meta: AiVaultSnapshotMeta,
  snapshot: AiVaultHistorySnapshot,
  archiveRoot: string
): Promise<AiVaultSession> {
  const archivePath = join(
    publishedSnapshotDir(archiveRoot, meta.archiveId),
    AI_VAULT_SNAPSHOT_FILE_NAME
  )
  const parsed = await parseSnapshotFile(meta, archivePath)
  const host = normalizeExecutionHostId(meta.executionHostId) ?? LOCAL_EXECUTION_HOST_ID
  if (!parsed) {
    return emptySnapshotSession(meta, snapshot, archivePath)
  }
  return {
    ...parsed,
    id: `${host}:${meta.agent}:${meta.sessionId}:${archivePath}`,
    executionHostId: host,
    filePath: archivePath,
    codexHome: null,
    resumeCommand: '',
    historySnapshot: snapshot
  }
}

async function parseSnapshotFile(
  meta: AiVaultSnapshotMeta,
  archivePath: string
): Promise<AiVaultSession | null> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(archivePath)
  } catch {
    return null
  }
  const file: FileWithMtime = {
    path: archivePath,
    mtimeMs: info.mtimeMs,
    modifiedAt: meta.savedAt,
    sizeBytes: info.size
  }
  const host = normalizeExecutionHostId(meta.executionHostId) ?? LOCAL_EXECUTION_HOST_ID
  if (meta.agent === 'claude') {
    return parseClaudeSessionFile(file, process.platform)
  }
  return parseCodexSessionFile(file, process.platform, null, host)
}

function emptySnapshotSession(
  meta: AiVaultSnapshotMeta,
  snapshot: AiVaultHistorySnapshot,
  archivePath: string
): AiVaultSession {
  const host = normalizeExecutionHostId(meta.executionHostId) ?? LOCAL_EXECUTION_HOST_ID
  return {
    id: `${host}:${meta.agent}:${meta.sessionId}:${archivePath}`,
    executionHostId: host,
    agent: meta.agent,
    sessionId: meta.sessionId,
    title: meta.sessionId,
    cwd: null,
    branch: null,
    model: null,
    filePath: archivePath,
    codexHome: null,
    createdAt: null,
    updatedAt: meta.savedAt,
    modifiedAt: meta.savedAt,
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    historySnapshot: snapshot
  }
}
