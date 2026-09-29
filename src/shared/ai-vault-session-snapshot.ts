import type { AiVaultAgent, AiVaultSession } from './ai-vault-types'
import { deriveAiVaultSessionHost } from './ai-vault-session-host'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from './execution-host'

export const AI_VAULT_ARCHIVE_DIR_NAME = 'ai-vault-archive'
export const AI_VAULT_ARCHIVE_PUBLISHED_DIR = 'published'
export const AI_VAULT_SNAPSHOT_FILE_NAME = 'snapshot.jsonl'
export const AI_VAULT_SNAPSHOT_META_FILE_NAME = 'meta.json'
export const AI_VAULT_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024

export const AI_VAULT_SNAPSHOT_AGENTS = ['claude', 'codex'] as const
export type AiVaultSnapshotAgent = (typeof AI_VAULT_SNAPSHOT_AGENTS)[number]

export type AiVaultSnapshotIdentity = {
  executionHostId: string
  executionBoundary: string
  sourceNamespace: string
  agent: AiVaultSnapshotAgent
  sessionId: string
}

export type AiVaultSnapshotFailureCode =
  | 'unknown-session'
  | 'unsupported-agent'
  | 'non-local-host'
  | 'invalid-path'
  | 'outside-root'
  | 'excluded-path'
  | 'symlink-escape'
  | 'not-a-file'
  | 'incomplete-record'
  | 'source-changed'
  | 'too-large'
  | 'empty-log'
  | 'identity-mismatch'
  | 'incomplete-archive'
  | 'io'

export type AiVaultSnapshotFailure = {
  outcome: 'failed'
  code: AiVaultSnapshotFailureCode
  message: string
}

export function isAiVaultSnapshotAgent(
  agent: AiVaultAgent | string
): agent is AiVaultSnapshotAgent {
  return agent === 'claude' || agent === 'codex'
}

export function isAiVaultHistorySnapshotPath(filePath: string | null | undefined): boolean {
  if (!filePath) {
    return false
  }
  const parts = filePath.split(/[\\/]/)
  const archive = parts.indexOf(AI_VAULT_ARCHIVE_DIR_NAME)
  return archive !== -1 && parts[archive + 1] === AI_VAULT_ARCHIVE_PUBLISHED_DIR
}

export function isAiVaultHistoryOnlySession(
  session: Pick<AiVaultSession, 'filePath' | 'historySnapshot'>
): boolean {
  return (
    session.historySnapshot?.sourceRemoved === true ||
    isAiVaultHistorySnapshotPath(session.filePath)
  )
}

export function canSaveAiVaultSessionLog(
  session: Pick<AiVaultSession, 'agent' | 'executionHostId' | 'filePath' | 'cwd' | 'subagent'>
): boolean {
  return (
    isAiVaultSnapshotAgent(session.agent) &&
    isLocalSnapshotHost(session.executionHostId) &&
    deriveAiVaultSessionHost(session) === 'local' &&
    session.subagent == null
  )
}

export function snapshotFailure(
  code: AiVaultSnapshotFailureCode,
  message: string
): AiVaultSnapshotFailure {
  return { outcome: 'failed', code, message }
}

export function inspectJsonlSnapshot(
  content: string,
  agent: AiVaultSnapshotAgent,
  sessionId: string
):
  | { ok: true; lineCount: number }
  | { ok: false; code: 'empty-log' | 'incomplete-record' | 'identity-mismatch' } {
  if (content.length === 0) {
    return { ok: false, code: 'empty-log' }
  }
  if (!content.endsWith('\n')) {
    return { ok: false, code: 'incomplete-record' }
  }
  const lines = content.slice(0, -1).split('\n')
  let lineCount = 0
  let sawExpectedId = false
  let sawForeignId = false
  for (const line of lines) {
    if (line.length === 0) {
      continue
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return { ok: false, code: 'incomplete-record' }
    }
    lineCount += 1
    const observed = observedSessionId(agent, record)
    if (observed === null) {
      continue
    }
    if (observed === sessionId) {
      sawExpectedId = true
    } else {
      sawForeignId = true
    }
  }
  if (lineCount === 0) {
    return { ok: false, code: 'empty-log' }
  }
  if (sawForeignId || (agent === 'codex' && !sawExpectedId)) {
    return { ok: false, code: 'identity-mismatch' }
  }
  return { ok: true, lineCount }
}

function observedSessionId(agent: AiVaultSnapshotAgent, record: unknown): string | null {
  if (!isRecord(record)) {
    return null
  }
  if (agent === 'claude') {
    const sessionId = record.sessionId
    return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null
  }
  if (record.type !== 'session_meta' || !isRecord(record.payload)) {
    return null
  }
  const id = record.payload.id
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isLocalSnapshotHost(
  executionHostId: ExecutionHostId | string | null | undefined
): boolean {
  return executionHostId === LOCAL_EXECUTION_HOST_ID
}
