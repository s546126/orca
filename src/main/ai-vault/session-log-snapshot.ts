import { lstat, open, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import {
  AI_VAULT_SNAPSHOT_MAX_BYTES,
  inspectJsonlSnapshot,
  isAiVaultHistorySnapshotPath,
  isAiVaultSnapshotAgent,
  isLocalSnapshotHost,
  snapshotFailure,
  type AiVaultSnapshotFailure,
  type AiVaultSnapshotIdentity
} from '../../shared/ai-vault-session-snapshot'
import type { AiVaultHistorySnapshot, AiVaultSession } from '../../shared/ai-vault-types'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  deletePublishedSnapshot,
  historySnapshotFromMeta,
  publishSnapshotDirectory,
  readPublishedSnapshot,
  snapshotArchiveId,
  snapshotContentHash,
  withSnapshotLock,
  type AiVaultSnapshotMeta,
  type SnapshotPublishHooks
} from './session-log-snapshot-store'

export type SaveSessionLogSnapshotArgs = {
  agent: AiVaultSnapshotIdentity['agent']
  executionHostId: string
  executionBoundary: string
  sessionId: string
  filePath: string
  sourceNamespace: string
  archiveRoot: string
  excludePrefixes?: readonly string[]
  hooks?: SnapshotPublishHooks
}

export type SaveSessionLogSnapshotResult =
  | { outcome: 'saved' | 'already-saved'; snapshot: AiVaultHistorySnapshot }
  | AiVaultSnapshotFailure

type ListedSnapshotLookup = {
  agent?: string
  sessionId?: string
  executionHostId?: string
  filePath?: string
}

export function resolveListedSnapshotTarget(
  args: ListedSnapshotLookup,
  sessions: readonly AiVaultSession[]
): { session: AiVaultSession } | AiVaultSnapshotFailure {
  if (!args.agent || !isAiVaultSnapshotAgent(args.agent)) {
    return snapshotFailure(
      'unsupported-agent',
      'Snapshots are available for local Codex and Claude logs.'
    )
  }
  if (!isLocalSnapshotHost(args.executionHostId)) {
    return snapshotFailure(
      'non-local-host',
      'Snapshots can only be saved for logs on this computer.'
    )
  }
  const matches = sessions.filter(
    (session) =>
      session.agent === args.agent &&
      session.sessionId === args.sessionId &&
      session.executionHostId === args.executionHostId &&
      !session.subagent
  )
  const session =
    matches.length === 1
      ? matches[0]
      : matches.find((candidate) => candidate.filePath === args.filePath)
  if (!session || (args.filePath && session.filePath !== args.filePath)) {
    return snapshotFailure(
      'unknown-session',
      'This session is no longer in the history list. Refresh and try again.'
    )
  }
  if (isWslUncPath(session.filePath) || isAiVaultHistorySnapshotPath(session.filePath)) {
    return snapshotFailure(
      'non-local-host',
      'Snapshots can only be saved for logs on this computer.'
    )
  }
  return { session }
}

export async function saveSessionLogSnapshot(
  args: SaveSessionLogSnapshotArgs
): Promise<SaveSessionLogSnapshotResult> {
  let namespace: string
  try {
    namespace = await realpath(args.sourceNamespace)
  } catch {
    return snapshotFailure('invalid-path', 'The history folder for this log could not be resolved.')
  }
  const identity: AiVaultSnapshotIdentity = {
    executionHostId: args.executionHostId,
    executionBoundary: args.executionBoundary,
    sourceNamespace: namespace,
    agent: args.agent,
    sessionId: args.sessionId
  }
  const archiveId = snapshotArchiveId(identity)
  return withSnapshotLock(archiveId, async () => {
    const existing = await readPublishedSnapshot(args.archiveRoot, archiveId)
    if (existing === 'corrupt') {
      return snapshotFailure(
        'incomplete-archive',
        'The saved copy is incomplete. Delete it before saving again.'
      )
    }
    if (existing) {
      return {
        outcome: 'already-saved',
        snapshot: historySnapshotFromMeta(existing, args.archiveRoot, false)
      }
    }
    const read = await readAuthorizedSnapshot(args, namespace)
    if (read.outcome === 'failed') {
      return read
    }
    const meta: AiVaultSnapshotMeta = {
      version: 1,
      archiveId,
      agent: args.agent,
      sessionId: args.sessionId,
      executionHostId: args.executionHostId,
      executionBoundary: args.executionBoundary,
      sourceNamespace: namespace,
      sourcePath: read.sourcePath,
      savedAt: new Date().toISOString(),
      sourceMtimeMs: read.mtimeMs,
      sourceSize: read.content.length,
      byteLength: read.content.length,
      sha256: snapshotContentHash(read.content),
      capture: 'current-log',
      lineCount: read.lineCount
    }
    try {
      await publishSnapshotDirectory({
        archiveRoot: args.archiveRoot,
        archiveId,
        content: read.content,
        meta,
        hooks: args.hooks
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not write the snapshot.'
      return snapshotFailure('io', message)
    }
    const published = await readPublishedSnapshot(args.archiveRoot, archiveId)
    if (!published || published === 'corrupt') {
      return snapshotFailure('io', 'Could not write the snapshot.')
    }
    return {
      outcome: published.sha256 === meta.sha256 ? 'saved' : 'already-saved',
      snapshot: historySnapshotFromMeta(published, args.archiveRoot, false)
    }
  })
}

export async function deleteSessionLogSnapshot(
  archiveRoot: string,
  archiveId: string
): Promise<{ outcome: 'deleted' } | { outcome: 'missing' } | AiVaultSnapshotFailure> {
  try {
    const deleted = await deletePublishedSnapshot(archiveRoot, archiveId)
    return deleted ? { outcome: 'deleted' } : { outcome: 'missing' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not delete the snapshot.'
    return snapshotFailure('io', message)
  }
}

async function readAuthorizedSnapshot(
  args: SaveSessionLogSnapshotArgs,
  namespace: string
): Promise<
  | { outcome: 'ready'; content: Buffer; sourcePath: string; mtimeMs: number; lineCount: number }
  | AiVaultSnapshotFailure
> {
  const requested = resolve(args.filePath)
  const insideCaller = isPathInsideOrEqual(resolve(args.sourceNamespace), requested)
  const insideReal = isPathInsideOrEqual(namespace, requested)
  if (!insideCaller && !insideReal) {
    return snapshotFailure('outside-root', 'That log is outside the authorized history folder.')
  }
  if (isExcludedPath(requested, args.agent, args.excludePrefixes)) {
    return snapshotFailure('excluded-path', 'That log is in an excluded folder.')
  }
  let linked = false
  try {
    linked = (await lstat(requested)).isSymbolicLink()
  } catch {
    return snapshotFailure('invalid-path', 'That log could not be found.')
  }
  let realFile: string
  try {
    realFile = await realpath(requested)
  } catch {
    return snapshotFailure('invalid-path', 'That log could not be found.')
  }
  if (!isPathInsideOrEqual(namespace, realFile)) {
    return snapshotFailure(
      linked ? 'symlink-escape' : 'outside-root',
      'That path points outside the authorized history folder.'
    )
  }
  if (isExcludedPath(realFile, args.agent, args.excludePrefixes)) {
    return snapshotFailure('excluded-path', 'That log is in an excluded folder.')
  }
  let before: Awaited<ReturnType<typeof stat>>
  try {
    before = await stat(realFile)
  } catch {
    return snapshotFailure('invalid-path', 'That log could not be found.')
  }
  if (!before.isFile()) {
    return snapshotFailure('not-a-file', 'That log is not a file.')
  }
  if (before.size > AI_VAULT_SNAPSHOT_MAX_BYTES) {
    return snapshotFailure('too-large', 'The log is larger than the snapshot limit.')
  }
  const handle = await open(realFile, 'r')
  try {
    args.hooks?.onSourceReady?.()
    const opened = await handle.stat()
    if (!sameFileIdentity(before, opened)) {
      return snapshotFailure('source-changed', 'The log changed while it was being copied.')
    }
    const content = Buffer.alloc(opened.size)
    const { bytesRead } = await handle.read(content, 0, opened.size, 0)
    const after = await handle.stat()
    if (!sameFileIdentity(opened, after) || bytesRead !== opened.size) {
      return snapshotFailure('source-changed', 'The log changed while it was being copied.')
    }
    const inspected = inspectJsonlSnapshot(content.toString('utf8'), args.agent, args.sessionId)
    if (!inspected.ok) {
      return snapshotFailure(inspected.code, snapshotContentMessage(inspected.code))
    }
    return {
      outcome: 'ready',
      content,
      sourcePath: realFile,
      mtimeMs: before.mtimeMs,
      lineCount: inspected.lineCount
    }
  } finally {
    await handle.close()
  }
}

function sameFileIdentity(
  left: { dev: number; ino: number; size: number },
  right: { dev: number; ino: number; size: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

function isExcludedPath(
  filePath: string,
  agent: SaveSessionLogSnapshotArgs['agent'],
  excludePrefixes: readonly string[] | undefined
): boolean {
  if ((agent === 'claude' || agent === 'codex') && filePath.split(/[\\/]/).includes('subagents')) {
    return true
  }
  return (excludePrefixes ?? []).some((prefix) => isPathInsideOrEqual(resolve(prefix), filePath))
}

function snapshotContentMessage(
  code: 'empty-log' | 'incomplete-record' | 'identity-mismatch'
): string {
  if (code === 'empty-log') {
    return 'The log has no complete records.'
  }
  if (code === 'identity-mismatch') {
    return 'The log does not belong to this session.'
  }
  return 'The log is still being written or was cut off.'
}
