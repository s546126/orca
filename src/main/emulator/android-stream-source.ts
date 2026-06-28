import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { AnnexBFramer, type AccessUnit } from './h264-annexb-framing'
import { createPtsSynthesizer, type PtsSynthesizer } from './h264-pts-synthesizer'
import { ADB_PROGRAM } from './adb-android-devices'
import type { AndroidStreamHandle, AndroidVideoUnit } from './android-device-backend'

// screenrecord caps each capture at 180s, so the child *will* exit periodically;
// the source restarts it and a fresh capture re-emits SPS/PPS+IDR to re-sync the
// decoder. All process I/O is injected so tests feed crafted bytes and nothing
// spawns at import.
const SCREENRECORD_TIME_LIMIT_SECONDS = 180
const DEFAULT_RESTART_DELAY_MS = 250
// Backoff after a data-less (likely connection-down) restart, raced against an
// SSH reconnect signal so a transient drop resumes instead of burning the budget.
const DEFAULT_FAILURE_BACKOFF_MS = 500
// Bound consecutive data-less respawns: a permanently-gone SSH connection (relay
// lost for good) must end the source cleanly, not loop forever.
const DEFAULT_MAX_FAILED_RESTARTS = 5
// Used only until the first SPS arrives (screenrecord always leads with one).
const FALLBACK_WIDTH = 1080
const FALLBACK_HEIGHT = 1920

// One live byte source: a local screenrecord child today, or (Phase 5) an SSH
// exec channel. chunks ends when the underlying child exits.
export type AndroidStreamChild = {
  chunks: AsyncIterable<Uint8Array>
  stop(): void
}

export type AndroidStreamSpawner = () => AndroidStreamChild

export type AndroidStreamSourceOptions = {
  spawn: AndroidStreamSpawner
  streamId?: string
  fps?: number
  // Delay between a normal (data-producing) child exit and the respawn; injected
  // so tests advance it synchronously instead of waiting on a real timer.
  waitBeforeRestart?: () => Promise<void>
  // Phase 5: SSH exec channels do not survive a relay-lost/reconnect. A reconnect
  // signal both unblocks the failure backoff and resets the retry budget so the
  // source re-establishes the channel and re-keys (a fresh screenrecord always
  // leads with SPS/PPS+IDR). Returns an unsubscribe. Injected for tests.
  onReconnect?: (cb: () => void) => () => void
  // Backoff awaited after a data-less restart, raced against onReconnect. Injected.
  waitAfterFailure?: () => Promise<void>
  // Fires when the host is permanently unrecoverable (SSH terminal status); ends
  // the source cleanly. When provided, it — not a time budget — terminates the
  // remote source, so a long (30s+) reconnect window cannot prematurely kill the
  // stream. Returns an unsubscribe. Injected for tests.
  onUnrecoverable?: (cb: () => void) => () => void
  // Max consecutive data-less respawns before the source ends. Used as the bound
  // for the LOCAL path (no terminal signal); defaults to unbounded when
  // onUnrecoverable is provided, since that signal is the authoritative end.
  maxFailedRestarts?: number
}

// adb argv (after the program) for the local screenrecord H.264 source. Built
// here so it stays cross-platform (program resolved via PATH, never a posix path).
export function buildScreenrecordArgs(serial: string): string[] {
  return [
    '-s',
    serial,
    'exec-out',
    'screenrecord',
    '--output-format=h264',
    '--time-limit',
    String(SCREENRECORD_TIME_LIMIT_SECONDS),
    '-'
  ]
}

export function createLocalScreenrecordSpawner(serial: string): AndroidStreamSpawner {
  return () => {
    const child = spawn(ADB_PROGRAM, buildScreenrecordArgs(serial), { shell: false })
    // Prevent an unhandled 'error' (e.g. ENOENT) from crashing main; the stdout
    // iterator simply ends and the restart loop throttles via waitBeforeRestart.
    child.on('error', () => {})
    return {
      chunks: child.stdout as AsyncIterable<Uint8Array>,
      stop: () => {
        child.kill()
      }
    }
  }
}

function toAccessUnitMeta(au: AccessUnit, pts: PtsSynthesizer): AndroidVideoUnit {
  return {
    data: au.data,
    key: au.key,
    ptsMicros: pts.next(),
    width: au.width ?? FALLBACK_WIDTH,
    height: au.height ?? FALLBACK_HEIGHT
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createAndroidStreamSource(
  options: AndroidStreamSourceOptions
): AndroidStreamHandle {
  const streamId = options.streamId ?? randomUUID()
  // Owned at source scope so PTS stays monotonic across the 180s restart.
  const pts = createPtsSynthesizer(options.fps)
  const waitBeforeRestart = options.waitBeforeRestart ?? (() => delay(DEFAULT_RESTART_DELAY_MS))
  const waitAfterFailure = options.waitAfterFailure ?? (() => delay(DEFAULT_FAILURE_BACKOFF_MS))
  const maxFailedRestarts =
    options.maxFailedRestarts ??
    (options.onUnrecoverable ? Number.POSITIVE_INFINITY : DEFAULT_MAX_FAILED_RESTARTS)
  let stopped = false
  let activeChild: AndroidStreamChild | null = null

  async function* units(): AsyncGenerator<AndroidVideoUnit> {
    if (stopped) {
      return
    }
    let failures = 0
    let pendingReconnect = false
    let unrecoverable = false
    // Resolves an in-flight failure backoff early when a reconnect arrives.
    let resumeBackoff: (() => void) | null = null
    const unsubscribeReconnect = options.onReconnect?.(() => {
      // A reconnect means the channel is fresh again: drop the budget, force the
      // current (dead) child to end so the loop respawns, and unblock any backoff.
      failures = 0
      pendingReconnect = true
      activeChild?.stop()
      resumeBackoff?.()
    })
    const unsubscribeUnrecoverable = options.onUnrecoverable?.(() => {
      // Host permanently gone: end the source cleanly, unblocking any backoff.
      unrecoverable = true
      activeChild?.stop()
      resumeBackoff?.()
    })

    async function raceReconnectOrBackoff(): Promise<void> {
      if (pendingReconnect) {
        pendingReconnect = false
        return
      }
      await new Promise<void>((resolve) => {
        resumeBackoff = () => {
          resumeBackoff = null
          resolve()
        }
        void waitAfterFailure().then(() => resumeBackoff?.())
      })
      pendingReconnect = false
    }

    try {
      while (!stopped && !unrecoverable) {
        const child = options.spawn()
        activeChild = child
        const framer = new AnnexBFramer()
        let produced = 0
        try {
          for await (const chunk of child.chunks) {
            if (stopped) {
              break
            }
            for (const au of framer.push(chunk)) {
              produced++
              yield toAccessUnitMeta(au, pts)
            }
          }
          // Child exited; drain the segment's final access unit before restart so
          // it is never dropped.
          for (const au of framer.flush()) {
            produced++
            yield toAccessUnitMeta(au, pts)
          }
        } finally {
          child.stop()
          if (activeChild === child) {
            activeChild = null
          }
        }
        if (stopped || unrecoverable) {
          break
        }
        if (produced > 0) {
          // Normal 180s exit (or live segment): healthy, brief restart delay.
          failures = 0
          await waitBeforeRestart()
        } else {
          // A data-less segment means the channel is likely down; end the source
          // once the budget is exhausted, otherwise wait for a reconnect/backoff.
          failures++
          if (failures >= maxFailedRestarts) {
            break
          }
          await raceReconnectOrBackoff()
        }
      }
    } finally {
      unsubscribeReconnect?.()
      unsubscribeUnrecoverable?.()
      activeChild?.stop()
      activeChild = null
    }
  }

  return {
    streamId,
    streamKind: 'h264',
    units,
    stop: () => {
      stopped = true
      activeChild?.stop()
      activeChild = null
    }
  }
}
