import { createHash, randomBytes } from 'node:crypto'
import { open, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AI_VAULT_ARCHIVE_PUBLISHED_DIR,
  AI_VAULT_SNAPSHOT_FILE_NAME,
  AI_VAULT_SNAPSHOT_META_FILE_NAME,
  type AiVaultSnapshotIdentity
} from '../../shared/ai-vault-session-snapshot'
import type { AiVaultHistorySnapshot } from '../../shared/ai-vault-types'

const ARCHIVE_ID_PATTERN = /^[a-f0-9]{32}$/

export type AiVaultSnapshotMeta = {
  version: 1
  archiveId: string
  agent: AiVaultSnapshotIdentity['agent']
  sessionId: string
  executionHostId: string
  executionBoundary: string
  sourceNamespace: string
  sourcePath: string
  savedAt: string
  sourceMtimeMs: number
  sourceSize: number
  byteLength: number
  sha256: string
  capture: 'current-log'
  lineCount: number
}

export type SnapshotPublishHooks = {
  afterContentWrite?: () => void
  afterMetadataWrite?: () => void
  beforePublish?: () => void
  onSourceReady?: () => void
}

const archiveLocks = new Map<string, Promise<void>>()

export function snapshotArchiveId(identity: AiVaultSnapshotIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity.executionHostId,
        identity.executionBoundary,
        identity.sourceNamespace,
        identity.agent,
        identity.sessionId
      ])
    )
    .digest('hex')
    .slice(0, 32)
}

export function publishedSnapshotDir(archiveRoot: string, archiveId: string): string {
  return join(archiveRoot, AI_VAULT_ARCHIVE_PUBLISHED_DIR, archiveId)
}

export function snapshotContentHash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

export async function withSnapshotLock<T>(archiveId: string, run: () => Promise<T>): Promise<T> {
  const previous = archiveLocks.get(archiveId) ?? Promise.resolve()
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  archiveLocks.set(archiveId, tail)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (archiveLocks.get(archiveId) === tail) {
      archiveLocks.delete(archiveId)
    }
  }
}

export function resetSnapshotLocksForTests(): void {
  archiveLocks.clear()
}

export async function readPublishedSnapshot(
  archiveRoot: string,
  archiveId: string
): Promise<AiVaultSnapshotMeta | null | 'corrupt'> {
  if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
    return 'corrupt'
  }
  const dir = publishedSnapshotDir(archiveRoot, archiveId)
  try {
    const [metaRaw, content] = await Promise.all([
      readFile(join(dir, AI_VAULT_SNAPSHOT_META_FILE_NAME), 'utf8'),
      readFile(join(dir, AI_VAULT_SNAPSHOT_FILE_NAME))
    ])
    const meta = parseSnapshotMeta(metaRaw, archiveId)
    if (
      !meta ||
      meta.byteLength !== content.length ||
      meta.sha256 !== snapshotContentHash(content)
    ) {
      return 'corrupt'
    }
    return meta
  } catch (error) {
    if (isMissingFile(error)) {
      return null
    }
    return 'corrupt'
  }
}

export async function listPublishedSnapshots(archiveRoot: string): Promise<AiVaultSnapshotMeta[]> {
  let names: string[]
  try {
    names = await readdir(join(archiveRoot, AI_VAULT_ARCHIVE_PUBLISHED_DIR))
  } catch (error) {
    if (isMissingFile(error)) {
      return []
    }
    throw error
  }
  const metas: AiVaultSnapshotMeta[] = []
  for (const name of names) {
    if (!ARCHIVE_ID_PATTERN.test(name)) {
      continue
    }
    const meta = await readPublishedSnapshot(archiveRoot, name)
    if (meta && meta !== 'corrupt') {
      metas.push(meta)
    }
  }
  return metas
}

// Content and metadata land in one staging directory and become visible together
// when that directory is renamed. A failure removes only the staging directory.
export async function publishSnapshotDirectory(args: {
  archiveRoot: string
  archiveId: string
  content: Buffer
  meta: AiVaultSnapshotMeta
  hooks?: SnapshotPublishHooks
}): Promise<void> {
  const stagingParent = join(args.archiveRoot, 'staging')
  const publishedParent = join(args.archiveRoot, AI_VAULT_ARCHIVE_PUBLISHED_DIR)
  await mkdir(stagingParent, { recursive: true })
  await mkdir(publishedParent, { recursive: true })
  const staging = join(stagingParent, randomBytes(8).toString('hex'))
  await mkdir(staging, { recursive: false })
  let published = false
  try {
    await writeDurableFile(join(staging, AI_VAULT_SNAPSHOT_FILE_NAME), args.content)
    args.hooks?.afterContentWrite?.()
    await writeDurableFile(
      join(staging, AI_VAULT_SNAPSHOT_META_FILE_NAME),
      JSON.stringify(args.meta)
    )
    args.hooks?.afterMetadataWrite?.()
    await fsyncDirectory(staging)
    args.hooks?.beforePublish?.()
    const existing = await readPublishedSnapshot(args.archiveRoot, args.archiveId)
    if (existing === 'corrupt') {
      throw new Error('The existing snapshot is incomplete.')
    }
    if (existing) {
      return
    }
    await rename(staging, publishedSnapshotDir(args.archiveRoot, args.archiveId))
    published = true
    await fsyncDirectory(publishedParent)
  } finally {
    if (!published) {
      await rm(staging, { recursive: true, force: true })
    }
  }
}

export async function deletePublishedSnapshot(
  archiveRoot: string,
  archiveId: string
): Promise<boolean> {
  if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
    return false
  }
  const dir = publishedSnapshotDir(archiveRoot, archiveId)
  try {
    await rm(dir, { recursive: true, force: false })
    return true
  } catch (error) {
    if (isMissingFile(error)) {
      return false
    }
    throw error
  }
}

export function historySnapshotFromMeta(
  meta: AiVaultSnapshotMeta,
  archiveRoot: string,
  sourceRemoved: boolean
): AiVaultHistorySnapshot {
  return {
    archiveId: meta.archiveId,
    archivePath: join(
      publishedSnapshotDir(archiveRoot, meta.archiveId),
      AI_VAULT_SNAPSHOT_FILE_NAME
    ),
    savedAt: meta.savedAt,
    sourceRemoved,
    capture: 'current-log'
  }
}

function parseSnapshotMeta(raw: string, archiveId: string): AiVaultSnapshotMeta | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) {
    return null
  }
  const agent = value.agent
  const sessionId = value.sessionId
  const executionHostId = value.executionHostId
  const executionBoundary = value.executionBoundary
  const sourceNamespace = value.sourceNamespace
  const sourcePath = value.sourcePath
  const savedAt = value.savedAt
  const sourceMtimeMs = value.sourceMtimeMs
  const sourceSize = value.sourceSize
  const sha256 = value.sha256
  const byteLength = value.byteLength
  const lineCount = value.lineCount
  if (
    value.version !== 1 ||
    value.archiveId !== archiveId ||
    (agent !== 'claude' && agent !== 'codex') ||
    typeof sessionId !== 'string' ||
    typeof executionHostId !== 'string' ||
    typeof executionBoundary !== 'string' ||
    typeof sourceNamespace !== 'string' ||
    typeof sourcePath !== 'string' ||
    typeof savedAt !== 'string' ||
    typeof sourceMtimeMs !== 'number' ||
    typeof sourceSize !== 'number' ||
    typeof sha256 !== 'string' ||
    typeof byteLength !== 'number' ||
    typeof lineCount !== 'number' ||
    value.capture !== 'current-log'
  ) {
    return null
  }
  return {
    version: 1,
    archiveId,
    agent,
    sessionId,
    executionHostId,
    executionBoundary,
    sourceNamespace,
    sourcePath,
    savedAt,
    sourceMtimeMs,
    sourceSize,
    byteLength,
    sha256,
    capture: 'current-log',
    lineCount
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function writeDurableFile(path: string, data: Buffer | string): Promise<void> {
  const handle = await open(path, 'w', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } catch {
    // Directory fsync is not available on every platform. The rename is still atomic.
  } finally {
    await handle.close()
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
