import { getOptionalStringFlag, getRepeatedStringFlag, getRequiredStringFlag } from '../flags'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import {
  isForeignSessionHarness,
  type ForeignSessionImportResult
} from '../../shared/foreign-session-import'

export const SESSION_IMPORT_HANDLERS: Record<string, CommandHandler> = {
  'session import': async ({ client, flags, json }) => {
    const harness = getRequiredStringFlag(flags, 'harness')
    if (!isForeignSessionHarness(harness)) {
      throw new RuntimeClientError('invalid_argument', '--harness must be codex or pi')
    }
    const workspaceKind = getOptionalStringFlag(flags, 'workspace-kind')
    if (
      workspaceKind !== undefined &&
      workspaceKind !== 'git-worktree' &&
      workspaceKind !== 'folder'
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--workspace-kind must be git-worktree or folder'
      )
    }
    const paths = getRepeatedStringFlag(flags, 'path')
    const sessionIds = getRepeatedStringFlag(flags, 'session')
    const workspaceId = getOptionalStringFlag(flags, 'workspace')
    const envelope = await client.call<ForeignSessionImportResult>('session.importForeign', {
      harness,
      ...(paths.length > 0 ? { paths } : {}),
      ...(sessionIds.length > 0 ? { sessionIds } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceKind ? { workspaceKind } : {})
    })
    printResult(envelope, json, formatForeignSessionImport)
  }
}

function formatForeignSessionImport(result: ForeignSessionImportResult): string {
  if (result.entries.length === 0) {
    return result.truncated
      ? 'No matching session logs, and the search stopped early. Pass --path or --session to narrow it.'
      : `No ${result.harness} session logs were found.`
  }
  const lines = result.entries.map((entry) => {
    const name = entry.title ?? entry.originalSessionId ?? entry.originalPath
    const resume =
      entry.resume?.mode === 'read-only'
        ? `read-only: ${entry.resume.reason}`
        : entry.resume?.mode === 'resumable'
          ? 'can be continued'
          : entry.message
    return `${entry.outcome}  ${name}  ${resume}`
  })
  if (result.truncated) {
    lines.push('Stopped early. Pass --path or --session to import a smaller set.')
  }
  return lines.join('\n')
}
