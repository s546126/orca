import type { NativeChatMessage } from '../../shared/native-chat-types'
import type { ForeignSessionHarness } from '../../shared/foreign-session-import'

/** One harness's on-disk logs. New harnesses add a connector; they do not add a store. */
export type ForeignSessionConnector = {
  harness: ForeignSessionHarness
  defaultRoots(env?: NodeJS.ProcessEnv, home?: string): string[]
  parse(filePath: string, text: string): ParsedForeignSession
}

export type ParsedForeignSession = {
  harness: ForeignSessionHarness
  /** False when the id was invented from the path because the log never named one. */
  hasSessionId: boolean
  originalSessionId: string
  originalPath: string
  cwd: string | null
  model: string | null
  title: string
  messages: NativeChatMessage[]
  /** Mapping holes that make continuing the session unsafe. */
  gaps: string[]
  /** Parent of the `sessions` directory, when the file lives under a Codex home. */
  codexHome: string | null
}

export type ForeignSessionSource = {
  harness: ForeignSessionHarness
  filePath: string
}
