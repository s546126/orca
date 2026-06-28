import type { RedroidContainerRow } from './redroid-container-spec'

// Pure sweep logic. redroid containers survive an Orca crash and keep holding
// binder contexts, so on startup (Phase 5 wiring) we list the host's labeled
// containers and reap the ones whose session id is no longer live. Pure +
// unit-testable; the backend runs the `docker rm -f` via the injected executor.

// List ALL (including stopped) containers stamped with this host's orca.host
// label, tab-separated so the existing pure parser needs no docker-version quirks.
export function buildHostContainersPsArgs(hostId: string): string[] {
  return [
    'ps',
    '-a',
    '--filter',
    `label=orca.host=${hostId}`,
    '--format',
    '{{.ID}}\t{{.Names}}\t{{.Labels}}'
  ]
}

// A container is an orphan when its orca.session label is missing or not in the
// live set — its owning Orca session is gone. Returns container ids to remove.
export function computeOrphanContainers(
  containers: RedroidContainerRow[],
  liveSessionIds: ReadonlySet<string>
): string[] {
  const orphans: string[] = []
  for (const container of containers) {
    if (!container.sessionId || !liveSessionIds.has(container.sessionId)) {
      orphans.push(container.containerId)
    }
  }
  return orphans
}

export function buildOrphanReapArgs(containerId: string): string[] {
  return ['rm', '-f', containerId]
}
