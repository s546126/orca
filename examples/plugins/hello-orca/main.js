// Sample Orca plugin entry. Runs inside the out-of-process plugin host
// (plain Node, no Electron). The default export receives the `orca` API and
// registers implementations for the extension points declared in the manifest.
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const SCAN_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.md'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build'])
const MAX_RESULTS = 200

async function collectFiles(dir, root, results) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(full, root, results)
    } else if (SCAN_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      results.push(full)
    }
  }
}

async function scanTodos(query, context) {
  const files = []
  await collectFiles(context.workspaceRoot, context.workspaceRoot, files)
  const symbols = []
  const needle = query.toLowerCase()
  for (const file of files) {
    if (symbols.length >= MAX_RESULTS) break
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/(?:TODO|FIXME)[:\s](.*)/)
      if (!match) continue
      const detail = match[1].trim()
      if (needle && !detail.toLowerCase().includes(needle)) continue
      symbols.push({
        name: detail.slice(0, 80) || 'TODO',
        kind: 'todo',
        file: relative(context.workspaceRoot, file),
        line: i + 1
      })
    }
  }
  return symbols
}

export default function activate(orca) {
  orca.registerCodeProvider({
    id: 'todo-scanner',
    searchSymbols: scanTodos
  })
}
