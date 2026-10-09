import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { ForeignSessionImportStamp } from '../../shared/foreign-session-import'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { catalogMatchesSession, readForeignSessionCatalog } from './foreign-session-import-catalog'

/** Stamps session-history rows that were copied into Orca, including a read-only reason. */
export function projectForeignSessionImports(
  result: AiVaultListResult,
  database: JournalHostDatabase | null
): AiVaultListResult {
  if (!database) {
    return result
  }
  let catalog
  try {
    catalog = readForeignSessionCatalog(database)
  } catch {
    return result
  }
  if (catalog.length === 0) {
    return result
  }
  let changed = false
  const sessions = result.sessions.map((session) => {
    const entry = catalog.find((candidate) => catalogMatchesSession(candidate, session))
    if (!entry) {
      return session
    }
    const stamp: ForeignSessionImportStamp = {
      nativeSessionId: entry.nativeSessionId,
      provenance: entry.provenance,
      resume: entry.resume
    }
    changed = true
    return { ...session, foreignImport: stamp }
  })
  return changed ? { ...result, sessions } : result
}

export function foreignImportDisablesResume(
  session: Pick<AiVaultSession, 'foreignImport'>
): boolean {
  return session.foreignImport?.resume.mode === 'read-only'
}
