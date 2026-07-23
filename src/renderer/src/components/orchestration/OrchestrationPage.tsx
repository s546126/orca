import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ListTree, RefreshCw, Share2, Waypoints } from 'lucide-react'
import MermaidBlock from '@/components/editor/MermaidBlock'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAppStore } from '@/store'
import { focusRuntimeOrchestrationTask } from '@/components/terminal-pane/terminal-orchestration-task-links'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  ORCHESTRATION_TASK_STATUSES,
  type OrchestrationTaskStatus
} from './orchestration-graph-model'
import { useOrchestrationSnapshot } from './useOrchestrationSnapshot'

type OrchestrationGraphMode = 'tasks' | 'agents'

// Why: status is app state, so per the styleguide it is the one place color is
// allowed. Success/failure map to the reserved success/destructive roles; the
// rest lean on quiet role tokens plus amber for the blocked "needs attention".
const STATUS_DOT_CLASS: Record<OrchestrationTaskStatus, string> = {
  pending: 'bg-muted-foreground/50',
  ready: 'bg-primary/60',
  dispatched: 'bg-primary',
  completed: 'bg-emerald-500',
  failed: 'bg-destructive',
  blocked: 'bg-amber-500'
}

function statusLabel(status: OrchestrationTaskStatus): string {
  switch (status) {
    case 'pending':
      return translate('auto.components.orchestration.OrchestrationPage.status.pending', 'Pending')
    case 'ready':
      return translate('auto.components.orchestration.OrchestrationPage.status.ready', 'Ready')
    case 'dispatched':
      return translate(
        'auto.components.orchestration.OrchestrationPage.status.dispatched',
        'Dispatched'
      )
    case 'completed':
      return translate(
        'auto.components.orchestration.OrchestrationPage.status.completed',
        'Completed'
      )
    case 'failed':
      return translate('auto.components.orchestration.OrchestrationPage.status.failed', 'Failed')
    case 'blocked':
      return translate('auto.components.orchestration.OrchestrationPage.status.blocked', 'Blocked')
  }
}

function useIsDark(): boolean {
  const theme = useAppStore((s) => s.settings?.theme)
  return (
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  )
}

function CenteredState({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6">
      <div className="max-w-sm text-center text-sm text-muted-foreground">{children}</div>
    </div>
  )
}

function StatusLegendRow({
  status,
  count
}: {
  status: OrchestrationTaskStatus
  count: number
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT_CLASS[status])} />
      <span className="min-w-0 flex-1 truncate text-foreground">{statusLabel(status)}</span>
      <span className="tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}

export default function OrchestrationPage(): React.JSX.Element {
  const closeOrchestrationPage = useAppStore((s) => s.closeOrchestrationPage)
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId ?? null)
  const isDark = useIsDark()
  const [mode, setMode] = useState<OrchestrationGraphMode>('tasks')
  const { snapshot, loading, error, refresh } = useOrchestrationSnapshot(true)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      const overlay = document.querySelector('[role="dialog"], [role="listbox"], [role="menu"]')
      if (overlay) {
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) {
        return
      }
      event.preventDefault()
      closeOrchestrationPage()
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [closeOrchestrationPage])

  const runningTasks = useMemo(
    () =>
      (snapshot?.tasks ?? []).filter((task) => task.status === 'dispatched' && task.assigneeHandle),
    [snapshot]
  )
  const agentLabelByHandle = useMemo(
    () => new Map((snapshot?.agents ?? []).map((agent) => [agent.handle, agent.label])),
    [snapshot]
  )

  const jumpToAgent = useCallback(
    (taskId: string) => {
      // Why: mermaid nodes can't carry click handlers under strict mode, so the
      // "running now" list is the interactive path back to a dispatched agent.
      void focusRuntimeOrchestrationTask(taskId, environmentId)
        .then(() => closeOrchestrationPage())
        .catch(() => {
          // Agent may have exited between poll and click; leave the view open.
        })
    },
    [environmentId, closeOrchestrationPage]
  )

  const graphSource = mode === 'tasks' ? snapshot?.taskGraphSource : snapshot?.agentGraphSource

  const renderGraphArea = (): React.JSX.Element => {
    if (!snapshot && loading) {
      return (
        <CenteredState>
          {translate(
            'auto.components.orchestration.OrchestrationPage.loading',
            'Loading orchestration state…'
          )}
        </CenteredState>
      )
    }
    if (!snapshot && error) {
      return (
        <CenteredState>
          <p className="mb-3">{error}</p>
          <Button variant="outline" size="sm" onClick={refresh}>
            {translate('auto.components.orchestration.OrchestrationPage.retry', 'Retry')}
          </Button>
        </CenteredState>
      )
    }
    if (!graphSource) {
      return (
        <CenteredState>
          {mode === 'tasks'
            ? translate(
                'auto.components.orchestration.OrchestrationPage.emptyTasks',
                'No orchestration tasks yet. Dispatch work with the orchestration skill or the Orca CLI to see the task graph here.'
              )
            : translate(
                'auto.components.orchestration.OrchestrationPage.emptyAgents',
                'No agents or messages yet. Launch agents and let them coordinate to see the flow here.'
              )}
        </CenteredState>
      )
    }
    return (
      <div className="scrollbar-sleek h-full min-h-0 flex-1 overflow-auto p-6">
        <MermaidBlock content={graphSource} isDark={isDark} />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={closeOrchestrationPage}
          className="shrink-0 gap-1.5"
        >
          <ArrowLeft className="size-3.5" />
          {translate('auto.components.orchestration.OrchestrationPage.back', 'Back')}
        </Button>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30">
          <Waypoints className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-foreground">
            {translate('auto.components.orchestration.OrchestrationPage.title', 'Orchestration')}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {snapshot
              ? translate(
                  'auto.components.orchestration.OrchestrationPage.subtitle',
                  '{{tasks}} tasks · {{agents}} agents',
                  { tasks: snapshot.totalTaskCount, agents: snapshot.agents.length }
                )
              : translate(
                  'auto.components.orchestration.OrchestrationPage.subtitleIdle',
                  'Live view of the multi-agent task graph'
                )}
          </p>
        </div>
        <Tabs value={mode} onValueChange={(value) => setMode(value as OrchestrationGraphMode)}>
          <TabsList>
            <TabsTrigger value="tasks" className="gap-1.5">
              <ListTree className="size-3.5" />
              {translate('auto.components.orchestration.OrchestrationPage.tasksTab', 'Tasks')}
            </TabsTrigger>
            <TabsTrigger value="agents" className="gap-1.5">
              <Share2 className="size-3.5" />
              {translate('auto.components.orchestration.OrchestrationPage.agentsTab', 'Agents')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          aria-label={translate(
            'auto.components.orchestration.OrchestrationPage.refresh',
            'Refresh orchestration state'
          )}
        >
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">{renderGraphArea()}</div>

        <aside className="scrollbar-sleek w-64 shrink-0 overflow-auto border-l border-border p-4">
          {mode === 'tasks' ? (
            <>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                {translate(
                  'auto.components.orchestration.OrchestrationPage.statusHeading',
                  'Status'
                )}
              </h2>
              <div className="mb-4">
                {ORCHESTRATION_TASK_STATUSES.map((status) => (
                  <StatusLegendRow
                    key={status}
                    status={status}
                    count={snapshot?.taskStatusCounts[status] ?? 0}
                  />
                ))}
              </div>
              {runningTasks.length > 0 ? (
                <>
                  <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                    {translate(
                      'auto.components.orchestration.OrchestrationPage.runningHeading',
                      'Running now'
                    )}
                  </h2>
                  <div className="flex flex-col gap-1">
                    {runningTasks.slice(0, 12).map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => jumpToAgent(task.id)}
                        className="flex flex-col items-start gap-0.5 rounded-md border border-border px-2 py-1.5 text-left transition-colors hover:bg-accent"
                      >
                        <span className="line-clamp-2 text-xs font-medium text-foreground">
                          {task.title}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {task.assigneeHandle
                            ? (agentLabelByHandle.get(task.assigneeHandle) ?? task.assigneeHandle)
                            : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                {translate(
                  'auto.components.orchestration.OrchestrationPage.agentsHeading',
                  'Agents'
                )}
              </h2>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{snapshot?.agents.length ?? 0}</Badge>
                <span>
                  {translate(
                    'auto.components.orchestration.OrchestrationPage.messageEdges',
                    '{{count}} message links',
                    { count: snapshot?.totalMessageEdgeCount ?? 0 }
                  )}
                </span>
              </div>
            </>
          )}

          {snapshot && snapshot.totalTaskCount > snapshot.tasks.length ? (
            <p className="mt-4 text-[11px] text-muted-foreground">
              {translate(
                'auto.components.orchestration.OrchestrationPage.truncatedTasks',
                'Showing {{shown}} of {{total}} tasks',
                { shown: snapshot.tasks.length, total: snapshot.totalTaskCount }
              )}
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
