import { describe, expect, it } from 'vitest'
import {
  buildAgentGraphMermaid,
  buildTaskGraphMermaid,
  deriveAgentLabel,
  mermaidCaption,
  parseTaskDeps,
  summarizeMessageEdges,
  type OrchestrationAgentNode,
  type OrchestrationTaskNode
} from './orchestration-graph-model'

describe('parseTaskDeps', () => {
  it('parses a JSON string array of ids', () => {
    expect(parseTaskDeps('["task_a","task_b"]')).toEqual(['task_a', 'task_b'])
  })

  it('returns [] for null, empty, non-array, or malformed JSON', () => {
    expect(parseTaskDeps(null)).toEqual([])
    expect(parseTaskDeps('')).toEqual([])
    expect(parseTaskDeps('{"a":1}')).toEqual([])
    expect(parseTaskDeps('not json')).toEqual([])
  })

  it('drops non-string and empty entries', () => {
    expect(parseTaskDeps('["task_a", 5, "", "task_b"]')).toEqual(['task_a', 'task_b'])
  })
})

describe('mermaidCaption', () => {
  it('strips characters that break quoted mermaid labels', () => {
    expect(mermaidCaption('a "b" <c> |d| {e}')).toBe('a b c d e')
  })

  it('truncates long captions with an ellipsis', () => {
    const caption = mermaidCaption('x'.repeat(60), 10)
    expect(caption.endsWith('…')).toBe(true)
    expect(caption.length).toBe(10)
  })

  it('falls back to a placeholder when empty', () => {
    expect(mermaidCaption('   ')).toBe('(untitled)')
  })
})

describe('deriveAgentLabel', () => {
  it('prefers a trimmed title when present', () => {
    expect(deriveAgentLabel('term_abcdef', '  Claude – ready ')).toBe('Claude – ready')
  })

  it('shortens a long handle when no title is available', () => {
    expect(deriveAgentLabel('term_0123456789abcdef')).toBe('term_01234567…')
  })

  it('keeps a short handle intact', () => {
    expect(deriveAgentLabel('term_abc')).toBe('term_abc')
  })
})

describe('summarizeMessageEdges', () => {
  it('counts messages per directed handle pair', () => {
    const edges = summarizeMessageEdges([
      { from_handle: 'a', to_handle: 'b' },
      { from_handle: 'a', to_handle: 'b' },
      { from_handle: 'b', to_handle: 'a' }
    ])
    expect(edges).toEqual([
      { from: 'a', to: 'b', count: 2 },
      { from: 'b', to: 'a', count: 1 }
    ])
  })

  it('skips self-loops, blanks, and unresolved group placeholders', () => {
    const edges = summarizeMessageEdges([
      { from_handle: 'a', to_handle: 'a' },
      { from_handle: '', to_handle: 'b' },
      { from_handle: 'a', to_handle: '@all' }
    ])
    expect(edges).toEqual([])
  })
})

describe('buildTaskGraphMermaid', () => {
  it('returns an empty string when there are no tasks', () => {
    expect(buildTaskGraphMermaid([], new Map())).toBe('')
  })

  it('emits dependency, subtask, and assignment edges with status classes', () => {
    const tasks: OrchestrationTaskNode[] = [
      {
        id: 'task_root',
        parentId: null,
        deps: [],
        status: 'completed',
        title: 'Root',
        assigneeHandle: null
      },
      {
        id: 'task_child',
        parentId: 'task_root',
        deps: ['task_root'],
        status: 'dispatched',
        title: 'Child',
        assigneeHandle: 'term_worker'
      }
    ]
    const source = buildTaskGraphMermaid(tasks, new Map([['term_worker', 'Codex']]))

    expect(source.startsWith('flowchart TD')).toBe(true)
    // dependency edge (root -> child) and subtask edge (root -.-> child)
    expect(source).toContain('t0 --> t1')
    expect(source).toContain('t0 -.-> t1')
    // assignment edge to the agent stadium node
    expect(source).toContain('t1 -->|runs on| a0')
    expect(source).toContain('a0(["Codex"])')
    // status class hooks for theming
    expect(source).toContain('class t0 status-completed')
    expect(source).toContain('class t1 status-dispatched')
  })

  it('ignores dependency edges pointing at unknown tasks', () => {
    const tasks: OrchestrationTaskNode[] = [
      {
        id: 'task_a',
        parentId: 'task_missing',
        deps: ['task_missing'],
        status: 'ready',
        title: 'A',
        assigneeHandle: null
      }
    ]
    const source = buildTaskGraphMermaid(tasks, new Map())
    expect(source).not.toContain('-->')
    expect(source).not.toContain('-.->')
  })
})

describe('buildAgentGraphMermaid', () => {
  it('returns an empty string when there are no agents', () => {
    expect(buildAgentGraphMermaid([], [])).toBe('')
  })

  it('renders agent stadium nodes and labels edges by count', () => {
    const agents: OrchestrationAgentNode[] = [
      { handle: 'a', label: 'Claude', detail: 'main' },
      { handle: 'b', label: 'Codex', detail: null }
    ]
    const source = buildAgentGraphMermaid(agents, [
      { from: 'a', to: 'b', count: 3 },
      { from: 'b', to: 'a', count: 1 }
    ])
    expect(source.startsWith('flowchart LR')).toBe(true)
    expect(source).toContain('a0(["Claude<br/>main"])')
    expect(source).toContain('a1(["Codex"])')
    expect(source).toContain('a0 -->|3| a1')
    expect(source).toContain('a1 --> a0')
  })
})
