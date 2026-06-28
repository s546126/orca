import { shellEscape } from '../ssh/ssh-connection-utils'
import { ADB_PROGRAM } from './adb-android-devices'

// Why: auto-attach parity with serveSimStateWatcher for Android. `adb
// track-devices` is a long-lived adb-server stream that pushes a FULL device
// snapshot on every change. It is SCOPED to one host's SSH connection lifecycle
// (started on connect, torn down on disconnect, re-established on reconnect) —
// never a process-global watcher started at import. Channel + reconnect signal
// are injected so the parser and lifecycle test without adb or a socket.

const ATTACHABLE_STATE = 'device'

// host:track-devices frames each snapshot as a 4-hex length prefix followed by
// that many bytes of `serial<TAB>state\n` lines. Extract every COMPLETE snapshot
// in the buffer and return the unconsumed tail (a partial frame split across
// channel reads stays buffered for the next chunk).
export function extractTrackDevicesSnapshots(buffer: string): {
  snapshots: Map<string, string>[]
  rest: string
} {
  const snapshots: Map<string, string>[] = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const lengthHex = buffer.slice(offset, offset + 4)
    const payloadLength = Number.parseInt(lengthHex, 16)
    if (!Number.isFinite(payloadLength) || /[^0-9a-fA-F]/.test(lengthHex)) {
      // Not a length-prefixed frame; stop and keep the rest for the next read.
      break
    }
    const payloadStart = offset + 4
    if (payloadStart + payloadLength > buffer.length) {
      break // incomplete frame
    }
    snapshots.push(parseDeviceSnapshotPayload(buffer.slice(payloadStart, payloadStart + payloadLength)))
    offset = payloadStart + payloadLength
  }
  return { snapshots, rest: buffer.slice(offset) }
}

// Pure: `serial<TAB or spaces>state` lines -> serial->state. Blank lines ignored.
export function parseDeviceSnapshotPayload(payload: string): Map<string, string> {
  const devices = new Map<string, string>()
  for (const rawLine of payload.split('\n')) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    const [serial, state = ''] = line.split(/\s+/)
    if (serial) {
      devices.set(serial, state)
    }
  }
  return devices
}

// Pure transition diff. online: serials newly attachable (added or offline->device).
// offline: serials that were attachable and now are absent or non-'device'.
export function diffDeviceSnapshots(
  prev: Map<string, string>,
  next: Map<string, string>
): { online: string[]; offline: string[] } {
  const online: string[] = []
  const offline: string[] = []
  for (const [serial, state] of next) {
    if (state === ATTACHABLE_STATE && prev.get(serial) !== ATTACHABLE_STATE) {
      online.push(serial)
    }
  }
  for (const [serial, state] of prev) {
    if (state === ATTACHABLE_STATE && next.get(serial) !== ATTACHABLE_STATE) {
      offline.push(serial)
    }
  }
  return { online, offline }
}

// Remote track-devices command line (POSIX; the redroid host is always Linux).
export function buildTrackDevicesCommand(): string {
  return [ADB_PROGRAM, 'track-devices'].map(shellEscape).join(' ')
}

// Minimal channel slice: 'data' chunks (Buffer or string), 'close'/'error', and
// close(). Matches ssh2's ClientChannel (conn.exec) and a local child wrapper.
export type TrackDevicesChannel = {
  on(event: 'data', listener: (chunk: Buffer | Uint8Array | string) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  close(): void
}

export type AndroidTrackDevicesSink = {
  // A device became attachable: auto-attach parity with serveSimStateWatcher's
  // registerActiveEmulator sink (index.ts maps serial -> worktree/session info).
  registerActiveEmulator(serial: string): void
  // A device disappeared or went offline.
  unregisterActiveEmulator(serial: string): void
}

export type AndroidTrackDevicesWatcherOptions = {
  openChannel: () => Promise<TrackDevicesChannel>
  sink: AndroidTrackDevicesSink
  // Re-establish the channel after an SSH reconnect (the prior channel died with
  // the relay). Injected; returns an unsubscribe.
  onReconnect?: (cb: () => void) => () => void
}

export class AndroidTrackDevicesWatcher {
  private readonly options: AndroidTrackDevicesWatcherOptions
  private channel: TrackDevicesChannel | null = null
  private unsubscribeReconnect: (() => void) | null = null
  private buffer = ''
  // Carried across reconnect so a fresh full snapshot does not re-register
  // already-known devices.
  private lastSnapshot = new Map<string, string>()
  private stopped = false

  constructor(options: AndroidTrackDevicesWatcherOptions) {
    this.options = options
  }

  start(): void {
    if (this.stopped || this.unsubscribeReconnect || this.channel) {
      return
    }
    this.unsubscribeReconnect = this.options.onReconnect?.(() => this.reestablish()) ?? null
    void this.openAndBind()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribeReconnect?.()
    this.unsubscribeReconnect = null
    this.closeChannel()
  }

  private reestablish(): void {
    if (this.stopped) {
      return
    }
    this.closeChannel()
    this.buffer = ''
    void this.openAndBind()
  }

  private async openAndBind(): Promise<void> {
    let channel: TrackDevicesChannel
    try {
      channel = await this.options.openChannel()
    } catch {
      return // host down; the reconnect signal will retry.
    }
    if (this.stopped) {
      channel.close()
      return
    }
    this.channel = channel
    // Guard every handler on channel identity: after a reconnect re-establishes a
    // fresh channel, a late 'close'/'data' from the OLD channel must not tear down
    // or corrupt the new one (mirrors SshConnection.setupDisconnectHandler).
    channel.on('data', (chunk) => {
      if (this.channel === channel) {
        this.ingest(toText(chunk))
      }
    })
    channel.on('error', () => {
      if (this.channel === channel) {
        this.closeChannel()
      }
    })
    channel.on('close', () => {
      if (this.channel === channel) {
        this.closeChannel()
      }
    })
  }

  private closeChannel(): void {
    const channel = this.channel
    this.channel = null
    channel?.close()
  }

  private ingest(text: string): void {
    if (this.stopped) {
      return
    }
    this.buffer += text
    const { snapshots, rest } = extractTrackDevicesSnapshots(this.buffer)
    this.buffer = rest
    for (const snapshot of snapshots) {
      const { online, offline } = diffDeviceSnapshots(this.lastSnapshot, snapshot)
      this.lastSnapshot = snapshot
      for (const serial of online) {
        this.options.sink.registerActiveEmulator(serial)
      }
      for (const serial of offline) {
        this.options.sink.unregisterActiveEmulator(serial)
      }
    }
  }
}

function toText(chunk: Buffer | Uint8Array | string): string {
  if (typeof chunk === 'string') {
    return chunk
  }
  return Buffer.from(chunk).toString('utf-8')
}
