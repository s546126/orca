import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import { readForeignSessionCatalogEntry } from './foreign-session-import-catalog'
import { foreignImportNativeSessionId } from './foreign-session-native-id'
import { importForeignSessions } from './import-foreign-sessions'

const CODEX_ID = '019f0000-1111-7222-8333-444444444444'
const WORKSPACE = 'repo::/repo/app'

let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  for (const root of roots) {
    closeTestJournalHostDatabase(root)
  }
  roots = []
})

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-foreign-import-'))
  roots.push(root)
  const database = openTestJournalHostDatabase(root)
  const store = await openTestAgentSessionRecordStore(root)
  return {
    root,
    importFrom: (request) =>
      importForeignSessions(
        { database, store, claimKeyId: 'import-test-key', now: () => 1_700_000_000_000 },
        request
      )
  }
}

describe('foreign session import', () => {
  it('imports a Codex thread once, then continues it when a workspace is named', async () => {
    const { root, importFrom } = await harness()
    const filePath = path.join(root, 'sessions', '2026', '05', '01', `rollout-${CODEX_ID}.jsonl`)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: CODEX_ID, cwd: '/repo/app' }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fix the test' }]
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T10:00:02.000Z',
          type: 'response_item',
          payload: { type: 'reasoning', summary: [{ text: 'Look at the assertion' }] }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T10:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            call_id: 'call-1',
            arguments: { cmd: 'ls' }
          }
        })
      ].join('\n')
    )

    const blocked = await importFrom({ harness: 'codex', paths: [filePath] })
    expect(blocked.entries[0]).toMatchObject({
      outcome: 'imported',
      resume: { mode: 'read-only' }
    })
    expect(blocked.entries[0]?.resume).toMatchObject({
      mode: 'read-only',
      reason: expect.stringContaining('workspace')
    })

    const nativeSessionId = foreignImportNativeSessionId('codex', CODEX_ID)
    const continued = await importFrom({
      harness: 'codex',
      paths: [filePath],
      workspaceId: WORKSPACE
    })
    expect(continued.entries[0]).toMatchObject({
      outcome: 'updated',
      nativeSessionId,
      resume: { mode: 'resumable' }
    })

    const again = await importFrom({
      harness: 'codex',
      paths: [filePath],
      workspaceId: WORKSPACE
    })
    expect(again.entries[0]?.outcome).toBe('duplicate')

    const store = await openTestAgentSessionRecordStore(root)
    const record = store.getRecord(nativeSessionId)
    expect(record?.provider).toBe('codex')
    expect(record?.lease.claimStatus).toBe('released')
    expect(record?.providerHandleChain[0]?.handle).toEqual({
      provider: 'codex',
      threadId: CODEX_ID
    })
    expect(record?.providerHandleChain[0]?.origin).toBe('adopted')
    expect(store.listRecords()).toHaveLength(1)

    const catalog = readForeignSessionCatalogEntry(
      openTestJournalHostDatabase(root),
      nativeSessionId
    )
    expect(catalog?.provenance).toMatchObject({
      sourceHarness: 'codex',
      originalPath: filePath,
      originalSessionId: CODEX_ID
    })
    expect(catalog?.provenance.importedAt).toBeTruthy()

    const journal = await openAgentSessionJournal({
      identity: {
        sessionId: nativeSessionId,
        workspaceId: WORKSPACE,
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: CODEX_ID }
      },
      database: openTestJournalHostDatabase(root)
    })
    const bodies = journal.snapshot().items.map((item) => item.body)
    expect(bodies.map((body) => (body.kind === 'message' ? body.role : body.kind))).toEqual([
      'user',
      'reasoning',
      'tool-call'
    ])
    expect(bodies[2]).toMatchObject({ kind: 'tool-call', name: 'shell', state: 'running' })
  })

  it('stores a Pi session with thinking and does not duplicate it', async () => {
    const { root, importFrom } = await harness()
    const filePath = path.join(root, 'pi-session-1.jsonl')
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'pi-session-1',
          cwd: '/repo/app',
          timestamp: '2026-05-01T10:00:00.000Z'
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-05-01T10:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Explain the bug' }] }
        }),
        JSON.stringify({
          type: 'thinking',
          timestamp: '2026-05-01T10:00:02.000Z',
          thinking: 'Check the stack'
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-05-01T10:00:03.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'a.ts' } }]
          }
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-05-01T10:00:04.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'tool-1',
            content: [{ type: 'text', text: 'file body' }]
          }
        })
      ].join('\n')
    )

    const first = await importFrom({ harness: 'pi', paths: [filePath] })
    const nativeSessionId = foreignImportNativeSessionId('pi', 'pi-session-1')
    expect(first.entries[0]).toMatchObject({
      outcome: 'imported',
      nativeSessionId,
      resume: { mode: 'resumable' }
    })
    const second = await importFrom({ harness: 'pi', paths: [filePath] })
    expect(second.entries[0]?.outcome).toBe('duplicate')

    const store = await openTestAgentSessionRecordStore(root)
    expect(store.listRecords()).toEqual([])
    const journal = await openAgentSessionJournal({
      identity: {
        sessionId: nativeSessionId,
        workspaceId: 'foreign-import',
        hostId: 'local',
        agent: 'pi',
        providerHandle: { kind: 'opaque', agent: 'pi', value: 'pi-session-1' }
      },
      database: openTestJournalHostDatabase(root)
    })
    const bodies = journal.snapshot().items.map((item) => item.body)
    expect(bodies[1]).toMatchObject({ kind: 'message', role: 'reasoning' })
    expect(bodies[2]).toMatchObject({
      kind: 'tool-call',
      name: 'read',
      state: 'completed',
      callId: 'tool-1'
    })
  })

  it('keeps a Pi log with an unknown role as read-only history', async () => {
    const { root, importFrom } = await harness()
    const filePath = path.join(root, 'pi-gap.jsonl')
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: 'session', id: 'pi-gap', cwd: '/repo/app' }),
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: 'hello' }
        }),
        JSON.stringify({
          type: 'message',
          message: { role: 'narrator', content: 'aside' }
        })
      ].join('\n')
    )
    const result = await importFrom({ harness: 'pi', paths: [filePath] })
    expect(result.entries[0]?.resume).toMatchObject({
      mode: 'read-only',
      reason: expect.stringContaining('narrator')
    })
  })
})
