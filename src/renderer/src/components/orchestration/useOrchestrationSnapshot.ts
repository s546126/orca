import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import {
  buildAgentGraphMermaid,
  buildTaskGraphMermaid,
  deriveAgentLabel,
  ORCHESTRATION_TASK_STATUSES,
  parseTaskDeps,
  summarizeMessageEdges,
  type OrchestrationAgentNode,
  type OrchestrationMessageEdge,
  type OrchestrationTaskNode,
  type OrchestrationTaskStatus
} from './orchestration-graph-model'

// Why: orchestration state has no renderer push channel, so the view polls.
// The coordinator itself ticks at ~2s (coordinator.ts pollIntervalMs), so a
// slightly slower cadence keeps the graph fresh without racing its writes.
const POLL_INTERVAL_MS = 2500
// Caps keep a runaway orchestration DB from producing an unreadable diagram;
// totals are surfaced separately so truncation is never silent.
const MAX_RENDERED_TASKS = 80
const MESSAGE_FETCH_LIMIT = 200
const MAX_MESSAGE_EDGES = 60

type OrchestrationTaskListRow = {
  id: string
  parent_id: string | null
  task_title: string | null
  display_name: string | null
  spec: string
  status: string
  deps: string
  assignee_handle?: string | null
}

type OrchestrationMessageRow = {
  from_handle: string
  to_handle: string
}

export type OrchestrationSnapshot = {
  tasks: OrchestrationTaskNode[]
  agents: OrchestrationAgentNode[]
  messageEdges: OrchestrationMessageEdge[]
  taskGraphSource: string
  agentGraphSource: string
  taskStatusCounts: Record<OrchestrationTaskStatus, number>
  totalTaskCount: number
  totalMessageEdgeCount: number
}

export type OrchestrationSnapshotState = {
  snapshot: OrchestrationSnapshot | null
  loading: boolean
  error: string | null
  lastUpdatedAt: number | null
  refresh: () => void
}

function isTaskStatus(value: string): value is OrchestrationTaskStatus {
  return (ORCHESTRATION_TASK_STATUSES as readonly string[]).includes(value)
}

function emptyStatusCounts(): Record<OrchestrationTaskStatus, number> {
  return {
    pending: 0,
    ready: 0,
    dispatched: 0,
    completed: 0,
    failed: 0,
    blocked: 0
  }
}

function taskRowTitle(row: OrchestrationTaskListRow): string {
  return row.display_name?.trim() || row.task_title?.trim() || row.spec?.trim() || row.id
}

function terminalDetail(terminal: RuntimeTerminalSummary): string | null {
  const branch = terminal.branch?.trim()
  if (branch) {
    return branch
  }
  const worktree = terminal.worktreeId?.trim()
  return worktree || null
}

function buildSnapshot(
  terminals: RuntimeTerminalSummary[],
  taskRows: OrchestrationTaskListRow[],
  messageRows: OrchestrationMessageRow[]
): OrchestrationSnapshot {
  const agentLabelByHandle = new Map<string, string>()
  const agentDetailByHandle = new Map<string, string | null>()
  for (const terminal of terminals) {
    agentLabelByHandle.set(terminal.handle, deriveAgentLabel(terminal.handle, terminal.title))
    agentDetailByHandle.set(terminal.handle, terminalDetail(terminal))
  }

  const taskStatusCounts = emptyStatusCounts()
  for (const row of taskRows) {
    if (isTaskStatus(row.status)) {
      taskStatusCounts[row.status] += 1
    }
  }

  const tasks: OrchestrationTaskNode[] = taskRows.slice(0, MAX_RENDERED_TASKS).map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    deps: parseTaskDeps(row.deps),
    status: isTaskStatus(row.status) ? row.status : 'pending',
    title: taskRowTitle(row),
    assigneeHandle: row.assignee_handle?.trim() || null
  }))

  const allMessageEdges = summarizeMessageEdges(messageRows).sort((a, b) => b.count - a.count)
  const messageEdges = allMessageEdges.slice(0, MAX_MESSAGE_EDGES)

  // Agent nodes = live terminals plus any handle that appears in a kept edge,
  // so message partners that are no longer running still show up.
  const agentHandles = new Set<string>()
  for (const terminal of terminals) {
    agentHandles.add(terminal.handle)
  }
  for (const edge of messageEdges) {
    agentHandles.add(edge.from)
    agentHandles.add(edge.to)
  }
  const agents: OrchestrationAgentNode[] = [...agentHandles].map((handle) => ({
    handle,
    label: agentLabelByHandle.get(handle) ?? deriveAgentLabel(handle),
    detail: agentDetailByHandle.get(handle) ?? null
  }))

  return {
    tasks,
    agents,
    messageEdges,
    taskGraphSource: buildTaskGraphMermaid(tasks, agentLabelByHandle),
    agentGraphSource: buildAgentGraphMermaid(agents, messageEdges),
    taskStatusCounts,
    totalTaskCount: taskRows.length,
    totalMessageEdgeCount: allMessageEdges.length
  }
}

/**
 * Polls the orchestration RPC read surface (`terminal.list`,
 * `orchestration.taskList`, `orchestration.inbox`) on a visibility-guarded
 * interval and returns a normalized snapshot plus ready-to-render mermaid
 * sources for the task and agent graphs.
 */
export function useOrchestrationSnapshot(active: boolean): OrchestrationSnapshotState {
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId ?? null)
  const [snapshot, setSnapshot] = useState<OrchestrationSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const inFlightRef = useRef(false)
  const refreshRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!active) {
      return
    }
    let cancelled = false
    const target = getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId })

    const run = (): void => {
      if (inFlightRef.current) {
        return
      }
      inFlightRef.current = true
      void (async () => {
        try {
          const [terminalResult, taskResult, messageResult] = await Promise.all([
            callRuntimeRpc<{ terminals: RuntimeTerminalSummary[] }>(target, 'terminal.list', {
              limit: 200
            }),
            callRuntimeRpc<{ tasks: OrchestrationTaskListRow[] }>(
              target,
              'orchestration.taskList',
              {}
            ),
            callRuntimeRpc<{ messages: OrchestrationMessageRow[] }>(target, 'orchestration.inbox', {
              limit: MESSAGE_FETCH_LIMIT
            })
          ])
          if (cancelled) {
            return
          }
          setSnapshot(
            buildSnapshot(
              terminalResult.terminals ?? [],
              taskResult.tasks ?? [],
              messageResult.messages ?? []
            )
          )
          setError(null)
          setLastUpdatedAt(Date.now())
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'Failed to load orchestration state')
          }
        } finally {
          if (!cancelled) {
            setLoading(false)
          }
          inFlightRef.current = false
        }
      })()
    }

    refreshRef.current = run
    const dispose = installWindowVisibilityInterval({ run, intervalMs: POLL_INTERVAL_MS })
    return () => {
      cancelled = true
      refreshRef.current = () => {}
      dispose()
    }
  }, [active, environmentId])

  const refresh = useCallback(() => {
    refreshRef.current()
  }, [])

  return { snapshot, loading, error, lastUpdatedAt, refresh }
}
