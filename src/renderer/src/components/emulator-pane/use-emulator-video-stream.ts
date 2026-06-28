import { useEffect, useRef, useState, type RefObject } from 'react'
import { codecStringFromAccessUnit } from './h264-decoder-config'

// WebCodecs H.264 consumer: decode the main-framed access units into <canvas>
// paints. This module can only be typechecked here (no DOM/VideoDecoder at
// runtime), so all reusable byte logic lives in h264-decoder-config.ts.

type StreamSize = { width: number; height: number }

export type EmulatorVideoStreamState = {
  error: string | null
  streamSize: StreamSize | null
  // 'pending' before the first key frame; 'decoding' once painting; 'unsupported'
  // when WebCodecs avc1 is unavailable and the ffmpeg-transcode fallback applies.
  status: 'pending' | 'decoding' | 'unsupported'
}

type FrameMeta = { key: boolean; ptsMicros: number; width: number; height: number }

async function isAvcSupported(codec: string): Promise<boolean> {
  // Guard environments without WebCodecs (older Electron/OS/hardware).
  if (typeof VideoDecoder === 'undefined') {
    return false
  }
  try {
    const support = await VideoDecoder.isConfigSupported({ codec })
    return Boolean(support.supported)
  } catch {
    return false
  }
}

export function useEmulatorVideoStream(
  streamId: string | undefined,
  streamKey: string | undefined,
  enabled: boolean
): EmulatorVideoStreamState & { canvasRef: RefObject<HTMLCanvasElement | null> } {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [state, setState] = useState<EmulatorVideoStreamState>({
    error: null,
    streamSize: null,
    status: 'pending'
  })

  useEffect(() => {
    const emulatorApi = window.api?.emulator
    if (!enabled || !streamId || !emulatorApi?.startFrameStream) {
      setState({ error: null, streamSize: null, status: 'pending' })
      return
    }

    let disposed = false
    let activeStreamId: string | null = null
    let decoder: VideoDecoder | null = null
    let configuredCodec: string | null = null
    let sawKeyFrame = false
    let currentSize: StreamSize | null = null

    const paintFrame = (frame: VideoFrame): void => {
      const canvas = canvasRef.current
      const context = canvas?.getContext('2d')
      if (canvas && context) {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth
          canvas.height = frame.displayHeight
        }
        context.drawImage(frame, 0, 0)
      }
      // Release the GPU-backed frame promptly to avoid decoder back-pressure.
      frame.close()
    }

    const ensureDecoder = (codec: string): VideoDecoder | null => {
      if (decoder && configuredCodec === codec) {
        return decoder
      }
      // Rotation/restart changes the SPS; reconfigure against the new codec.
      if (decoder) {
        try {
          decoder.close()
        } catch {}
        decoder = null
      }
      const next = new VideoDecoder({
        output: paintFrame,
        error: (err) => {
          if (!disposed) {
            setState((current) => ({ ...current, error: err.message || 'Decoder error' }))
          }
        }
      })
      // No `description`: chunks are Annex-B (start-code framed), not avcC.
      next.configure({ codec })
      decoder = next
      configuredCodec = codec
      return next
    }

    const handleFrame = (bytes: ArrayBuffer, meta: FrameMeta): void => {
      // Feeding a delta before the first keyframe errors the decoder; drop until
      // a key arrives (also true right after a restart re-key).
      if (!meta.key && !sawKeyFrame) {
        return
      }
      const data = new Uint8Array(bytes)
      const codec = meta.key ? codecStringFromAccessUnit(data) : configuredCodec
      const active = ensureDecoder(codec ?? '')
      if (!active) {
        return
      }
      sawKeyFrame = sawKeyFrame || meta.key
      if (!currentSize || currentSize.width !== meta.width || currentSize.height !== meta.height) {
        currentSize = { width: meta.width, height: meta.height }
        setState((current) => ({ ...current, streamSize: currentSize, status: 'decoding' }))
      }
      try {
        active.decode(
          new EncodedVideoChunk({
            type: meta.key ? 'key' : 'delta',
            timestamp: meta.ptsMicros,
            data
          })
        )
      } catch (err) {
        if (!disposed) {
          setState((current) => ({
            ...current,
            error: err instanceof Error ? err.message : 'Decode failed'
          }))
        }
      }
    }

    const unsubscribeFrame = emulatorApi.onFrameStreamFrame?.(({ streamId: id, bytes, meta }) => {
      if (disposed || id !== activeStreamId || !meta) {
        return
      }
      handleFrame(bytes, meta)
    })
    const unsubscribeError = emulatorApi.onFrameStreamError?.(({ streamId: id, message }) => {
      if (!disposed && id === activeStreamId) {
        setState((current) => ({ ...current, error: message || 'Stream disconnected' }))
      }
    })

    setState({ error: null, streamSize: null, status: 'pending' })
    void (async () => {
      // Per-session runtime gate. On unsupported avc1 we surface the fallback
      // branch; the ffmpeg-transcode path itself is a main-side TODO.
      const supported = await isAvcSupported(codecStringFromAccessUnit(new Uint8Array()))
      if (disposed) {
        return
      }
      if (!supported) {
        setState({ error: null, streamSize: null, status: 'unsupported' })
        return
      }
      try {
        const { streamId: id } = await emulatorApi.startFrameStream({
          streamUrl: streamId,
          streamKey,
          streamKind: 'h264'
        })
        if (disposed) {
          void emulatorApi.stopFrameStream?.({ streamId: id })
          return
        }
        activeStreamId = id
      } catch (err) {
        if (!disposed) {
          setState({
            error: err instanceof Error ? err.message : 'Stream disconnected',
            streamSize: null,
            status: 'pending'
          })
        }
      }
    })()

    return () => {
      disposed = true
      unsubscribeFrame?.()
      unsubscribeError?.()
      if (activeStreamId) {
        void emulatorApi.stopFrameStream?.({ streamId: activeStreamId })
      }
      if (decoder) {
        try {
          decoder.close()
        } catch {}
        decoder = null
      }
    }
  }, [enabled, streamId, streamKey])

  return { ...state, canvasRef }
}
