import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  collectAgentTypesByWorktree,
  collectWorktreeAgentIds,
  worktreeMatchesAgentFilter
} from './workspace-agent-filter-evidence'

const leafId = '11111111-1111-4111-8111-111111111111'

describe('collectWorktreeAgentIds', () => {
  it('uses createdWithAgent as last-used agent evidence', () => {
    expect(
      collectWorktreeAgentIds({
        createdWithAgent: 'claude'
      })
    ).toEqual(new Set(['claude']))
  })

  it('keeps Claude Agent Teams distinct from Claude', () => {
    expect(
      collectWorktreeAgentIds({
        createdWithAgent: 'claude-agent-teams'
      })
    ).toEqual(new Set(['claude-agent-teams']))
  })

  it('uses launchAgent on the worktree terminals', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ launchAgent: 'openclaude', title: 'Terminal 1' }]
      })
    ).toEqual(new Set(['openclaude']))
  })

  it('uses title-derived identity when launchAgent is missing', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ title: 'claude [working]' }]
      })
    ).toEqual(new Set(['claude']))
  })

  it('does not treat a Claude mention in a Codex-owned task title as Claude', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ launchAgent: 'codex', title: '⠋ add claude.md' }]
      })
    ).toEqual(new Set(['codex']))
  })

  it('uses a live pane title when the tab title is generic', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ id: 'tab-1', title: 'Terminal 1' }],
        runtimePaneTitlesByTabId: { 'tab-1': { 1: 'codex [working]' } }
      })
    ).toEqual(new Set(['codex']))
  })

  it('unions live/retained/sleeping agent types with created-with and tabs', () => {
    expect(
      collectWorktreeAgentIds({
        createdWithAgent: 'claude',
        tabs: [{ launchAgent: 'codex', title: 'Codex' }],
        extraAgentTypes: ['copilot']
      })
    ).toEqual(new Set(['claude', 'codex', 'copilot']))
  })

  it('drops unknown agent strings so they cannot match a catalog selection', () => {
    expect(
      collectWorktreeAgentIds({
        createdWithAgent: 'unknown',
        extraAgentTypes: ['cc', 'not-an-agent']
      })
    ).toEqual(new Set())
  })
})

describe('worktreeMatchesAgentFilter', () => {
  it('treats a cleared selection as all workspaces', () => {
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-1' }, null, {
        tabsByWorktree: {},
        agentTypesByWorktree: {}
      })
    ).toBe(true)
  })

  it('matches created-with, launch, and extra agent evidence by exact id', () => {
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-cc', createdWithAgent: 'claude' }, ['claude'], {
        tabsByWorktree: {},
        agentTypesByWorktree: {}
      })
    ).toBe(true)
    expect(
      worktreeMatchesAgentFilter(
        { id: 'wt-teams', createdWithAgent: 'claude-agent-teams' },
        ['claude'],
        {
          tabsByWorktree: {},
          agentTypesByWorktree: {}
        }
      )
    ).toBe(false)
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-codex' }, ['codex'], {
        tabsByWorktree: { 'wt-codex': [{ launchAgent: 'codex', title: 'Terminal 1' }] },
        agentTypesByWorktree: {}
      })
    ).toBe(true)
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-live' }, ['openclaude'], {
        tabsByWorktree: {},
        agentTypesByWorktree: { 'wt-live': ['openclaude'] }
      })
    ).toBe(true)
  })

  it('matches a workspace that used any selected agent', () => {
    expect(
      worktreeMatchesAgentFilter(
        { id: 'wt-codex', createdWithAgent: 'codex' },
        ['claude', 'codex'],
        {
          tabsByWorktree: {},
          agentTypesByWorktree: {}
        }
      )
    ).toBe(true)
  })

  it('rejects workspaces with no selected-agent evidence', () => {
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-other', createdWithAgent: 'copilot' }, ['claude'], {
        tabsByWorktree: { 'wt-other': [{ title: 'Terminal 1' }] },
        agentTypesByWorktree: { 'wt-other': ['gemini'] }
      })
    ).toBe(false)
  })
})

describe('collectAgentTypesByWorktree', () => {
  it('indexes live, retained, and sleeping agent records by worktree', () => {
    const paneKey = makePaneKey('tab-live', leafId)
    expect(
      collectAgentTypesByWorktree({
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            worktreeId: 'wt-live',
            agentType: 'claude'
          }
        },
        retainedAgentsByPaneKey: {
          'tab-retained:0': {
            worktreeId: 'wt-retained',
            agentType: 'codex'
          }
        },
        sleepingAgentSessionsByPaneKey: {
          'tab-sleep:0': {
            worktreeId: 'wt-sleep',
            agent: 'claude'
          }
        }
      })
    ).toEqual({
      'wt-live': ['claude'],
      'wt-retained': ['codex'],
      'wt-sleep': ['claude']
    })
  })

  it('falls back to the tab worktree when a live entry omitted worktreeId', () => {
    const paneKey = makePaneKey('tab-1', leafId)
    expect(
      collectAgentTypesByWorktree({
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            agentType: 'codex'
          }
        },
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1' }]
        }
      })
    ).toEqual({
      'wt-1': ['codex']
    })
  })

  it('keys colliding same-id workspaces by host so evidence cannot cross', () => {
    const sharedId = 'repo::/app'
    const paneKey = makePaneKey('tab-local', leafId)
    const extra = collectAgentTypesByWorktree({
      worktrees: [
        { id: sharedId, hostId: 'local' },
        { id: sharedId, hostId: 'ssh:box' }
      ],
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          worktreeId: sharedId,
          agentType: 'claude',
          connectionId: null
        }
      }
    })
    expect(extra).toEqual({ 'local|repo::/app': ['claude'] })
    expect(
      worktreeMatchesAgentFilter({ id: sharedId, hostId: 'local' }, ['claude'], {
        agentTypesByWorktree: extra,
        collidingWorktreeIds: new Set([sharedId])
      })
    ).toBe(true)
    expect(
      worktreeMatchesAgentFilter({ id: sharedId, hostId: 'ssh:box' }, ['claude'], {
        agentTypesByWorktree: extra,
        tabsByWorktree: { [sharedId]: [{ launchAgent: 'claude', title: 'claude [working]' }] },
        collidingWorktreeIds: new Set([sharedId])
      })
    ).toBe(false)
  })
})
