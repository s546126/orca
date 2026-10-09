// A foreign coding-agent log brought into Orca's own session store.
//
// The messages live in the chat journal. This stamp is how a reader tells which
// harness they came from and whether that chat can be continued.

export const FOREIGN_SESSION_HARNESSES = ['codex', 'pi'] as const
export type ForeignSessionHarness = (typeof FOREIGN_SESSION_HARNESSES)[number]

export type ForeignSessionProvenance = {
  sourceHarness: ForeignSessionHarness
  originalPath: string
  originalSessionId: string
  importedAt: string
}

export type ForeignSessionResume = { mode: 'resumable' } | { mode: 'read-only'; reason: string }

/** Why a clean-looking log still cannot be continued. Absent when it can. */
export type ForeignSessionResumeBlocker =
  | 'missing-session-id'
  | 'mapping-gap'
  | 'missing-workspace'
  | 'missing-codex-home'

export type ForeignSessionImportStamp = {
  nativeSessionId: string
  provenance: ForeignSessionProvenance
  resume: ForeignSessionResume
  /** Set when resume is blocked for a reason a later import can clear. */
  resumeBlocker?: ForeignSessionResumeBlocker
}

export type ForeignSessionImportEntry = {
  outcome: 'imported' | 'duplicate' | 'updated' | 'skipped' | 'failed'
  nativeSessionId: string | null
  originalPath: string
  originalSessionId: string | null
  title: string | null
  resume: ForeignSessionResume | null
  message: string
}

export type ForeignSessionImportResult = {
  harness: ForeignSessionHarness
  truncated: boolean
  entries: ForeignSessionImportEntry[]
}

export function isForeignSessionHarness(value: unknown): value is ForeignSessionHarness {
  return value === 'codex' || value === 'pi'
}

export function decideForeignSessionResume(input: {
  harness: ForeignSessionHarness
  hasSessionId: boolean
  gaps: readonly string[]
  workspaceId: string | null
  codexHome: string | null
  cwd: string | null
}): { resume: ForeignSessionResume; blocker: ForeignSessionResumeBlocker | null } {
  if (!input.hasSessionId) {
    return {
      blocker: 'missing-session-id',
      resume: {
        mode: 'read-only',
        reason: 'This log has no session id, so Orca cannot continue it.'
      }
    }
  }
  if (input.gaps.length > 0) {
    const summary = input.gaps.slice(0, 3).join(', ')
    return {
      blocker: 'mapping-gap',
      resume: {
        mode: 'read-only',
        reason: `Orca could not map every tool or message in this log (${summary}), so it was saved as history only.`
      }
    }
  }
  if (input.harness === 'codex' && !input.codexHome) {
    return {
      blocker: 'missing-codex-home',
      resume: {
        mode: 'read-only',
        reason:
          'Orca could not find the Codex home that holds this thread, so it cannot continue it.'
      }
    }
  }
  if (input.harness === 'codex' && !input.workspaceId) {
    const where = input.cwd ? ` (${input.cwd})` : ''
    return {
      blocker: 'missing-workspace',
      resume: {
        mode: 'read-only',
        reason: `This Codex thread can be continued in Orca after you import it again with the workspace that owns its folder${where}.`
      }
    }
  }
  return { blocker: null, resume: { mode: 'resumable' } }
}
