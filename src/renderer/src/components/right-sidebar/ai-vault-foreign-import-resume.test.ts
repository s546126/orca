import { describe, expect, it } from 'vitest'
import { aiVaultSessionRowResumeGating } from './ai-vault-session-resume'

describe('imported session resume gating', () => {
  const session = {
    messageCount: 2,
    previewMessages: [{ role: 'user' as const, text: 'hello', timestamp: null }],
    structuredSession: undefined
  }

  it('disables resume when the import was saved as history only', () => {
    expect(
      aiVaultSessionRowResumeGating(
        {
          ...session,
          foreignImport: {
            nativeSessionId: 'pi_import_pi-gap',
            provenance: {
              sourceHarness: 'pi',
              originalPath: '/tmp/pi-gap.jsonl',
              originalSessionId: 'pi-gap',
              importedAt: '2026-05-01T10:00:00.000Z'
            },
            resume: { mode: 'read-only', reason: 'Orca could not map narrator.' }
          }
        },
        { blocked: false }
      )
    ).toEqual({ resumeDisabled: true, canCopyResumeCommand: false })
  })

  it('leaves a resumable import on the normal resume path', () => {
    expect(
      aiVaultSessionRowResumeGating(
        {
          ...session,
          foreignImport: {
            nativeSessionId: 'pi_import_pi-session-1',
            provenance: {
              sourceHarness: 'pi',
              originalPath: '/tmp/pi.jsonl',
              originalSessionId: 'pi-session-1',
              importedAt: '2026-05-01T10:00:00.000Z'
            },
            resume: { mode: 'resumable' }
          }
        },
        { blocked: false }
      )
    ).toEqual({ resumeDisabled: false, canCopyResumeCommand: true })
  })
})
