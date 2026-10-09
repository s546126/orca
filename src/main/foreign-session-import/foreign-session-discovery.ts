import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ForeignSessionHarness } from '../../shared/foreign-session-import'
import type { ForeignSessionSource } from './foreign-session-connector'
import { FOREIGN_SESSION_IMPORT_MAX_FILES } from './foreign-session-parse-limits'

const MAX_WALK_DEPTH = 6
const MAX_WALK_ENTRIES = 4_000

/** Jsonl logs under the paths the user named, or under the harness default roots. */
export async function discoverForeignSessionFiles(input: {
  harness: ForeignSessionHarness
  paths: readonly string[]
  defaultRoots: readonly string[]
}): Promise<{ files: ForeignSessionSource[]; truncated: boolean }> {
  const roots = input.paths.length > 0 ? input.paths : input.defaultRoots
  const files: ForeignSessionSource[] = []
  let seen = 0
  let truncated = false
  for (const root of roots) {
    const resolved = path.resolve(root)
    const found = await collectJsonl(resolved, 0, input.harness, files, () => {
      seen += 1
      return seen > MAX_WALK_ENTRIES || files.length >= FOREIGN_SESSION_IMPORT_MAX_FILES
    })
    if (found === 'truncated') {
      truncated = true
      break
    }
  }
  return { files, truncated }
}

async function collectJsonl(
  target: string,
  depth: number,
  harness: ForeignSessionHarness,
  files: ForeignSessionSource[],
  overLimit: () => boolean
): Promise<'ok' | 'truncated'> {
  if (overLimit()) {
    return 'truncated'
  }
  let info
  try {
    info = await stat(target)
  } catch {
    return 'ok'
  }
  if (info.isFile()) {
    if (target.endsWith('.jsonl')) {
      files.push({ harness, filePath: target })
    }
    return overLimit() ? 'truncated' : 'ok'
  }
  if (!info.isDirectory() || depth > MAX_WALK_DEPTH) {
    return 'ok'
  }
  const entries = await readdir(target, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue
    }
    const next = path.join(target, entry.name)
    const result = await collectJsonl(
      next,
      entry.isDirectory() ? depth + 1 : depth,
      harness,
      files,
      overLimit
    )
    if (result === 'truncated') {
      return 'truncated'
    }
  }
  return 'ok'
}
