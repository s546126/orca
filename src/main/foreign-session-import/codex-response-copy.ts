import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import { asRecord, extractString, timestampMs } from '../ai-vault/session-scanner-values'

// The live Codex decoder leaves these on wrapped response items so event_msg
// stays the visible copy. Import keeps them only when that copy is absent.
const KNOWN_MESSAGE_CONTENT_TYPES = new Set([
  'text',
  'Text',
  'input_text',
  'output_text',
  'image',
  'Image',
  'input_image',
  'local_image',
  'LocalImage',
  'skill'
])

export type DeferredCodexMessage = { at: number; message: NativeChatMessage }

export function mergeRecoveredMessages(
  messages: NativeChatMessage[],
  deferred: readonly DeferredCodexMessage[]
): void {
  const seen = new Set(
    messages.flatMap((message) => {
      const signature = textSignature(message)
      return signature ? [signature] : []
    })
  )
  for (let index = deferred.length - 1; index >= 0; index -= 1) {
    const item = deferred[index]
    if (!item) {
      continue
    }
    const signature = textSignature(item.message)
    if (signature && seen.has(signature)) {
      continue
    }
    messages.splice(item.at, 0, item.message)
    if (signature) {
      seen.add(signature)
    }
  }
}

function textSignature(message: NativeChatMessage): string | null {
  const text = message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text.trim()] : []))
    .filter((part) => part.length > 0)
    .join('\n')
  return text ? `${message.role}\0${text}` : null
}

export function recoverDroppedResponseMessage(
  record: Record<string, unknown>,
  id: string
): NativeChatMessage | null {
  if (record.type !== 'response_item') {
    return null
  }
  const payload = asRecord(record.payload)
  if (!payload || payload.type !== 'message') {
    return null
  }
  const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null
  if (!role) {
    return null
  }
  const decoded = responseTextBlocks(payload.content)
  const blocks = role === 'user' ? decoded.filter((block) => !isSkillContext(block)) : decoded
  if (blocks.length === 0) {
    return null
  }
  const parsed = timestampMs(record.timestamp)
  return {
    id,
    role,
    blocks,
    timestamp: Number.isFinite(parsed) ? parsed : null,
    source: 'transcript'
  }
}

function responseTextBlocks(content: unknown): NativeChatBlock[] {
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const value of content) {
    const item = asRecord(value)
    if (!item) {
      continue
    }
    const block = responseTextBlock(item)
    if (block) {
      blocks.push(block)
    }
  }
  return blocks
}

function responseTextBlock(item: Record<string, unknown>): NativeChatBlock | null {
  const type = item.type
  if (type === 'text' || type === 'Text' || type === 'input_text' || type === 'output_text') {
    const text = extractString(item.text)
    return text ? { type: 'text', text } : null
  }
  if (type === 'image' || type === 'Image' || type === 'input_image') {
    const url = extractString(item.image_url) ?? extractString(item.url)
    return url ? { type: 'image-ref', url } : null
  }
  if (type === 'local_image' || type === 'LocalImage') {
    const imagePath = extractString(item.path)
    return imagePath ? { type: 'image-ref', path: imagePath } : null
  }
  return null
}

function isSkillContext(block: NativeChatBlock): boolean {
  return block.type === 'text' && block.text.trimStart().slice(0, 7).toLowerCase() === '<skill>'
}

export function responseMessageHasUnknownContent(record: Record<string, unknown>): boolean {
  const payload = asRecord(record.payload)
  if (!payload || payload.type !== 'message' || !Array.isArray(payload.content)) {
    return false
  }
  return payload.content.some((item) => {
    const block = asRecord(item)
    const type = extractString(block?.type)
    return type === null || !KNOWN_MESSAGE_CONTENT_TYPES.has(type)
  })
}
