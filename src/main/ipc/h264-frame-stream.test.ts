import { describe, expect, it, vi } from 'vitest'
import { H264FrameStream, type H264FrameMeta } from './h264-frame-stream'
import type { AndroidStreamHandle, AndroidVideoUnit } from '../emulator/android-device-backend'

function unit(key: boolean, ptsMicros: number, ...bytes: number[]): AndroidVideoUnit {
  return { data: Uint8Array.from(bytes), key, ptsMicros, width: 720, height: 1280 }
}

// A handle whose units() yields the given access units once, then ends. `stopped`
// lets a test assert the loop terminates without draining everything.
function handleOf(units: AndroidVideoUnit[]): {
  handle: AndroidStreamHandle
  stop: () => void
} {
  let cancelled = false
  return {
    stop: () => {
      cancelled = true
    },
    handle: {
      streamId: 'stream-x',
      streamKind: 'h264',
      units: async function* () {
        for (const u of units) {
          if (cancelled) {
            return
          }
          yield u
        }
      },
      stop: vi.fn(() => {
        cancelled = true
      })
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('H264FrameStream', () => {
  it('emits one onFrame per access unit with metadata', async () => {
    const { handle } = handleOf([unit(true, 0, 1, 2, 3), unit(false, 33333, 4, 5)])
    const frames: { bytes: ArrayBuffer; meta: H264FrameMeta }[] = []
    const stream = new H264FrameStream(handle, {
      onError: vi.fn(),
      onFrame: (bytes, meta) => frames.push({ bytes, meta })
    })
    stream.start()
    await flushMicrotasks()
    expect(frames).toHaveLength(2)
    expect(new Uint8Array(frames[0].bytes)).toEqual(Uint8Array.from([1, 2, 3]))
    expect(frames[0].meta).toEqual({ key: true, ptsMicros: 0, width: 720, height: 1280 })
    expect(frames[1].meta.key).toBe(false)
    expect(frames[1].meta.ptsMicros).toBe(33333)
  })

  it('stops the consumption loop on stop()', async () => {
    // Endless source: without stop() the loop never terminates.
    const endless: AndroidStreamHandle = {
      streamId: 'stream-endless',
      streamKind: 'h264',
      units: async function* () {
        let pts = 0
        while (true) {
          yield unit(false, pts, 9)
          pts += 1
          await Promise.resolve()
        }
      },
      stop: vi.fn()
    }
    let count = 0
    const stream = new H264FrameStream(endless, {
      onError: vi.fn(),
      onFrame: () => {
        count++
      }
    })
    stream.start()
    await flushMicrotasks()
    const countAtStop = count
    stream.stop()
    await flushMicrotasks()
    // After stop, the loop must not keep emitting unboundedly.
    expect(count).toBeLessThanOrEqual(countAtStop + 1)
  })
})
