import { homedir } from 'node:os'
import path from 'node:path'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatRole
} from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import type { ForeignSessionConnector, ParsedForeignSession } from './foreign-session-connector'
import { foreignImportPathSessionId } from './foreign-session-native-id'
import { rememberGap, titleFromUserText } from './foreign-session-parse-limits'

const IGNORED_EVENT_TYPES = new Set([
  'session',
  'session_start',
  'model_change',
  'model_select',
  'custom',
  'compaction',
  'session_info',
  'label',
  'branch'
])

export function piDefaultSessionRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string[] {
  const override = env.PI_CODING_AGENT_DIR?.trim()
  return [override || path.join(home, '.pi', 'agent', 'sessions')]
}

export const piForeignSessionConnector: ForeignSessionConnector = {
  harness: 'pi',
  defaultRoots: piDefaultSessionRoots,
  parse: parsePiForeignSession
}

export function parsePiForeignSession(filePath: string, text: string): ParsedForeignSession {
  const gaps: string[] = []
  const messages: NativeChatMessage[] = []
  let sessionId: string | null = null
  let cwd: string | null = null
  let model: string | null = null
  let sawUnreadable = false
  let index = 0

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
    const type = extractString(record.type)
    if (type === 'session' || type === 'session_start') {
      sessionId = extractString(record.id) ?? sessionId
      cwd = extractString(record.cwd) ?? cwd
      continue
    }
    if (type === 'model_change' || type === 'model_select') {
      model = extractString(record.modelId) ?? extractString(record.model) ?? model
      continue
    }
    if (type === 'thinking') {
      const thinking = thinkingText(record)
      if (thinking) {
        messages.push(
          message(`pi-${index}`, 'reasoning', [{ type: 'text', text: thinking }], record)
        )
      }
      index += 1
      continue
    }
    if (type === 'message') {
      model = extractString(asRecord(record.message)?.model) ?? model
      index = consumePiMessage(record, index, messages, gaps)
      continue
    }
    if (type && !IGNORED_EVENT_TYPES.has(type)) {
      rememberGap(gaps, `unmapped-event:${type}`)
    }
    index += 1
  }

  const hasSessionId = sessionId !== null
  const originalSessionId = sessionId ?? path.basename(filePath, '.jsonl')
  const resolvedId = originalSessionId.trim()
    ? originalSessionId
    : foreignImportPathSessionId(filePath)
  return {
    harness: 'pi',
    hasSessionId: hasSessionId && resolvedId === originalSessionId,
    originalSessionId: resolvedId,
    originalPath: filePath,
    cwd,
    model,
    title: titleFromUserText(firstUserText(messages)),
    messages,
    gaps,
    codexHome: null
  }
}

function consumePiMessage(
  record: Record<string, unknown>,
  index: number,
  messages: NativeChatMessage[],
  gaps: string[]
): number {
  const body = asRecord(record.message)
  if (!body) {
    rememberGap(gaps, 'unmapped-message')
    return index + 1
  }
  const role = piRole(extractString(body.role))
  if (!role) {
    rememberGap(gaps, `unmapped-role:${extractString(body.role) ?? 'unknown'}`)
    return index + 1
  }
  if (role === 'tool') {
    const tool = piToolResult(body, `pi-${index}`, record)
    if (tool) {
      messages.push(tool)
    }
    return index + 1
  }
  const parts = piContent(body.content, role, gaps)
  let cursor = index
  for (const part of parts) {
    messages.push(message(`pi-${cursor}`, part.role, part.blocks, record))
    cursor += 1
  }
  return Math.max(cursor, index + 1)
}

function piRole(role: string | null): NativeChatRole | null {
  if (role === 'user' || role === 'assistant' || role === 'system') {
    return role
  }
  if (role === 'tool' || role === 'toolResult' || role === 'tool_result') {
    return 'tool'
  }
  return null
}

type PiPart = { role: NativeChatRole; blocks: NativeChatBlock[] }

function piContent(content: unknown, role: NativeChatRole, gaps: string[]): PiPart[] {
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? [{ role, blocks: [{ type: 'text', text: content }] }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  const parts: PiPart[] = []
  let prose: NativeChatBlock[] = []
  const flush = (): void => {
    if (prose.length === 0) {
      return
    }
    parts.push({ role, blocks: prose })
    prose = []
  }
  for (const entry of content) {
    const block = asRecord(entry)
    if (!block) {
      continue
    }
    const type = extractString(block.type)
    if (type === 'thinking' || type === 'reasoning') {
      flush()
      const text = thinkingText(block)
      if (text) {
        parts.push({ role: 'reasoning', blocks: [{ type: 'text', text }] })
      }
      continue
    }
    if (
      type === 'toolCall' ||
      type === 'tool_use' ||
      type === 'functionCall' ||
      type === 'tool_call'
    ) {
      flush()
      const name = extractString(block.name) ?? 'tool'
      const callId = extractString(block.id) ?? extractString(block.toolCallId)
      parts.push({
        role: 'assistant',
        blocks: [
          {
            type: 'tool-call',
            name,
            input: block.arguments ?? block.input ?? null,
            ...(callId ? { callId } : {})
          }
        ]
      })
      continue
    }
    if (type === 'text' || type === 'input_text' || type === 'output_text' || type === null) {
      const text = extractString(block.text) ?? extractString(block.content)
      if (text) {
        prose.push({ type: 'text', text })
      }
      continue
    }
    rememberGap(gaps, `unmapped-block:${type}`)
  }
  flush()
  return parts
}

function piToolResult(
  body: Record<string, unknown>,
  id: string,
  record: Record<string, unknown>
): NativeChatMessage | null {
  const callId = extractString(body.toolCallId) ?? extractString(body.tool_call_id)
  const output = toolOutputText(body.content) ?? extractString(body.output) ?? ''
  if (!output && !callId) {
    return null
  }
  return message(
    id,
    'tool',
    [
      {
        type: 'tool-result',
        output,
        ...(body.isError === true ? { isError: true } : {}),
        ...(callId ? { callId } : {})
      }
    ],
    record
  )
}

function toolOutputText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }
  const parts: string[] = []
  for (const entry of content) {
    const block = asRecord(entry)
    const text = extractString(block?.text) ?? extractString(block?.content)
    if (text) {
      parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

function thinkingText(record: Record<string, unknown>): string | null {
  return (
    extractString(record.thinking) ??
    extractString(record.text) ??
    extractString(record.content) ??
    null
  )
}

function message(
  id: string,
  role: NativeChatRole,
  blocks: NativeChatBlock[],
  record: Record<string, unknown>
): NativeChatMessage {
  const timestamp = timestampMs(record.timestamp)
  return {
    id,
    role,
    blocks,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    source: 'transcript'
  }
}

function firstUserText(messages: readonly NativeChatMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }
    const text = message.blocks.find((block) => block.type === 'text' && block.text.trim())
    if (text && text.type === 'text') {
      return text.text
    }
  }
  return null
}
