import { readFile, stat } from 'node:fs/promises'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  decideForeignSessionResume,
  type ForeignSessionHarness,
  type ForeignSessionImportEntry,
  type ForeignSessionImportResult,
  type ForeignSessionResume,
  type ForeignSessionResumeBlocker
} from '../../shared/foreign-session-import'
import { WORKTREE_ID_SEPARATOR } from '../../shared/pty-session-id-format'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import {
  buildImportedCodexRecord,
  findImportedCodexThreadOwner
} from '../runtime/agent-session-imported-codex-record'
import { codexForeignSessionConnector } from './codex-foreign-session-connector'
import { discoverForeignSessionFiles } from './foreign-session-discovery'
import type { ParsedForeignSession } from './foreign-session-connector'
import {
  readForeignSessionCatalogEntry,
  writeForeignSessionCatalogEntry,
  type ForeignSessionCatalogEntry
} from './foreign-session-import-catalog'
import { foreignMessagesToJournalItems } from './foreign-session-journal-items'
import { foreignImportNativeSessionId } from './foreign-session-native-id'
import { FOREIGN_SESSION_IMPORT_SOURCE_BYTES } from './foreign-session-parse-limits'
import { piForeignSessionConnector } from './pi-foreign-session-connector'

const CONNECTORS = {
  codex: codexForeignSessionConnector,
  pi: piForeignSessionConnector
} as const

export type ForeignSessionImportRequest = {
  harness: ForeignSessionHarness
  paths?: readonly string[]
  sessionIds?: readonly string[]
  workspaceId?: string | null
  workspaceKind?: 'git-worktree' | 'folder' | null
}

export type ForeignSessionImportDeps = {
  database: JournalHostDatabase
  store: AgentSessionRecordStore
  claimKeyId: string
  hostId?: string
  now?: () => number
  env?: NodeJS.ProcessEnv
  home?: string
}

export type { ForeignSessionImportEntry, ForeignSessionImportResult }

export async function importForeignSessions(
  deps: ForeignSessionImportDeps,
  request: ForeignSessionImportRequest
): Promise<ForeignSessionImportResult> {
  const connector = CONNECTORS[request.harness]
  const discovered = await discoverForeignSessionFiles({
    harness: request.harness,
    paths: request.paths ?? [],
    defaultRoots: connector.defaultRoots(deps.env, deps.home)
  })
  const wanted = new Set(request.sessionIds ?? [])
  const entries: ForeignSessionImportEntry[] = []
  for (const source of discovered.files) {
    entries.push(await importOne(deps, request, source.filePath, wanted))
  }
  return {
    harness: request.harness,
    truncated: discovered.truncated,
    entries: entries.filter((entry) => entry.outcome !== 'skipped' || entry.message !== 'filtered')
  }
}

async function importOne(
  deps: ForeignSessionImportDeps,
  request: ForeignSessionImportRequest,
  filePath: string,
  wanted: ReadonlySet<string>
): Promise<ForeignSessionImportEntry> {
  try {
    const size = (await stat(filePath)).size
    if (size > FOREIGN_SESSION_IMPORT_SOURCE_BYTES) {
      return failed(filePath, 'This log is larger than Orca will import in one pass.')
    }
    const parsed = CONNECTORS[request.harness].parse(filePath, await readFile(filePath, 'utf8'))
    if (wanted.size > 0 && !wanted.has(parsed.originalSessionId)) {
      return skipped(filePath, parsed, 'filtered')
    }
    return await commitParsed(deps, request, parsed)
  } catch (error) {
    return failed(filePath, error instanceof Error ? error.message : String(error))
  }
}

async function commitParsed(
  deps: ForeignSessionImportDeps,
  request: ForeignSessionImportRequest,
  parsed: ParsedForeignSession
): Promise<ForeignSessionImportEntry> {
  const nativeSessionId = foreignImportNativeSessionId(parsed.harness, parsed.originalSessionId)
  const workspaceId = request.workspaceId?.trim() || null
  const decision = resumeFor(parsed, workspaceId)
  const existing = readForeignSessionCatalogEntry(deps.database, nativeSessionId)
  if (existing && !canUpgrade(existing, decision.blocker)) {
    return {
      outcome: 'duplicate',
      nativeSessionId,
      originalPath: parsed.originalPath,
      originalSessionId: parsed.originalSessionId,
      title: existing.title,
      resume: existing.resume,
      message: `Already imported as ${nativeSessionId}.`
    }
  }
  if (parsed.harness === 'codex' && parsed.hasSessionId) {
    const owner = findImportedCodexThreadOwner(deps.store.listRecords(), parsed.originalSessionId)
    if (owner && owner !== nativeSessionId) {
      return skipped(
        parsed.originalPath,
        parsed,
        `This Codex thread is already Orca session ${owner}.`
      )
    }
  }
  const journalWorkspace = workspaceId ?? 'foreign-import'
  await writeJournal(deps, parsed, nativeSessionId, journalWorkspace)
  if (
    decision.resume.mode === 'resumable' &&
    parsed.harness === 'codex' &&
    workspaceId &&
    parsed.codexHome
  ) {
    const adopted = await deps.store.adoptImportedCodexRecord(
      buildImportedCodexRecord({
        nativeSessionId,
        threadId: parsed.originalSessionId,
        workspaceId,
        workspaceKind: workspaceKindFor(workspaceId, request.workspaceKind ?? null),
        codexHome: parsed.codexHome,
        claimKeyId: deps.claimKeyId,
        title: parsed.title,
        now: deps.now?.() ?? Date.now()
      })
    )
    if (adopted.status === 'held') {
      return skipped(
        parsed.originalPath,
        parsed,
        `This Codex thread is already Orca session ${adopted.sessionId}.`
      )
    }
  }
  const now = new Date(deps.now?.() ?? Date.now()).toISOString()
  const entry: ForeignSessionCatalogEntry = {
    nativeSessionId,
    provenance: {
      sourceHarness: parsed.harness,
      originalPath: parsed.originalPath,
      originalSessionId: parsed.originalSessionId,
      importedAt: existing?.provenance.importedAt ?? now
    },
    resume: decision.resume,
    ...(decision.blocker ? { resumeBlocker: decision.blocker } : {}),
    title: parsed.title,
    cwd: parsed.cwd,
    model: parsed.model,
    messageCount: parsed.messages.length,
    workspaceId
  }
  writeForeignSessionCatalogEntry(deps.database, entry)
  const updated = existing !== null
  return {
    outcome: updated ? 'updated' : 'imported',
    nativeSessionId,
    originalPath: parsed.originalPath,
    originalSessionId: parsed.originalSessionId,
    title: parsed.title,
    resume: decision.resume,
    message: updated
      ? `Attached this Codex thread to workspace ${workspaceId ?? ''}.`
      : `Imported ${parsed.messages.length} messages.`
  }
}

function resumeFor(
  parsed: ParsedForeignSession,
  workspaceId: string | null
): { resume: ForeignSessionResume; blocker: ForeignSessionResumeBlocker | null } {
  if (parsed.messages.length === 0) {
    return {
      blocker: 'mapping-gap',
      resume: {
        mode: 'read-only',
        reason: 'This log has no messages, so there is nothing to continue.'
      }
    }
  }
  return decideForeignSessionResume({
    harness: parsed.harness,
    hasSessionId: parsed.hasSessionId,
    gaps: parsed.gaps,
    workspaceId,
    codexHome: parsed.codexHome,
    cwd: parsed.cwd
  })
}

function canUpgrade(
  existing: ForeignSessionCatalogEntry,
  blocker: ForeignSessionResumeBlocker | null
): boolean {
  return existing.resumeBlocker === 'missing-workspace' && blocker === null
}

async function writeJournal(
  deps: ForeignSessionImportDeps,
  parsed: ParsedForeignSession,
  nativeSessionId: string,
  workspaceId: string
): Promise<void> {
  const identity: AgentSessionJournalIdentity = {
    sessionId: nativeSessionId,
    workspaceId,
    hostId: deps.hostId ?? LOCAL_EXECUTION_HOST_ID,
    agent: parsed.harness,
    providerHandle:
      parsed.harness === 'codex'
        ? { kind: 'codex', threadId: parsed.originalSessionId }
        : { kind: 'opaque', agent: 'pi', value: parsed.originalSessionId }
  }
  const journal = await openAgentSessionJournal({
    identity,
    database: deps.database,
    ...(deps.now ? { now: deps.now } : {})
  })
  const items = foreignMessagesToJournalItems({
    harness: parsed.harness,
    nativeSessionId,
    messages: parsed.messages
  })
  if (items.length > 0) {
    await journal.replaceEpochItems('legacy_import', 1, items)
  }
}

function workspaceKindFor(
  workspaceId: string,
  explicit: 'git-worktree' | 'folder' | null
): 'git-worktree' | 'folder' {
  if (explicit) {
    return explicit
  }
  return workspaceId.includes(WORKTREE_ID_SEPARATOR) ? 'git-worktree' : 'folder'
}

function failed(filePath: string, message: string): ForeignSessionImportEntry {
  return {
    outcome: 'failed',
    nativeSessionId: null,
    originalPath: filePath,
    originalSessionId: null,
    title: null,
    resume: null,
    message
  }
}

function skipped(
  filePath: string,
  parsed: ParsedForeignSession,
  message: string
): ForeignSessionImportEntry {
  return {
    outcome: 'skipped',
    nativeSessionId: null,
    originalPath: filePath,
    originalSessionId: parsed.originalSessionId,
    title: parsed.title,
    resume: null,
    message
  }
}
