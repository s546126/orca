import { describe, expect, it } from 'vitest'
import {
  buildScreenrecordArgs,
  createAndroidStreamSource,
  type AndroidStreamChild
} from './android-stream-source'
import type { AndroidVideoUnit } from './android-device-backend'

function nal(type: number, ...extra: number[]): Uint8Array {
  return Uint8Array.from([0x40 | type, 0x11, 0x22, ...extra])
}
function sc4(body: Uint8Array): Uint8Array {
  return Uint8Array.from([0, 0, 0, 1, ...body])
}
function join(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((p) => Array.from(p)))
}

const IDR = nal(5, 0xaa)
const P_FRAME = nal(1, 0xbb)

function makeChild(chunks: Uint8Array[]): AndroidStreamChild {
  return {
    chunks: (async function* () {
      for (const chunk of chunks) {
        yield chunk
      }
    })(),
    stop: () => {}
  }
}

async function collect(
  handle: ReturnType<typeof createAndroidStreamSource>,
  count: number
): Promise<AndroidVideoUnit[]> {
  const units: AndroidVideoUnit[] = []
  for await (const unit of handle.units()) {
    units.push(unit)
    if (units.length >= count) {
      handle.stop()
      break
    }
  }
  return units
}

describe('createAndroidStreamSource', () => {
  it('builds the local screenrecord adb argv', () => {
    expect(buildScreenrecordArgs('127.0.0.1:5555')).toEqual([
      '-s',
      '127.0.0.1:5555',
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      '--time-limit',
      '180',
      '-'
    ])
  })

  it('yields one access unit per picture with synthesized monotonic PTS', async () => {
    const child = makeChild([join(sc4(IDR), sc4(P_FRAME), sc4(P_FRAME))])
    const handle = createAndroidStreamSource({
      spawn: () => child,
      waitBeforeRestart: () => Promise.resolve(),
      fps: 30
    })
    const units = await collect(handle, 3)
    expect(units.map((u) => u.key)).toEqual([true, false, false])
    const step = Math.round(1_000_000 / 30)
    expect(units.map((u) => u.ptsMicros)).toEqual([0, step, step * 2])
    // No SPS in the crafted bytes, so dimensions fall back until one arrives.
    expect(units[0].width).toBe(1080)
    expect(units[0].height).toBe(1920)
  })

  it('restarts the child on exit and re-keys, keeping PTS monotonic', async () => {
    let spawnCount = 0
    const handle = createAndroidStreamSource({
      spawn: () => {
        spawnCount++
        // Each capture leads with a keyframe; the second models the post-restart
        // re-key after screenrecord's 180s cap.
        return makeChild([sc4(IDR)])
      },
      waitBeforeRestart: () => Promise.resolve(),
      fps: 30
    })
    const units = await collect(handle, 2)
    expect(spawnCount).toBe(2)
    expect(units.map((u) => u.key)).toEqual([true, true])
    const step = Math.round(1_000_000 / 30)
    expect(units.map((u) => u.ptsMicros)).toEqual([0, step])
  })

  it('re-establishes the channel and re-emits a keyframe on an injected reconnect signal', async () => {
    let fireReconnect: () => void = () => {}
    let spawnCount = 0
    // A hung child models a dead SSH exec channel that never emits its own
    // 'close' after relay-lost; only the reconnect-driven stop() ends it.
    function hangingChild(onPulled: () => void): AndroidStreamChild {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return {
        chunks: (async function* () {
          onPulled()
          await gate
          // Dead channel: never emits before stop() releases the gate.
          yield* []
        })(),
        stop: () => release()
      }
    }
    const handle = createAndroidStreamSource({
      spawn: () => {
        const isFirst = spawnCount++ === 0
        // First capture hangs until the reconnect signal stops it; the post-
        // reconnect capture leads with a fresh keyframe, as screenrecord does.
        return isFirst ? hangingChild(() => fireReconnect()) : makeChild([sc4(IDR)])
      },
      onReconnect: (cb) => {
        fireReconnect = cb
        return () => {}
      },
      waitAfterFailure: () => Promise.resolve(),
      waitBeforeRestart: () => Promise.resolve(),
      fps: 30
    })
    const units = await collect(handle, 1)
    expect(spawnCount).toBe(2)
    expect(units.map((u) => u.key)).toEqual([true])
  })

  it('ends cleanly without an infinite loop when the connection is permanently gone', async () => {
    let spawnCount = 0
    const handle = createAndroidStreamSource({
      // Every respawn yields no data (exec keeps rejecting): a permanently-dead
      // connection. The source must bound retries and end, not loop forever.
      spawn: () => {
        spawnCount++
        return makeChild([])
      },
      maxFailedRestarts: 3,
      waitAfterFailure: () => Promise.resolve(),
      waitBeforeRestart: () => Promise.resolve()
    })
    const units: AndroidVideoUnit[] = []
    for await (const unit of handle.units()) {
      units.push(unit)
    }
    expect(units).toEqual([])
    expect(spawnCount).toBe(3)
  })

  it('keeps retrying past the local budget and ends only on the unrecoverable signal', async () => {
    let spawnCount = 0
    let fireGone: () => void = () => {}
    const handle = createAndroidStreamSource({
      // Every respawn is data-less (SSH down during a long reconnect window). With
      // an unrecoverable signal injected, the time budget must NOT terminate the
      // source — only the terminal signal does, well past the default budget of 5.
      spawn: () => {
        spawnCount++
        if (spawnCount === 8) {
          fireGone()
        }
        return makeChild([])
      },
      onUnrecoverable: (cb) => {
        fireGone = cb
        return () => {}
      },
      waitAfterFailure: () => Promise.resolve(),
      waitBeforeRestart: () => Promise.resolve()
    })
    const units: AndroidVideoUnit[] = []
    for await (const unit of handle.units()) {
      units.push(unit)
    }
    expect(units).toEqual([])
    expect(spawnCount).toBe(8)
  })

  it('stops without spawning when already stopped', async () => {
    let spawnCount = 0
    const handle = createAndroidStreamSource({
      spawn: () => {
        spawnCount++
        return makeChild([sc4(IDR)])
      },
      waitBeforeRestart: () => Promise.resolve()
    })
    handle.stop()
    const units: AndroidVideoUnit[] = []
    for await (const unit of handle.units()) {
      units.push(unit)
    }
    expect(units).toEqual([])
    expect(spawnCount).toBe(0)
  })
})
