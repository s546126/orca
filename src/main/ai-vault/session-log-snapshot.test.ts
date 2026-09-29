import { truncateSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openedPaths = vi.hoisted(() => {
  const paths: string[] = []
  return { paths }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      const [path] = args
      if (typeof path === 'string') {
        openedPaths.paths.push(path)
      }
      return actual.open(...args)
    }
  }
})
import { removeSessionSearchDatabase } from '../ai-vault-search/session-search-schema'
import { AiVaultSessionMessageFtsStore } from './session-message-fts-store'
import { prepareAiVaultSessionResume } from '../ipc/ai-vault-resume'
import { mergeAiVaultHistorySnapshots } from './session-log-snapshot-merge'
import {
  deleteSessionLogSnapshot,
  resolveListedSnapshotTarget,
  saveSessionLogSnapshot,
  type SaveSessionLogSnapshotArgs
} from './session-log-snapshot'
import { resetSnapshotLocksForTests } from './session-log-snapshot-store'
import { isAiVaultHistorySnapshotPath } from '../../shared/ai-vault-session-snapshot'

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  openedPaths.paths.length = 0
  resetSnapshotLocksForTests()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('session log snapshots', () => {
  it('keeps Codex and Claude logs searchable after the originals are removed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'))
    const layout = await createLayout()
    const claude = await writeLog(layout.claudeRoot, 'claude-session.jsonl', claudeLog())
    const codex = await writeLog(layout.codexRoot, 'codex-session.jsonl', codexLog())
    const claudeSaved = await save(layout, {
      agent: 'claude',
      sessionId: 'claude-session',
      filePath: claude
    })
    const codexSaved = await save(layout, {
      agent: 'codex',
      sessionId: 'codex-session',
      filePath: codex
    })
    expect(claudeSaved.outcome).toBe('saved')
    expect(codexSaved.outcome).toBe('saved')
    await rm(claude)
    await rm(codex)

    const merged = await mergeAiVaultHistorySnapshots(
      { sessions: [], issues: [], scannedAt: '2026-09-29T00:00:00.000Z' },
      layout.archiveRoot
    )
    expect(merged.sessions).toHaveLength(2)
    for (const session of merged.sessions) {
      expect(session.resumeCommand).toBe('')
      expect(session.historySnapshot?.sourceRemoved).toBe(true)
      expect(isAiVaultHistorySnapshotPath(session.filePath)).toBe(true)
      expect(session).not.toHaveProperty('workspaceId')
    }
    const store = await AiVaultSessionMessageFtsStore.open(join(layout.root, 'messages.sqlite'))
    await store.sync(merged.sessions)
    for (const [sessionId, marker] of [
      ['claude-session', 'DEEP_CLAUDE_MARKER'],
      ['codex-session', 'DEEP_CODEX_MARKER']
    ] as const) {
      const session = merged.sessions.find((item) => item.sessionId === sessionId)
      const hit = store.search({
        query: marker,
        searchScope: 'full',
        sessionIds: [session!.id]
      })
      expect(hit.matchedIds).toEqual([session!.id])
      expect(hit.hits[0]?.jump.filePath).toBe(session!.historySnapshot?.archivePath)
      expect(hit.hits[0]?.jump.lineNumber).toBeGreaterThan(1)
      const copy = await readFile(session!.filePath, 'utf8')
      expect(copy).toContain(
        marker === 'DEEP_CLAUDE_MARKER' ? 'EARLY_CLAUDE_MARKER' : 'EARLY_CODEX_MARKER'
      )
      expect(copy).toContain(marker)
    }
    store.close()
    await expect(
      prepareAiVaultSessionResume(
        {
          agent: 'codex',
          filePath: merged.sessions[0]!.filePath,
          codexHome: null,
          executionHostId: 'local'
        },
        {}
      )
    ).rejects.toThrow('Saved history snapshots cannot be resumed.')
    removeSessionSearchDatabase(join(layout.root, 'ai-vault', 'session-search.sqlite'))
    expect(await readFile(merged.sessions[0]!.filePath, 'utf8')).toContain('MARKER')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects symlink escapes, excluded paths, and forged ids without reading them', async () => {
    const layout = await createLayout()
    const outside = join(layout.root, 'outside.jsonl')
    await writeFile(outside, `${JSON.stringify({ secret: 'SECRET_OUTSIDE' })}\n`)
    const linkPath = join(layout.claudeRoot, 'escape.jsonl')
    await symlink(outside, linkPath)
    openedPaths.paths.length = 0
    const escaped = await save(layout, {
      agent: 'claude',
      sessionId: 'claude-session',
      filePath: linkPath
    })
    expect(escaped).toMatchObject({ outcome: 'failed', code: 'symlink-escape' })
    expect(openedPaths.paths).toEqual([])
    const excludedDir = join(layout.codexRoot, 'excluded')
    await mkdir(excludedDir)
    const allowed = join(layout.codexRoot, 'allowed.jsonl')
    await writeFile(allowed, codexLog())
    const alias = join(excludedDir, 'alias.jsonl')
    await link(allowed, alias)
    const excluded = await save(layout, {
      agent: 'codex',
      sessionId: 'codex-session',
      filePath: alias,
      excludePrefixes: [excludedDir]
    })
    expect(excluded).toMatchObject({ outcome: 'failed', code: 'excluded-path' })
    expect(openedPaths.paths).toEqual([])
    expect(await readFile(outside, 'utf8')).toContain('SECRET_OUTSIDE')
    const forged = resolveListedSnapshotTarget(
      {
        agent: 'codex',
        sessionId: 'forged',
        executionHostId: 'local',
        filePath: outside
      },
      []
    )
    expect(forged).toMatchObject({ outcome: 'failed', code: 'unknown-session' })
    expect(openedPaths.paths).toEqual([])
  })

  it('keeps a successful snapshot when a later copy fails, and does not publish a partial log', async () => {
    const layout = await createLayout()
    const claude = await writeLog(layout.claudeRoot, 'claude-session.jsonl', claudeLog())
    const saved = await save(layout, {
      agent: 'claude',
      sessionId: 'claude-session',
      filePath: claude
    })
    expect(saved.outcome).toBe('saved')
    if (saved.outcome === 'failed') {
      return
    }
    const before = await readFile(saved.snapshot.archivePath)
    await writeFile(claude, `${claudeLog()}{"type":"user"`)
    const again = await save(layout, {
      agent: 'claude',
      sessionId: 'claude-session',
      filePath: claude
    })
    expect(again).toMatchObject({ outcome: 'already-saved' })
    expect(await readFile(saved.snapshot.archivePath)).toEqual(before)

    const codex = await writeLog(layout.codexRoot, 'codex-session.jsonl', codexLog())
    for (const hook of ['afterContentWrite', 'afterMetadataWrite', 'beforePublish'] as const) {
      const failed = await save(layout, {
        agent: 'codex',
        sessionId: 'codex-session',
        filePath: codex,
        hooks: {
          [hook]: () => {
            throw new Error(`disk full at ${hook}`)
          }
        }
      })
      expect(failed).toMatchObject({ outcome: 'failed', code: 'io' })
      expect(await readFile(saved.snapshot.archivePath)).toEqual(before)
      await expect(readdir(join(layout.archiveRoot, 'staging'))).resolves.toEqual([])
    }
    const half = await writeLog(layout.codexRoot, 'half.jsonl', `${codexLog()}{"type":"user"`)
    const halfSaved = await save(layout, {
      agent: 'codex',
      sessionId: 'codex-session',
      filePath: half,
      executionBoundary: 'other-host'
    })
    expect(halfSaved).toMatchObject({ outcome: 'failed', code: 'incomplete-record' })
    await expect(readdir(join(layout.archiveRoot, 'published'))).resolves.toHaveLength(1)

    const truncated = await writeLog(layout.codexRoot, 'live.jsonl', codexLog())
    const changed = await save(layout, {
      agent: 'codex',
      sessionId: 'codex-session',
      filePath: truncated,
      executionHostId: 'ssh:other',
      hooks: {
        onSourceReady: () => {
          truncateSync(truncated, 4)
        }
      }
    })
    expect(changed).toMatchObject({ outcome: 'failed', code: 'source-changed' })
    expect(await readFile(saved.snapshot.archivePath)).toEqual(before)
    await expect(readdir(join(layout.archiveRoot, 'published'))).resolves.toHaveLength(1)
    await expect(readdir(join(layout.archiveRoot, 'staging'))).resolves.toEqual([])

    const [first, second] = await Promise.all([
      save(layout, {
        agent: 'codex',
        sessionId: 'codex-session',
        filePath: codex,
        executionHostId: 'local'
      }),
      save(layout, {
        agent: 'codex',
        sessionId: 'codex-session',
        filePath: codex,
        executionHostId: 'local'
      })
    ])
    expect([first.outcome, second.outcome].sort()).toEqual(['already-saved', 'saved'])
    const hostA = await save(layout, {
      agent: 'codex',
      sessionId: 'codex-session',
      filePath: codex,
      executionHostId: 'local',
      sourceNamespace: layout.codexRoot
    })
    const otherRoot = join(layout.root, 'other-codex')
    await mkdir(otherRoot, { recursive: true })
    const otherFile = await writeLog(
      otherRoot,
      'codex-session.jsonl',
      codexLog('OTHER_CODEX_MARKER')
    )
    const hostB = await save(layout, {
      agent: 'codex',
      sessionId: 'codex-session',
      filePath: otherFile,
      executionHostId: 'ssh:other',
      sourceNamespace: otherRoot
    })
    expect(hostA.outcome === 'failed' ? '' : hostA.snapshot.archiveId).not.toBe(
      hostB.outcome === 'failed' ? '' : hostB.snapshot.archiveId
    )
    if (hostB.outcome !== 'failed') {
      expect(await readFile(hostB.snapshot.archivePath, 'utf8')).toContain('OTHER_CODEX_MARKER')
    }
    expect(await deleteSessionLogSnapshot(layout.archiveRoot, saved.snapshot.archiveId)).toEqual({
      outcome: 'deleted'
    })
    await expect(readFile(claude, 'utf8')).resolves.toContain('EARLY_CLAUDE_MARKER')
  })
})

async function createLayout(): Promise<{
  root: string
  archiveRoot: string
  claudeRoot: string
  codexRoot: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-snapshot-'))
  tempDirs.push(root)
  const claudeRoot = join(root, 'claude')
  const codexRoot = join(root, 'codex')
  await mkdir(claudeRoot, { recursive: true })
  await mkdir(codexRoot, { recursive: true })
  return { root, archiveRoot: join(root, 'ai-vault-archive'), claudeRoot, codexRoot }
}

function save(
  layout: { archiveRoot: string; claudeRoot: string; codexRoot: string },
  args: Partial<SaveSessionLogSnapshotArgs> &
    Pick<SaveSessionLogSnapshotArgs, 'agent' | 'sessionId' | 'filePath'>
): ReturnType<typeof saveSessionLogSnapshot> {
  const sourceNamespace =
    args.sourceNamespace ?? (args.agent === 'claude' ? layout.claudeRoot : layout.codexRoot)
  return saveSessionLogSnapshot({
    executionHostId: 'local',
    executionBoundary: 'native',
    archiveRoot: layout.archiveRoot,
    sourceNamespace,
    ...args
  })
}

async function writeLog(dir: string, name: string, contents: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, contents)
  return path
}

function claudeLog(): string {
  const lines = [
    JSON.stringify({
      type: 'user',
      sessionId: 'claude-session',
      message: { role: 'user', content: 'EARLY_CLAUDE_MARKER' }
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'claude-session',
      message: { role: 'assistant', content: 'working' }
    }),
    JSON.stringify({
      type: 'user',
      sessionId: 'claude-session',
      message: { role: 'user', content: 'DEEP_CLAUDE_MARKER' }
    })
  ].join('\n')
  return `${lines}\n`
}

function codexLog(marker = 'DEEP_CODEX_MARKER'): string {
  const lines = [
    JSON.stringify({
      timestamp: '2026-07-21T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-session', cwd: '/repo', source: 'cli' }
    }),
    JSON.stringify({
      timestamp: '2026-07-21T10:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'EARLY_CODEX_MARKER' }
    }),
    JSON.stringify({
      timestamp: '2026-07-21T10:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: marker }
    })
  ].join('\n')
  return `${lines}\n`
}
