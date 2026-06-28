import { Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { useEmulatorVideoStream } from './use-emulator-video-stream'
import { translate } from '@/i18n/i18n'

type StreamSize = { height: number; width: number }

type EmulatorH264StreamCanvasProps = {
  loading: boolean
  onStreamError: () => void
  onStreamSize: (size: StreamSize) => void
  // The streamId of the main-owned AndroidStreamHandle (carried in previewUrl).
  streamId?: string
  showStream: boolean
  streamError: boolean
  streamKey?: string
}

export function EmulatorH264StreamCanvas({
  loading,
  onStreamError,
  onStreamSize,
  streamId,
  showStream,
  streamError,
  streamKey
}: EmulatorH264StreamCanvasProps) {
  const video = useEmulatorVideoStream(streamId, streamKey, showStream && Boolean(streamId))

  useEffect(() => {
    if (video.error) {
      onStreamError()
    }
  }, [video.error, onStreamError])

  useEffect(() => {
    if (video.streamSize) {
      onStreamSize(video.streamSize)
    }
  }, [video.streamSize, onStreamSize])

  // WebCodecs avc1 unsupported on this Electron/OS/hardware: the ffmpeg-transcode
  // fallback (main-side, TODO) would re-inflate the stream as mjpeg. Until then,
  // surface actionable copy rather than a frozen canvas.
  if (showStream && video.status === 'unsupported') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/20 px-6 text-center text-muted-foreground">
        <span className="text-xs">
          {translate(
            'auto.components.emulator.pane.emulator.h264.canvas.unsupported',
            'Hardware H.264 decoding is unavailable on this device.'
          )}
        </span>
      </div>
    )
  }

  const decoding = showStream && video.status === 'decoding'
  const waitingForFrame = showStream && !video.error && !decoding
  const displayError = streamError || Boolean(video.error)

  return (
    <div className="relative h-full w-full bg-black">
      <canvas
        ref={video.canvasRef}
        className="block h-full w-full bg-black object-contain"
        style={{ visibility: decoding ? 'visible' : 'hidden' }}
      />
      {decoding ? null : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted/20 text-muted-foreground">
          {loading || waitingForFrame ? (
            <>
              <Loader2 className="size-6 animate-spin text-primary" />
              <span className="text-xs">
                {translate(
                  'auto.components.emulator.pane.emulator.h264.canvas.connecting',
                  'Connecting emulator…'
                )}
              </span>
            </>
          ) : displayError ? (
            <span className="px-6 text-center text-xs">
              {translate(
                'auto.components.emulator.pane.emulator.h264.canvas.disconnected',
                'Stream disconnected'
              )}
            </span>
          ) : (
            <span className="px-6 text-center text-xs">
              {translate(
                'auto.components.emulator.pane.emulator.h264.canvas.preview',
                'Emulator preview'
              )}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
