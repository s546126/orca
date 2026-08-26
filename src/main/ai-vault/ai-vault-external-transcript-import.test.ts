import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { importExternalAgentTranscripts } from './ai-vault-external-transcript-import'

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-ai-vault-import-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-ai-vault-import-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('importExternalAgentTranscripts', () => {
  it('links system Codex session files into the Orca-managed runtime home', async () => {
    const systemSessionPath = join(
      fakeHomeDir,
      '.codex',
      'sessions',
      '2026',
      '03',
      '28',
      'session-import.jsonl'
    )
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"type":"session_meta","payload":{"id":"session-import"}}\n')

    const summary = await importExternalAgentTranscripts()

    expect(summary.codexBridge).toEqual({ scannedFiles: 1, linkedFiles: 1 })
    expect(summary.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const runtimeSessionPath = join(
      userDataDir,
      'codex-runtime-home',
      'home',
      'sessions',
      '2026',
      '03',
      '28',
      'session-import.jsonl'
    )
    expect(existsSync(runtimeSessionPath)).toBe(true)
    expect(readFileSync(runtimeSessionPath, 'utf-8')).toContain('session-import')
  })

  it('returns zero counts when the system Codex sessions tree is absent', async () => {
    const summary = await importExternalAgentTranscripts()
    expect(summary.codexBridge).toEqual({ scannedFiles: 0, linkedFiles: 0 })
  })
})
