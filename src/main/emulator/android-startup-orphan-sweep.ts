import type { AndroidHost } from './android-device-backend'

// Why: redroid containers survive an Orca crash and hold binder contexts. On
// startup (and per active Android host) we sweep this host's labeled containers
// and rm -f the ones whose session id is no longer live. This wrapper guards the
// backend's reapOrphans so a missing host/docker never throws at startup — Android
// is an optional feature and an absent daemon must be a silent no-op.

export type ReapOrphans = (
  liveSessionIds: Iterable<string>,
  host: AndroidHost
) => Promise<string[]>

export async function sweepAndroidOrphansAtStartup(
  reapOrphans: ReapOrphans,
  host: AndroidHost | null,
  liveSessionIds: Iterable<string>
): Promise<string[]> {
  if (!host) {
    return [] // no reachable redroid host: nothing to sweep.
  }
  try {
    return await reapOrphans(liveSessionIds, host)
  } catch {
    // docker/host absent or unprivileged: never throw at startup.
    return []
  }
}
