import { app } from 'electron'
import { join } from 'node:path'
import { AI_VAULT_ARCHIVE_DIR_NAME } from '../../shared/ai-vault-session-snapshot'

export function historyArchiveRoot(): string | null {
  try {
    const userData = app.getPath('userData')
    return userData ? join(userData, AI_VAULT_ARCHIVE_DIR_NAME) : null
  } catch {
    return null
  }
}
