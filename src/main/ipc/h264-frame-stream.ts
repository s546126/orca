import type { AndroidStreamHandle, AndroidVideoUnit } from '../emulator/android-device-backend'
import type { FrameStream } from './frame-stream-contract'

// Per-access-unit metadata the renderer's WebCodecs decoder needs; absent on the
// iOS mjpeg path so that message stays byte-identical.
export type H264FrameMeta = {
  key: boolean
  ptsMicros: number
  width: number
  height: number
}

export type H264FrameStreamCallbacks = {
  onError: (message: string) => void
  onFrame: (bytes: ArrayBuffer, meta: H264FrameMeta) => void
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Copy: the source Uint8Array may be a view into a larger buffer, so sending
  // its .buffer would over-send adjacent NAL bytes.
  const arrayBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(arrayBuffer).set(bytes)
  return arrayBuffer
}

// Consumes an AndroidStreamHandle's access-unit iterable and forwards one unit per
// frame. The source already did NAL->access-unit framing, so each onFrame is one
// independently-decodable unit — preserving the renderer's per-message contract.
export class H264FrameStream implements FrameStream {
  private stopped = false
  private iterator: AsyncIterator<AndroidVideoUnit> | null = null

  constructor(
    private readonly handle: AndroidStreamHandle,
    private readonly callbacks: H264FrameStreamCallbacks
  ) {}

  start(): void {
    if (this.iterator) {
      return
    }
    // Fresh iterable per start so a renderer re-open respawns the source cleanly.
    this.iterator = this.handle.units()[Symbol.asyncIterator]()
    void this.pump(this.iterator)
  }

  stop(): void {
    this.stopped = true
    // Ends the units() generator (its finally stops that child); the handle's own
    // stop() on session teardown is what fully shuts the source down.
    void this.iterator?.return?.()
    this.iterator = null
  }

  private async pump(iterator: AsyncIterator<AndroidVideoUnit>): Promise<void> {
    try {
      while (!this.stopped) {
        const next = await iterator.next()
        if (next.done || this.stopped) {
          break
        }
        const unit = next.value
        this.callbacks.onFrame(copyToArrayBuffer(unit.data), {
          key: unit.key,
          ptsMicros: unit.ptsMicros,
          width: unit.width,
          height: unit.height
        })
      }
    } catch (error) {
      if (!this.stopped) {
        this.callbacks.onError(
          error instanceof Error ? error.message : 'H.264 stream error'
        )
      }
    }
  }
}
