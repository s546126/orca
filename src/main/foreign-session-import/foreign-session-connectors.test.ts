import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { parseCodexForeignSession } from './codex-foreign-session-connector'
import { foreignImportNativeSessionId } from './foreign-session-native-id'
import { parsePiForeignSession } from './pi-foreign-session-connector'
import { decideForeignSessionResume } from '../../shared/foreign-session-import'

const CODEX_ID = '019f0000-1111-7222-8333-444444444444'

function codexLog(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n')
}

describe('Codex foreign session parser', () => {
  const filePath = path.join('/home/ada/.codex/sessions/2026/05/01', `rollout-${CODEX_ID}.jsonl`)

  it('keeps role order, reasoning, and tool calls', () => {
    const parsed = parseCodexForeignSession(
      filePath,
      codexLog([
        {
          timestamp: '2026-05-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: CODEX_ID, cwd: '/repo/app' }
        },
        {
          timestamp: '2026-05-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fix the test' }]
          }
        },
        {
          timestamp: '2026-05-01T10:00:02.000Z',
          type: 'response_item',
          payload: { type: 'reasoning', summary: [{ text: 'Look at the assertion' }] }
        },
        {
          timestamp: '2026-05-01T10:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            call_id: 'call-1',
            arguments: { cmd: 'ls' }
          }
        },
        {
          timestamp: '2026-05-01T10:00:04.000Z',
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-1', output: 'ok' }
        },
        {
          timestamp: '2026-05-01T10:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done' }]
          }
        }
      ])
    )

    expect(parsed.originalSessionId).toBe(CODEX_ID)
    expect(parsed.cwd).toBe('/repo/app')
    expect(parsed.codexHome).toBe(path.join('/home/ada/.codex'))
    expect(parsed.gaps).toEqual([])
    expect(parsed.messages.map((message) => message.role)).toEqual([
      'user',
      'reasoning',
      'assistant',
      'tool',
      'assistant'
    ])
    const call = parsed.messages[2]?.blocks[0]
    expect(call).toMatchObject({ type: 'tool-call', name: 'shell', callId: 'call-1' })
    expect(parsed.messages[3]?.blocks[0]).toMatchObject({
      type: 'tool-result',
      callId: 'call-1',
      output: 'ok'
    })
    expect(foreignImportNativeSessionId('codex', parsed.originalSessionId)).toBe(
      foreignImportNativeSessionId('codex', CODEX_ID)
    )
  })

  it('keeps event_msg text and drops the matching response copy', () => {
    const parsed = parseCodexForeignSession(
      filePath,
      codexLog([
        {
          timestamp: '2026-05-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: CODEX_ID, cwd: '/repo/app' }
        },
        {
          timestamp: '2026-05-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Prompt' }]
          }
        },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Prompt' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'Response' } },
        {
          timestamp: '2026-05-01T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Response' }]
          }
        }
      ])
    )
    expect(parsed.gaps).toEqual([])
    expect(parsed.messages.map((message) => message.blocks[0])).toEqual([
      { type: 'text', text: 'Prompt' },
      { type: 'text', text: 'Response' }
    ])
  })

  it('marks an unmapped tool event so the import stays read-only', () => {
    const parsed = parseCodexForeignSession(
      filePath,
      codexLog([
        {
          timestamp: '2026-05-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: CODEX_ID, cwd: '/repo/app' }
        },
        {
          timestamp: '2026-05-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Go' }]
          }
        },
        {
          timestamp: '2026-05-01T10:00:02.000Z',
          type: 'response_item',
          payload: { type: 'mystery_tool', name: 'explode' }
        }
      ])
    )
    expect(parsed.gaps).toEqual(['unmapped-response:mystery_tool'])
    expect(parsed.messages.map((message) => message.role)).toEqual(['user'])
    expect(
      decideForeignSessionResume({
        harness: 'codex',
        hasSessionId: true,
        gaps: parsed.gaps,
        workspaceId: 'repo::/repo/app',
        codexHome: parsed.codexHome,
        cwd: parsed.cwd
      }).resume.mode
    ).toBe('read-only')
  })
})

describe('Pi foreign session parser', () => {
  it('keeps thinking, tool calls, and tool results from typed events', () => {
    const parsed = parsePiForeignSession(
      '/home/ada/.pi/agent/sessions/pi-session-1.jsonl',
      [
        {
          type: 'session_start',
          id: 'pi-session-1',
          cwd: '/repo/app',
          timestamp: '2026-05-01T10:00:00.000Z'
        },
        { type: 'model_change', modelId: 'claude-sonnet', timestamp: '2026-05-01T10:00:01.000Z' },
        {
          type: 'message',
          timestamp: '2026-05-01T10:00:02.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Explain the bug' }] }
        },
        { type: 'thinking', timestamp: '2026-05-01T10:00:03.000Z', thinking: 'Check the stack' },
        {
          type: 'message',
          timestamp: '2026-05-01T10:00:04.000Z',
          message: {
            role: 'assistant',
            model: 'claude-sonnet',
            content: [
              { type: 'text', text: 'I will look' },
              { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'a.ts' } }
            ]
          }
        },
        {
          type: 'message',
          timestamp: '2026-05-01T10:00:05.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'tool-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'file body' }],
            isError: false
          }
        }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')
    )

    expect(parsed.hasSessionId).toBe(true)
    expect(parsed.originalSessionId).toBe('pi-session-1')
    expect(parsed.model).toBe('claude-sonnet')
    expect(parsed.gaps).toEqual([])
    expect(parsed.messages.map((message) => message.role)).toEqual([
      'user',
      'reasoning',
      'assistant',
      'assistant',
      'tool'
    ])
    expect(parsed.messages[1]?.blocks[0]).toMatchObject({ type: 'text', text: 'Check the stack' })
    expect(parsed.messages[3]?.blocks[0]).toMatchObject({
      type: 'tool-call',
      name: 'read',
      callId: 'tool-1'
    })
    expect(parsed.messages[4]?.blocks[0]).toMatchObject({
      type: 'tool-result',
      callId: 'tool-1',
      output: 'file body'
    })
  })

  it('records an unknown role as a mapping gap', () => {
    const parsed = parsePiForeignSession(
      '/tmp/pi.jsonl',
      [
        {
          type: 'session',
          id: 'pi-session-2',
          cwd: '/repo/app',
          timestamp: '2026-05-01T10:00:00.000Z'
        },
        {
          type: 'message',
          timestamp: '2026-05-01T10:00:01.000Z',
          message: { role: 'user', content: 'hello' }
        },
        {
          type: 'message',
          timestamp: '2026-05-01T10:00:02.000Z',
          message: { role: 'narrator', content: 'aside' }
        }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')
    )
    expect(parsed.gaps).toContain('unmapped-role:narrator')
    expect(
      decideForeignSessionResume({
        harness: 'pi',
        hasSessionId: true,
        gaps: parsed.gaps,
        workspaceId: null,
        codexHome: null,
        cwd: parsed.cwd
      }).resume
    ).toMatchObject({ mode: 'read-only' })
  })
})
