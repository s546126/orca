import { agentSessionProviderHandleRoot } from '../../shared/agent-session-provider-handle'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import { normalizeAgentSessionConversationName } from '../../shared/agent-session-conversation-name'
import type { AgentSessionStoreState } from './agent-session-record-store-file'

export type ImportedCodexRecordInput = {
  nativeSessionId: string
  threadId: string
  workspaceId: string
  workspaceKind: 'git-worktree' | 'folder'
  codexHome: string
  claimKeyId: string
  title: string
  now: number
}

export type ImportedCodexAdoptResult =
  | { status: 'created' }
  | { status: 'exists' }
  | { status: 'held'; sessionId: string }

/** A released Codex record whose thread Orca can resume. No process is started. */
export function buildImportedCodexRecord(input: ImportedCodexRecordInput): AgentSessionRecord {
  const conversationName = normalizeAgentSessionConversationName(input.title)
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: input.nativeSessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: input.workspaceId,
      workspaceKind: input.workspaceKind
    },
    provider: 'codex',
    providerHandleChain: [
      {
        linkId: input.nativeSessionId,
        handle: { provider: 'codex', threadId: input.threadId },
        origin: 'adopted',
        mintedAtFence: 1,
        observedAt: input.now
      }
    ],
    accountHome: { variable: 'CODEX_HOME', path: input.codexHome },
    ...(conversationName ? { conversationName } : {}),
    lease: {
      sessionId: input.nativeSessionId,
      runtimeKind: 'native',
      runtimeFence: 1,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: input.now,
      lastRenewedAt: input.now,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: input.claimKeyId,
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: input.now,
    updatedAt: input.now
  }
}

export function commitImportedCodexRecord(
  draft: AgentSessionStoreState,
  record: AgentSessionRecord
): ImportedCodexAdoptResult {
  const existing = draft.records.get(record.sessionId)
  if (existing) {
    return { status: 'exists' }
  }
  const head = record.providerHandleChain.at(-1)
  if (!head || head.handle.provider !== 'codex') {
    return { status: 'exists' }
  }
  const root = agentSessionProviderHandleRoot(head.handle)
  for (const other of draft.records.values()) {
    const holds = other.providerHandleChain.some(
      (link) => agentSessionProviderHandleRoot(link.handle) === root
    )
    if (holds) {
      return { status: 'held', sessionId: other.sessionId }
    }
  }
  draft.records.set(record.sessionId, record)
  return { status: 'created' }
}

export function findImportedCodexThreadOwner(
  records: readonly AgentSessionRecord[],
  threadId: string
): string | null {
  const root = agentSessionProviderHandleRoot({ provider: 'codex', threadId })
  for (const record of records) {
    const holds = record.providerHandleChain.some(
      (link) => agentSessionProviderHandleRoot(link.handle) === root
    )
    if (holds) {
      return record.sessionId
    }
  }
  return null
}
