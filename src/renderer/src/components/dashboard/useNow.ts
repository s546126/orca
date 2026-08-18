import { useSyncExternalStore } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'

type ClockDeps = {
  now: () => number
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
  isVisible?: () => boolean
  addVisibilityListener?: (listener: () => void) => () => void
}

type SharedNowClock = {
  getSnapshot: () => number
  subscribe: (listener: () => void) => () => void
}

const nowClocks = new Map<number, SharedNowClock>()

export function createSharedNowClock(
  intervalMs: number,
  deps: ClockDeps = {
    now: () => Date.now(),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle),
    isVisible: () => isWindowVisible(),
    addVisibilityListener: (listener) => {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
        return () => {}
      }
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    }
  }
): SharedNowClock {
  let now = deps.now()
  let timer: ReturnType<typeof setInterval> | null = null
  let stopVisibilityWatcher: (() => void) | null = null
  const listeners = new Set<() => void>()
  const isVisible = deps.isVisible ?? (() => true)

  const tick = (): void => {
    now = deps.now()
    for (const listener of listeners) {
      listener()
    }
  }

  const stopTimer = (): void => {
    if (!timer) {
      return
    }
    deps.clearInterval(timer)
    timer = null
  }

  const startTimer = (): void => {
    if (timer || !isVisible()) {
      return
    }
    // Why: all mounted relative-time labels at the same cadence can share
    // one timer. Refresh immediately on restart so remounted labels don't
    // display the stale timestamp left from the previous subscriber set.
    tick()
    timer = deps.setInterval(tick, intervalMs)
  }

  const reconcileVisibility = (): void => {
    if (isVisible()) {
      startTimer()
    } else {
      stopTimer()
    }
  }

  return {
    getSnapshot: () => now,
    subscribe: (listener) => {
      listeners.add(listener)
      if (stopVisibilityWatcher === null && deps.addVisibilityListener) {
        stopVisibilityWatcher = deps.addVisibilityListener(reconcileVisibility)
      }
      startTimer()
      if (!timer) {
        tick()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopTimer()
          stopVisibilityWatcher?.()
          stopVisibilityWatcher = null
        }
      }
    }
  }
}

function getSharedNowClock(intervalMs: number): SharedNowClock {
  let clock = nowClocks.get(intervalMs)
  if (!clock) {
    clock = createSharedNowClock(intervalMs)
    nowClocks.set(intervalMs, clock)
  }
  return clock
}

// Why: relative timestamps drift once mounted. A 30s tick keeps the "Xm
// ago" labels honest without burning a render every second.
//
// Hoisted to a shared hook so container components (e.g.
// WorktreeCardAgents) can own a single tick and thread `now` down to every
// DashboardAgentRow. Previously each row instantiated its own interval,
// which meant N timers firing at staggered mount times for N rows on
// screen — turning one logical tick into N independent React commits.
export function useNow(intervalMs: number): number {
  const clock = getSharedNowClock(intervalMs)
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot)
}
