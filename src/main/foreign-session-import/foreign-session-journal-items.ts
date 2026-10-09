import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalToolCallState
} from '../../shared/agent-session-journal-types'
import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import type { JournalReplacementItem } from '../native-chat/agent-session-journal/journal-epoch-replacement'
import {
  boundInlineText,
  boundPayload,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  type JournalPayloadLimits
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { ForeignSessionHarness } from '../../shared/foreign-session-import'

/** Foreign messages become the same journal items a structured chat already renders. */
export function foreignMessagesToJournalItems(input: {
  harness: ForeignSessionHarness
  nativeSessionId: string
  messages: readonly NativeChatMessage[]
  limits?: JournalPayloadLimits
}): JournalReplacementItem[] {
  const limits = input.limits ?? DEFAULT_JOURNAL_PAYLOAD_LIMITS
  const answered = toolResultsByCallId(input.messages)
  const items: JournalReplacementItem[] = []
  for (const [index, message] of input.messages.entries()) {
    const only = message.blocks.length === 1 ? message.blocks[0] : undefined
    if (only?.type === 'tool-result') {
      if (only.callId && answered.has(only.callId)) {
        continue
      }
    }
    items.push({
      identity: identityFor(input.harness, input.nativeSessionId, message, index),
      body: itemBody(message, answered, limits),
      ...(message.timestamp !== null ? { observedAt: message.timestamp } : {})
    })
  }
  return items
}

function identityFor(
  harness: ForeignSessionHarness,
  nativeSessionId: string,
  message: NativeChatMessage,
  index: number
): AgentJournalItemIdentity {
  return {
    provider: 'legacy',
    agent: harness,
    sessionId: nativeSessionId,
    recordId: `${message.id || 'line'}-${index}`
  }
}

function itemBody(
  message: NativeChatMessage,
  answered: ReadonlyMap<string, NativeChatBlock & { type: 'tool-result' }>,
  limits: JournalPayloadLimits
): AgentJournalItemBody {
  const only = message.blocks.length === 1 ? message.blocks[0] : undefined
  if (only?.type === 'tool-call') {
    const result = only.callId ? answered.get(only.callId) : undefined
    const state: AgentJournalToolCallState = result
      ? result.isError
        ? 'failed'
        : 'completed'
      : 'running'
    return {
      kind: 'tool-call',
      name: only.name,
      input: boundToolInput(only.input, limits),
      ...(only.callId ? { callId: only.callId } : {}),
      state,
      ...(result ? { output: boundPayload(result.output, limits) } : {})
    }
  }
  if (only?.type === 'tool-result') {
    return {
      kind: 'tool-call',
      name: 'tool-result',
      input: null,
      state: only.isError ? 'failed' : 'completed',
      output: boundPayload(only.output, limits),
      ...(only.callId ? { callId: only.callId } : {})
    }
  }
  return {
    kind: 'message',
    role: message.role,
    blocks: message.blocks.map((block) => boundBlock(block, limits))
  }
}

function toolResultsByCallId(
  messages: readonly NativeChatMessage[]
): Map<string, NativeChatBlock & { type: 'tool-result' }> {
  const results = new Map<string, NativeChatBlock & { type: 'tool-result' }>()
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool-result' && block.callId) {
        results.set(block.callId, block)
      }
    }
  }
  return results
}

function boundBlock(block: NativeChatBlock, limits: JournalPayloadLimits): NativeChatBlock {
  if (block.type === 'text') {
    return { ...block, text: boundInlineText(block.text, limits).text }
  }
  if (block.type === 'tool-result') {
    return { ...block, output: boundInlineText(block.output, limits).text }
  }
  if (block.type === 'tool-call') {
    return { ...block, input: boundToolInput(block.input, limits) }
  }
  return block
}
