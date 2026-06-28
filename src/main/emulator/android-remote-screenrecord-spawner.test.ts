import { describe, expect, it, vi } from 'vitest'
import {
  buildRemoteScreenrecordCommand,
  createRemoteScreenrecordSpawner,
  type RemoteExecChannel
} from './android-remote-screenrecord-spawner'
import { createAndroidStreamSource } from './android-stream-source'
import type { AndroidVideoUnit } from './android-device-backend'

// Fake ClientChannel-like emitter: buffers no events, so tests emit only after the
// spawner has subscribed (driven via a macrotask tick).
class FakeExecChannel implements RemoteExecChannel {
  private dataCbs: ((chunk: Buffer | Uint8Array) => void)[] = []
  private closeCbs: (() => void)[] = []
  private errorCbs: ((error: Error) => void)[] = []
  readonly close = vi.fn()
  readonly stderr = { on: vi.fn() }

  on(event: 'data', listener: (chunk: Buffer | Uint8Array) => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: string, listener: (...args: never[]) => void): this {
    if (event === 'data') {
      this.dataCbs.push(listener as never)
    }
    if (event === 'close') {
      this.closeCbs.push(listener as never)
    }
    if (event === 'error') {
      this.errorCbs.push(listener as never)
    }
    return this
  }
  emitData(chunk: Uint8Array): void {
    for (const cb of this.dataCbs) {
      cb(chunk)
    }
  }
  emitClose(): void {
    for (const cb of this.closeCbs) {
      cb()
    }
  }
}

function nal(type: number, ...extra: number[]): Uint8Array {
  return Uint8Array.from([0x40 | type, 0x11, 0x22, ...extra])
}
function sc4(body: Uint8Array): Uint8Array {
  return Uint8Array.from([0, 0, 0, 1, ...body])
}
function join(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((p) => Array.from(p)))
}
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const IDR = nal(5, 0xaa)
const P_FRAME = nal(1, 0xbb)

describe('buildRemoteScreenrecordCommand', () => {
  it('shellEscapes every token of the remote screenrecord command line', () => {
    expect(buildRemoteScreenrecordCommand('127.0.0.1:5555')).toBe(
      "'adb' '-s' '127.0.0.1:5555' 'exec-out' 'screenrecord' '--output-format=h264' '--time-limit' '180' '-'"
    )
  })
})

describe('createRemoteScreenrecordSpawner', () => {
  it('runs the escaped command over the injected exec and streams stdout chunks', async () => {
    const channel = new FakeExecChannel()
    const exec = vi.fn(async () => channel)
    const spawner = createRemoteScreenrecordSpawner(exec, '127.0.0.1:5555')
    const child = spawner()

    const collected: Uint8Array[] = []
    const drained = (async () => {
      for await (const chunk of child.chunks) {
        collected.push(chunk)
      }
    })()
    await tick() // exec resolves and the generator subscribes

    expect(exec).toHaveBeenCalledWith(buildRemoteScreenrecordCommand('127.0.0.1:5555'))
    channel.emitData(Uint8Array.from([1, 2, 3]))
    channel.emitData(Uint8Array.from([4, 5]))
    channel.emitClose() // close ends the chunk stream
    await drained
    expect(collected).toEqual([Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5])])
  })

  it('feeds AnnexBFramer through the stream source to yield the expected access units', async () => {
    const channel = new FakeExecChannel()
    const exec = vi.fn(async () => channel)
    const spawner = createRemoteScreenrecordSpawner(exec, '127.0.0.1:5555')
    const handle = createAndroidStreamSource({
      spawn: spawner,
      fps: 30,
      maxFailedRestarts: 1,
      waitAfterFailure: () => Promise.resolve()
    })

    const units: AndroidVideoUnit[] = []
    const drained = (async () => {
      for await (const unit of handle.units()) {
        units.push(unit)
        if (units.length >= 2) {
          handle.stop()
          break
        }
      }
    })()
    await tick()
    channel.emitData(join(sc4(IDR), sc4(P_FRAME)))
    channel.emitClose() // flush drains the trailing P-frame
    await drained
    expect(units.map((u) => u.key)).toEqual([true, false])
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('ends the chunk stream cleanly when the exec rejects (connection down)', async () => {
    const exec = vi.fn(async () => {
      throw new Error('Not connected')
    })
    const spawner = createRemoteScreenrecordSpawner(exec, '127.0.0.1:5555')
    const child = spawner()
    const collected: Uint8Array[] = []
    for await (const chunk of child.chunks) {
      collected.push(chunk)
    }
    expect(collected).toEqual([])
  })

  it('closes the channel on stop()', async () => {
    const channel = new FakeExecChannel()
    const spawner = createRemoteScreenrecordSpawner(async () => channel, '127.0.0.1:5555')
    const child = spawner()
    const drained = (async () => {
      for await (const _chunk of child.chunks) {
        /* drain */
      }
    })()
    await tick()
    child.stop()
    channel.emitClose()
    await drained
    expect(channel.close).toHaveBeenCalled()
  })
})
