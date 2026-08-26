import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('scanAiVaultSessions claude transcripts discovery', () => {
  it('indexes Claude transcripts stored outside project folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-claude-transcripts-'))
    tempRoots.push(root)
    const transcriptsRoot = join(root, 'claude-transcripts')
    await mkdir(join(transcriptsRoot, 'legacy'), { recursive: true })

    await writeFile(
      join(transcriptsRoot, 'legacy', 'claude-transcript-session.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'claude-transcript-session',
          timestamp: '2026-05-02T10:00:00.000Z',
          cwd: '/repo/legacy',
          gitBranch: 'main',
          isMeta: false,
          message: { role: 'user', content: 'Resume from transcript store' }
        },
        {
          type: 'assistant',
          sessionId: 'claude-transcript-session',
          timestamp: '2026-05-02T10:01:00.000Z',
          cwd: '/repo/legacy',
          gitBranch: 'main',
          message: {
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 12, output_tokens: 4 }
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      claudeProjectsDir: join(root, 'claude-projects'),
      claudeTranscriptsDir: transcriptsRoot,
      codexSessionsDir: join(root, 'codex-sessions'),
      geminiSessionsDir: join(root, 'gemini-sessions'),
      copilotSessionsDir: join(root, 'copilot-sessions'),
      cursorProjectsDir: join(root, 'cursor-projects'),
      opencodeStorageDir: join(root, 'opencode-storage'),
      opencodeDbPaths: [],
      grokSessionsDir: join(root, 'grok-sessions'),
      devinTranscriptsDir: join(root, 'devin-transcripts'),
      hermesSessionsDir: join(root, 'hermes-sessions'),
      rovoSessionsDir: join(root, 'rovo-sessions'),
      openclawStateDir: join(root, 'openclaw-state'),
      openclawLegacyStateDir: join(root, 'openclaw-legacy-state'),
      piSessionsDir: join(root, 'pi-sessions'),
      droidSessionsDir: join(root, 'droid-sessions'),
      droidProjectsDir: join(root, 'droid-projects'),
      kimiSessionsDir: join(root, 'kimi-sessions')
    })

    const claude = result.sessions.find(
      (session) => session.sessionId === 'claude-transcript-session'
    )
    expect(claude).toMatchObject({
      agent: 'claude',
      cwd: '/repo/legacy',
      branch: 'main',
      resumeCommand: "cd '/repo/legacy' && claude --resume 'claude-transcript-session'"
    })
  })
})
