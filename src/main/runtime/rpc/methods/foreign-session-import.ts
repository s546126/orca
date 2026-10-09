import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { importForeignSessions } from '../../../foreign-session-import/import-foreign-sessions'
import { ForeignSessionImportParams } from '../../../../shared/rpc-contract/foreign-session-import-params'
import { defineMethod } from '../core'

export { ForeignSessionImportParams }

export const FOREIGN_SESSION_IMPORT_METHODS = [
  defineMethod({
    name: 'session.importForeign',
    params: ForeignSessionImportParams,
    handler: async (params, { runtime }) => {
      await runtime.ensureStructuredAgentSessionHost()
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw new Error('Orca could not open its session store.')
      }
      return importForeignSessions(
        {
          database: host.deps.journalDatabase,
          store: host.deps.store,
          claimKeyId: host.deps.claimKeyId
        },
        {
          harness: params.harness,
          paths: params.paths,
          sessionIds: params.sessionIds,
          workspaceId: params.workspaceId,
          workspaceKind: params.workspaceKind
        }
      )
    }
  })
]
