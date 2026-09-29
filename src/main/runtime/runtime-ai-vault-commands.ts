import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import { isAiVaultHistorySnapshotPath } from '../../shared/ai-vault-session-snapshot'
import { listAiVaultSessions } from '../ai-vault/cached-session-list'
import { mergeAiVaultHistorySnapshots } from '../ai-vault/session-log-snapshot-merge'
import { historyArchiveRoot } from '../ipc/ai-vault-history-archive-root'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'

export class RuntimeAiVaultCommands {
  constructor(
    private readonly getPrepareResume: () =>
      | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
      | null
  ) {}

  async list(args?: AiVaultListArgs): Promise<AiVaultListResult> {
    const result = await listAiVaultSessions(args)
    const archiveRoot = historyArchiveRoot()
    if (!archiveRoot) {
      return result
    }
    try {
      return await mergeAiVaultHistorySnapshots(result, archiveRoot)
    } catch (error) {
      console.warn('[ai-vault] Failed to read saved history snapshots:', error)
      return result
    }
  }

  resolveTitles(
    requests: AiVaultSessionTitleRequest[],
    signal?: AbortSignal
  ): Promise<AiVaultSessionTitlesResult> {
    return resolveLocalAiVaultSessionTitles(requests, signal)
  }

  prepare(args: AiVaultPrepareSessionResumeArgs): Promise<AiVaultPrepareSessionResumeResult> {
    if (isAiVaultHistorySnapshotPath(args.filePath)) {
      return Promise.reject(new Error('Saved history snapshots cannot be resumed.'))
    }
    return this.getPrepareResume()?.(args) ?? Promise.resolve({ useRealCodexHome: false })
  }
}
