import { describe, expect, it, vi } from 'vitest'
import {
  AndroidTrackDevicesWatcher,
  buildTrackDevicesCommand,
  diffDeviceSnapshots,
  extractTrackDevicesSnapshots,
  parseDeviceSnapshotPayload,
  type AndroidTrackDevicesSink,
  type TrackDevicesChannel
} from './android-track-devices-watcher'

// host:track-devices frames a snapshot as a 4-hex length prefix + payload.
function frame(payload: string): string {
  return payload.length.toString(16).padStart(4, '0') + payload
}

class FakeChannel implements TrackDevicesChannel {
  private dataCbs: ((chunk: string) => void)[] = []
  private closeCbs: (() => void)[] = []
  // close() emits 'close' like a real channel, so tests exercise the late-event
  // stale-handler guard (an old channel's close must not tear down the new one).
  readonly close = vi.fn(() => this.emitClose())
  on(event: 'data', listener: (chunk: Buffer | Uint8Array | string) => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: string, listener: (...args: never[]) => void): this {
    if (event === 'data') {
      this.dataCbs.push(listener as never)
    }
    if (event === 'close') {
      this.closeCbs.push(listener as never)
    }
    return this
  }
  emit(chunk: string): void {
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

function recordingSink(): { sink: AndroidTrackDevicesSink; online: string[]; offline: string[] } {
  const online: string[] = []
  const offline: string[] = []
  return {
    online,
    offline,
    sink: {
      registerActiveEmulator: (serial) => online.push(serial),
      unregisterActiveEmulator: (serial) => offline.push(serial)
    }
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('track-devices pure parsing', () => {
  it('parses serial<TAB>state lines into a snapshot map', () => {
    const map = parseDeviceSnapshotPayload('127.0.0.1:5555\tdevice\nemulator-5554\toffline\n')
    expect(map.get('127.0.0.1:5555')).toBe('device')
    expect(map.get('emulator-5554')).toBe('offline')
  })

  it('extracts complete length-prefixed snapshots and keeps a partial tail buffered', () => {
    const full = frame('a\tdevice\n')
    const partial = '0009a\tdev'
    const { snapshots, rest } = extractTrackDevicesSnapshots(full + partial)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].get('a')).toBe('device')
    expect(rest).toBe(partial)
  })

  it('diffs online (newly attachable) and offline (no longer attachable) transitions', () => {
    const prev = new Map([['a', 'device']])
    const next = new Map([
      ['a', 'offline'],
      ['b', 'device']
    ])
    expect(diffDeviceSnapshots(prev, next)).toEqual({ online: ['b'], offline: ['a'] })
  })

  it('builds the escaped remote track-devices command', () => {
    expect(buildTrackDevicesCommand()).toBe("'adb' 'track-devices'")
  })
})

describe('AndroidTrackDevicesWatcher', () => {
  it('registers added devices and unregisters removed/offline ones', async () => {
    const channel = new FakeChannel()
    const { sink, online, offline } = recordingSink()
    const watcher = new AndroidTrackDevicesWatcher({
      openChannel: async () => channel,
      sink
    })
    watcher.start()
    await tick()

    channel.emit(frame('127.0.0.1:5555\tdevice\n'))
    channel.emit(frame('127.0.0.1:5555\tdevice\nemulator-5554\tdevice\n'))
    channel.emit(frame('emulator-5554\tdevice\n')) // 127.0.0.1:5555 dropped
    channel.emit(frame('emulator-5554\toffline\n')) // went offline

    expect(online).toEqual(['127.0.0.1:5555', 'emulator-5554'])
    expect(offline).toEqual(['127.0.0.1:5555', 'emulator-5554'])
    watcher.stop()
  })

  it('tears down the channel and ignores further data on stop (disconnect)', async () => {
    const channel = new FakeChannel()
    const { sink, online } = recordingSink()
    const watcher = new AndroidTrackDevicesWatcher({ openChannel: async () => channel, sink })
    watcher.start()
    await tick()
    watcher.stop()
    expect(channel.close).toHaveBeenCalled()
    channel.emit(frame('late\tdevice\n'))
    expect(online).toEqual([])
  })

  it('re-establishes a fresh channel on the injected reconnect signal', async () => {
    const channels = [new FakeChannel(), new FakeChannel()]
    let openCount = 0
    let fireReconnect: () => void = () => {}
    const { sink, online } = recordingSink()
    const watcher = new AndroidTrackDevicesWatcher({
      openChannel: async () => channels[openCount++],
      sink,
      onReconnect: (cb) => {
        fireReconnect = cb
        return () => {}
      }
    })
    watcher.start()
    await tick()
    channels[0].emit(frame('a\tdevice\n'))

    fireReconnect()
    await tick()
    expect(channels[0].close).toHaveBeenCalled()
    // The old channel's close() emitted 'close'; the new channel must survive it
    // and still deliver data (stale-handler guard). New full snapshot still
    // showing 'a' must not re-register it (carried state).
    channels[1].emit(frame('a\tdevice\nb\tdevice\n'))
    expect(online).toEqual(['a', 'b'])
    watcher.stop()
  })
})
