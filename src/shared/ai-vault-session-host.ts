import type { AiVaultSession, AiVaultSessionHost } from './ai-vault-types'
import { isWslUncPath } from './wsl-paths'

export function deriveAiVaultSessionHost(
  session: Pick<AiVaultSession, 'cwd' | 'filePath'>
): AiVaultSessionHost {
  if (isWslSessionPath(session.cwd) || isWslSessionPath(session.filePath)) {
    return 'wsl'
  }
  return 'local'
}

function isWslSessionPath(pathValue: string | null): boolean {
  if (!pathValue) {
    return false
  }
  return isWslUncPath(pathValue)
}
