import { MjpegFrameStream } from '../emulator/mjpeg-frame-stream'
import { androidStreamHandleRegistry } from './android-stream-handle-registry'
import { H264FrameStream, type H264FrameMeta } from './h264-frame-stream'
import type { FrameStream } from './frame-stream-contract'

export type MobileFrameStreamCallbacks = {
  onError: (message: string) => void
  // meta is present only for h264 access units; the mjpeg path omits it so the
  // renderer's existing per-frame message stays byte-identical.
  onFrame: (bytes: ArrayBuffer, meta?: H264FrameMeta) => void
}

export type CreateMobileFrameStreamArgs = {
  // Defaults to 'mjpeg' when absent so the iOS path is unchanged.
  streamKind?: 'mjpeg' | 'h264'
  // mjpeg: the serve-sim URL. h264: the streamId of a registered AndroidStreamHandle.
  streamUrl: string
  streamKey?: string
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(arrayBuffer).set(bytes)
  return arrayBuffer
}

// Branch the renderer-initiated frame stream by codec: mjpeg opens the serve-sim
// socket (iOS), h264 resolves the existing main-owned AndroidStreamHandle by id.
export function createMobileFrameStream(
  args: CreateMobileFrameStreamArgs,
  callbacks: MobileFrameStreamCallbacks
): FrameStream {
  if (args.streamKind === 'h264') {
    // TODO(phase4-ffmpeg-fallback): when the renderer's per-session WebCodecs gate
    // reports avc1 unsupported, transcode this handle's H.264 to MJPEG in main so
    // the renderer surface is unchanged. Correctness fallback only (re-inflates
    // bandwidth over SSH); not yet implemented.
    const handle = androidStreamHandleRegistry.get(args.streamUrl)
    if (!handle) {
      throw new Error(`No active Android stream handle for ${args.streamUrl}.`)
    }
    return new H264FrameStream(handle, {
      onError: callbacks.onError,
      onFrame: (bytes, meta) => callbacks.onFrame(bytes, meta)
    })
  }
  return new MjpegFrameStream(
    args.streamUrl,
    {
      onError: callbacks.onError,
      onFrame: (frame) => callbacks.onFrame(copyToArrayBuffer(frame))
    },
    args.streamKey
  )
}
