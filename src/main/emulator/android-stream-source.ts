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
  // Delay between a child exit and the respawn; injected so tests advance it
  // synchronously instead of waiting on a real timer.
  waitBeforeRestart?: () => Promise<void>
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
  const waitBeforeRestart =
    options.waitBeforeRestart ?? (() => delay(DEFAULT_RESTART_DELAY_MS))
  let stopped = false
  let activeChild: AndroidStreamChild | null = null

  async function* units(): AsyncGenerator<AndroidVideoUnit> {
    if (stopped) {
      return
    }
    try {
      while (!stopped) {
        const child = options.spawn()
        activeChild = child
        const framer = new AnnexBFramer()
        try {
          for await (const chunk of child.chunks) {
            if (stopped) {
              break
            }
            for (const au of framer.push(chunk)) {
              yield toAccessUnitMeta(au, pts)
            }
          }
          // Child exited; drain the segment's final access unit before restart so
          // it is never dropped.
          for (const au of framer.flush()) {
            yield toAccessUnitMeta(au, pts)
          }
        } finally {
          child.stop()
          if (activeChild === child) {
            activeChild = null
          }
        }
        if (stopped) {
          break
        }
        await waitBeforeRestart()
      }
    } finally {
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
