import { createReadStream } from 'node:fs'

export const AI_VAULT_SESSION_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024

export type AiVaultTranscriptLine = {
  text: string
  byteOffset: number
  lineNumber: number
}

// Why: readline strips CR, so `${line}\n` under-counts CRLF by one byte per line.
export async function* iterateAiVaultTranscriptLines(
  filePath: string
): AsyncGenerator<AiVaultTranscriptLine> {
  const input = createReadStream(filePath)
  try {
    let pending = Buffer.alloc(0)
    let pendingFileStart = 0
    let consumed = 0
    let lineNumber = 0
    for await (const chunk of input) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      consumed += incoming.length
      const data = pending.length === 0 ? incoming : Buffer.concat([pending, incoming])
      let start = 0
      for (let index = 0; index < data.length; index += 1) {
        const code = data[index]
        if (code !== 0x0a && code !== 0x0d) {
          continue
        }
        if (code === 0x0d && index + 1 === data.length) {
          break
        }
        const terminator = code === 0x0d && data[index + 1] === 0x0a ? 2 : 1
        lineNumber += 1
        yield {
          text: data.subarray(start, index).toString('utf8'),
          byteOffset: pendingFileStart + start,
          lineNumber
        }
        index += terminator - 1
        start = index + 1
      }
      pending = data.subarray(start)
      pendingFileStart += start
      if (consumed >= AI_VAULT_SESSION_TRANSCRIPT_MAX_BYTES) {
        break
      }
    }
    if (pending.length > 0) {
      const text =
        pending[pending.length - 1] === 0x0d ? pending.subarray(0, pending.length - 1) : pending
      if (text.length > 0) {
        lineNumber += 1
        yield {
          text: text.toString('utf8'),
          byteOffset: pendingFileStart,
          lineNumber
        }
      }
    }
  } finally {
    input.destroy()
  }
}
