import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionInfo } from './emulator-types'
import type { EmulatorSessionRegistry } from './emulator-session-registry'

// Why: the registry-delegating worktree/session shells are thin orchestration
// over the shared registry plus a backend teardown hook — not serve-sim guts.
// Extracting them lets EmulatorBridge (iOS) and AndroidBridge share one
// orchestrator; each passes its own teardown (serve-sim stop vs backend.teardown).

export type SessionTeardownTarget = {
  deviceUdid: string
  pid?: number
}

export type SessionTeardownOptions = {
  // Omit (undefined) to leave the key out of the downstream options object —
  // the destroy path intentionally passes no includeOrphaned, unlike stop/kill.
  includeOrphaned?: boolean
  shutdownDevice: boolean
  ignoreShutdownError: boolean
}

export type SessionTeardown = (
  target: SessionTeardownTarget,
  options: SessionTeardownOptions
) => Promise<void>

export type EmulatorTargetOpts = {
  device?: string
  emulator?: string
  worktreeId?: string
}

export class EmulatorSessionLifecycle {
  constructor(
    private readonly registry: EmulatorSessionRegistry,
    private readonly teardown: SessionTeardown,
    // Why: the registry is shared across iOS/Android bridges. This lifecycle only
    // owns sessions of its own kind; teardown must never fire on another kind's.
    private readonly kind: 'ios' | 'android'
  ) {}

  registerActive(
    worktreeId: string,
    info: EmulatorSessionInfo,
    options: { managed?: boolean } = {}
  ): void {
    this.registry.registerActive(worktreeId, info, options)
  }

  unregisterWorktree(worktreeId: string): void {
    this.registry.unregisterWorktree(worktreeId)
  }

  getActiveForWorktree(worktreeId?: string): EmulatorSessionInfo | null {
    return this.registry.getActiveForWorktree(worktreeId)
  }

  getTargetOrThrow(opts?: EmulatorTargetOpts): { udid: string; worktreeId?: string } {
    if (opts?.device) {
      return { udid: opts.device, worktreeId: opts.worktreeId }
    }
    if (opts?.emulator) {
      return { udid: opts.emulator, worktreeId: opts.worktreeId }
    }
    if (opts?.worktreeId) {
      const active = this.getActiveForWorktree(opts.worktreeId)
      if (active) {
        return { udid: active.deviceUdid, worktreeId: opts.worktreeId }
      }
    }
    throw new EmulatorError(
      'emulator_no_active',
      'No active emulator for this worktree — use orca emulator attach or open the pane'
    )
  }

  async stopActiveForWorktree(
    worktreeId: string,
    options: { shutdownDevice?: boolean; managedOnly?: boolean } = {}
  ): Promise<string | null> {
    const key = this.registry.getActiveSessionKey(worktreeId)
    if (!key) {
      return null
    }
    const session = this.registry.getSession(key)
    // Why: never tear down or unregister a session owned by another bridge kind
    // (e.g. attach --kind android must not corrupt/leak an active iOS session).
    if (session && session.kind !== this.kind) {
      return null
    }
    this.registry.unregisterWorktree(worktreeId)
    if (!session || (options.managedOnly && !session.managed)) {
      return null
    }
    await this.teardown(
      { deviceUdid: session.deviceUdid, pid: session.pid },
      {
        includeOrphaned: !options.managedOnly,
        shutdownDevice: options.shutdownDevice === true,
        ignoreShutdownError: true
      }
    )
    this.registry.clearSessionAndWorktrees(key)
    return session.deviceUdid
  }

  async tearDownDevice(
    udid: string,
    options: { shutdownDevice: boolean; ignoreShutdownError: boolean },
    worktreeId?: string
  ): Promise<string> {
    // Resolve the composite registry key. WHY: Android sessions are keyed
    // hostId::serial, so clearing by the raw serial would strand the record and
    // leak the session. Prefer the worktree's active key (disambiguates two hosts
    // sharing 127.0.0.1:5555) when it points at this udid, else scan by udid, else
    // fall back to the udid itself (iOS, where key === udid — unchanged).
    const worktreeKey = worktreeId ? this.registry.getActiveSessionKey(worktreeId) : null
    const worktreeMatches =
      worktreeKey !== null && this.registry.getSession(worktreeKey)?.deviceUdid === udid
    const key =
      (worktreeMatches ? worktreeKey : null) ??
      this.registry.getSessionKeyForUdid(udid) ??
      udid
    const session = this.registry.getSession(key)
    await this.teardown(
      { deviceUdid: udid, pid: session?.pid },
      { includeOrphaned: true, ...options }
    )
    this.registry.clearSessionAndWorktrees(key)
    return udid
  }

  async destroyAll(): Promise<void> {
    const promises: Promise<unknown>[] = []
    for (const session of this.registry.listSessions()) {
      // Why: the registry is shared across kinds; never run this kind's teardown
      // (e.g. redroid docker rm) against another kind's session.
      if ((session.kind ?? 'ios') !== this.kind) {
        continue
      }
      if (session.managed) {
        // Why: matches legacy destroyAll — no includeOrphaned key, device
        // shutdown errors swallowed, only managed sessions reaped.
        promises.push(
          this.teardown(
            { deviceUdid: session.deviceUdid, pid: session.pid },
            { shutdownDevice: true, ignoreShutdownError: true }
          ).catch(() => {})
        )
      }
    }
    await Promise.allSettled(promises)
    // Clear only this kind's sessions — a blanket clear() would wipe the other
    // bridge's live sessions off the shared registry.
    this.registry.clearSessionsOfKind(this.kind)
  }
}
