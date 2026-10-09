import { createHash } from 'node:crypto'
import { isAgentSessionId } from '../../shared/agent-session-record'
import type { ForeignSessionHarness } from '../../shared/foreign-session-import'

/** Stable Orca session id for one foreign log, so a second import hits the same row. */
export function foreignImportNativeSessionId(
  harness: ForeignSessionHarness,
  originalSessionId: string
): string {
  const sanitized = originalSessionId.replace(/[^A-Za-z0-9_-]/g, '_')
  const direct = `${harness}_import_${sanitized}`
  if (isAgentSessionId(direct)) {
    return direct
  }
  const digest = createHash('sha256')
    .update(`${harness}\0${originalSessionId}`)
    .digest('hex')
    .slice(0, 40)
  return `${harness}_import_${digest}`
}

/** Id stand-in when the log itself never named a session. Resume stays blocked. */
export function foreignImportPathSessionId(filePath: string): string {
  const digest = createHash('sha256').update(filePath).digest('hex').slice(0, 32)
  return `path_${digest}`
}
