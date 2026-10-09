import { asRecord, extractString } from '../ai-vault/session-scanner-values'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type {
  ForeignSessionHarness,
  ForeignSessionImportStamp,
  ForeignSessionProvenance,
  ForeignSessionResume,
  ForeignSessionResumeBlocker
} from '../../shared/foreign-session-import'

const KEY_PREFIX = 'foreign-session-import/'

export type ForeignSessionCatalogEntry = ForeignSessionImportStamp & {
  title: string
  cwd: string | null
  model: string | null
  messageCount: number
  workspaceId: string | null
}

export function readForeignSessionCatalog(
  database: JournalHostDatabase
): ForeignSessionCatalogEntry[] {
  const rows = database.db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key LIKE ?')
    .all(`${KEY_PREFIX}%`)
  const entries: ForeignSessionCatalogEntry[] = []
  for (const row of rows) {
    if (typeof row.value !== 'string') {
      continue
    }
    const parsed = parseCatalogEntry(row.value)
    if (parsed) {
      entries.push(parsed)
    }
  }
  return entries
}

export function readForeignSessionCatalogEntry(
  database: JournalHostDatabase,
  nativeSessionId: string
): ForeignSessionCatalogEntry | null {
  const row = database.db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key = ?')
    .get(catalogKey(nativeSessionId))
  return row && typeof row.value === 'string' ? parseCatalogEntry(row.value) : null
}

export function writeForeignSessionCatalogEntry(
  database: JournalHostDatabase,
  entry: ForeignSessionCatalogEntry
): void {
  const payload = JSON.stringify(entry)
  database.transaction((db) => {
    db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
      catalogKey(entry.nativeSessionId),
      payload
    )
  })
}

function catalogKey(nativeSessionId: string): string {
  return `${KEY_PREFIX}${nativeSessionId}`
}

function parseCatalogEntry(value: string): ForeignSessionCatalogEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  const entry = asRecord(parsed)
  const nativeSessionId = extractString(entry?.nativeSessionId)
  const title = extractString(entry?.title)
  const provenance = parseProvenance(entry?.provenance)
  const resume = parseResume(entry?.resume)
  if (!entry || !nativeSessionId || !provenance || !resume || !title) {
    return null
  }
  if (typeof entry.messageCount !== 'number') {
    return null
  }
  return {
    nativeSessionId,
    provenance,
    resume,
    title,
    cwd: extractString(entry.cwd),
    model: extractString(entry.model),
    messageCount: entry.messageCount,
    workspaceId: extractString(entry.workspaceId),
    ...(isForeignSessionResumeBlocker(entry.resumeBlocker)
      ? { resumeBlocker: entry.resumeBlocker }
      : {})
  }
}

function parseProvenance(value: unknown): ForeignSessionProvenance | null {
  const provenance = asRecord(value)
  const originalPath = extractString(provenance?.originalPath)
  const originalSessionId = extractString(provenance?.originalSessionId)
  const importedAt = extractString(provenance?.importedAt)
  const sourceHarness = provenance?.sourceHarness
  if (
    (sourceHarness !== 'codex' && sourceHarness !== 'pi') ||
    !originalPath ||
    !originalSessionId ||
    !importedAt
  ) {
    return null
  }
  return { sourceHarness, originalPath, originalSessionId, importedAt }
}

function parseResume(value: unknown): ForeignSessionResume | null {
  const resume = asRecord(value)
  if (resume?.mode === 'resumable') {
    return { mode: 'resumable' }
  }
  const reason = extractString(resume?.reason)
  if (resume?.mode === 'read-only' && reason) {
    return { mode: 'read-only', reason }
  }
  return null
}

export function catalogMatchesSession(
  entry: ForeignSessionCatalogEntry,
  session: { agent: string; sessionId: string; filePath: string }
): boolean {
  const harness: ForeignSessionHarness | null =
    session.agent === 'codex' || session.agent === 'pi' ? session.agent : null
  if (!harness || entry.provenance.sourceHarness !== harness) {
    return false
  }
  return (
    entry.provenance.originalSessionId === session.sessionId ||
    entry.provenance.originalPath === session.filePath
  )
}

export function isForeignSessionResumeBlocker(
  value: unknown
): value is ForeignSessionResumeBlocker {
  return (
    value === 'missing-session-id' ||
    value === 'mapping-gap' ||
    value === 'missing-workspace' ||
    value === 'missing-codex-home'
  )
}
