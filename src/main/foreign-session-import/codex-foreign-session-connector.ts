import { homedir } from 'node:os'
import path from 'node:path'
import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { decodeCodexTranscriptLine } from '../native-chat/transcript-line-decoders-codex'
import {
  mergeRecoveredMessages,
  recoverDroppedResponseMessage,
  responseMessageHasUnknownContent,
  type DeferredCodexMessage
} from './codex-response-copy'
import type { ForeignSessionConnector, ParsedForeignSession } from './foreign-session-connector'
import { foreignImportPathSessionId } from './foreign-session-native-id'
import { rememberGap, titleFromUserText } from './foreign-session-parse-limits'

const METADATA_EVENT_TYPES = new Set([
  'token_count',
  'task_started',
  'task_complete',
  'item_started',
  'rate_limits',
  'thread_name'
])

export function codexDefaultSessionRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string[] {
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, '.codex')
  return [path.join(codexHome, 'sessions')]
}

export function codexHomeFromSessionPath(filePath: string): string | null {
  let dir = path.dirname(filePath)
  const root = path.parse(filePath).root
  while (dir && dir !== root) {
    if (path.basename(dir) === 'sessions') {
      const home = path.dirname(dir)
      return home !== dir ? home : null
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return null
}

export const codexForeignSessionConnector: ForeignSessionConnector = {
  harness: 'codex',
  defaultRoots: codexDefaultSessionRoots,
  parse: parseCodexForeignSession
}

export function parseCodexForeignSession(filePath: string, text: string): ParsedForeignSession {
  const gaps: string[] = []
  const messages: NativeChatMessage[] = []
  let sessionId: string | null = null
  let cwd: string | null = null
  let model: string | null = null
  let paginated = false
  let sawUnreadable = false
  let index = 0
  const deferred: DeferredCodexMessage[] = []

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    const record = parseJsonObject(line)
    if (!record) {
      if (!sawUnreadable) {
        rememberGap(gaps, 'unreadable-line')
        sawUnreadable = true
      }
      continue
    }
    if (record.type === 'session_meta') {
      const payload = asRecord(record.payload)
      sessionId = extractString(payload?.id) ?? sessionId
      cwd = extractString(payload?.cwd) ?? cwd
      paginated = payload?.history_mode === 'paginated' || paginated
      continue
    }
    if (record.type === 'turn_context') {
      const payload = asRecord(record.payload)
      cwd = extractString(payload?.cwd) ?? cwd
      model = extractString(payload?.model) ?? model
      continue
    }
    if (paginated && record.type === 'response_item') {
      continue
    }
    const fallbackId = `codex-${index}`
    const decoded = decodeCodexTranscriptLine(line, fallbackId)
    index += 1
    if (decoded) {
      messages.push(attachCodexCallId(decoded, record))
      continue
    }
    const recovered = recoverDroppedResponseMessage(record, fallbackId)
    if (recovered) {
      deferred.push({ at: messages.length, message: recovered })
      if (!responseMessageHasUnknownContent(record)) {
        continue
      }
    }
    noteCodexSkip(record, gaps)
  }

  mergeRecoveredMessages(messages, deferred)

  const hasSessionId = sessionId !== null
  const originalSessionId = sessionId ?? foreignImportPathSessionId(filePath)
  return {
    harness: 'codex',
    hasSessionId,
    originalSessionId,
    originalPath: filePath,
    cwd,
    model,
    title: titleFromUserText(firstUserText(messages)),
    messages,
    gaps,
    codexHome: codexHomeFromSessionPath(filePath)
  }
}

function attachCodexCallId(
  message: NativeChatMessage,
  record: Record<string, unknown>
): NativeChatMessage {
  const payload = asRecord(record.payload) ?? record
  const callId = extractString(payload.call_id)
  if (!callId) {
    return message
  }
  return {
    ...message,
    blocks: message.blocks.map((block) =>
      block.type === 'tool-call' || block.type === 'tool-result' ? { ...block, callId } : block
    )
  }
}

function noteCodexSkip(record: Record<string, unknown>, gaps: string[]): void {
  if (record.type === 'event_msg') {
    const payload = asRecord(record.payload)
    const eventType = extractString(payload?.type)
    if (eventType && METADATA_EVENT_TYPES.has(eventType)) {
      return
    }
    if (eventType === 'item_completed' && !completedItemHadContent(payload)) {
      return
    }
    rememberGap(gaps, `unmapped-event:${eventType ?? 'event_msg'}`)
    return
  }
  if (record.type === 'response_item') {
    const payload = asRecord(record.payload)
    const itemType = extractString(payload?.type) ?? 'response_item'
    if (itemType === 'message' && ignorableCodexMessage(record)) {
      return
    }
    rememberGap(gaps, `unmapped-response:${itemType}`)
    return
  }
  if (typeof record.type === 'string' && record.type !== 'message') {
    rememberGap(gaps, `unmapped-event:${record.type}`)
  }
}

function completedItemHadContent(payload: Record<string, unknown> | null): boolean {
  const item = asRecord(payload?.item)
  return Array.isArray(item?.content) && item.content.length > 0
}

function ignorableCodexMessage(record: Record<string, unknown>): boolean {
  const payload = asRecord(record.payload)
  if (!payload) {
    return false
  }
  if (payload.role !== 'user' && payload.role !== 'assistant') {
    return true
  }
  if (emptyContent(payload.content)) {
    return true
  }
  return !responseMessageHasUnknownContent(record)
}

function emptyContent(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.trim().length === 0
  }
  return !Array.isArray(content) || content.length === 0
}

function firstUserText(messages: readonly NativeChatMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }
    const text = message.blocks.find(
      (block): block is NativeChatBlock & { type: 'text' } =>
        block.type === 'text' && block.text.trim().length > 0
    )
    if (text && text.type === 'text') {
      return text.text
    }
  }
  return null
}
