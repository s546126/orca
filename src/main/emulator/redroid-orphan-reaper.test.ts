import { describe, expect, it } from 'vitest'
import {
  buildHostContainersPsArgs,
  buildOrphanReapArgs,
  computeOrphanContainers
} from './redroid-orphan-reaper'
import type { RedroidContainerRow } from './redroid-container-spec'

function row(containerId: string, sessionId?: string): RedroidContainerRow {
  return { containerId, name: `orca-redroid-${sessionId ?? containerId}`, sessionId }
}

describe('computeOrphanContainers', () => {
  it('reaps containers whose session id is not live, keeps live ones', () => {
    const containers = [row('c1', 'live-1'), row('c2', 'stale-2'), row('c3', 'live-3')]
    const live = new Set(['live-1', 'live-3'])
    expect(computeOrphanContainers(containers, live)).toEqual(['c2'])
  })

  it('reaps containers with no session label (cannot be attributed to a live session)', () => {
    const containers = [row('c1'), row('c2', 'live-1')]
    expect(computeOrphanContainers(containers, new Set(['live-1']))).toEqual(['c1'])
  })

  it('returns nothing when the set is empty', () => {
    expect(computeOrphanContainers([], new Set(['live-1']))).toEqual([])
  })

  it('reaps nothing when every container is live', () => {
    const containers = [row('c1', 'a'), row('c2', 'b')]
    expect(computeOrphanContainers(containers, new Set(['a', 'b']))).toEqual([])
  })

  it('reaps everything when no session is live', () => {
    const containers = [row('c1', 'a'), row('c2', 'b')]
    expect(computeOrphanContainers(containers, new Set())).toEqual(['c1', 'c2'])
  })
})

describe('orphan reaper argv builders', () => {
  it('filters docker ps -a by the host label', () => {
    expect(buildHostContainersPsArgs('h1')).toEqual([
      'ps',
      '-a',
      '--filter',
      'label=orca.host=h1',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.Labels}}'
    ])
  })

  it('force-removes a container by id', () => {
    expect(buildOrphanReapArgs('c1')).toEqual(['rm', '-f', 'c1'])
  })
})
