// Pure monotonic PTS synthesis. screenrecord emits no container timestamps, but
// WebCodecs needs a strictly increasing presentation time per EncodedVideoChunk.
// We derive one from a fixed cadence. The synthesizer is owned at stream-source
// scope (not per child), so timestamps keep increasing across the 180s restart
// and the decoder never sees time go backwards.

const DEFAULT_FPS = 30
const MICROS_PER_SECOND = 1_000_000

export type PtsSynthesizer = {
  // Micros for the next access unit, advancing by one frame interval each call.
  next(): number
}

export function createPtsSynthesizer(fps: number = DEFAULT_FPS): PtsSynthesizer {
  const effectiveFps = fps > 0 ? fps : DEFAULT_FPS
  const intervalMicros = Math.round(MICROS_PER_SECOND / effectiveFps)
  let nextPts = 0
  return {
    next(): number {
      const value = nextPts
      nextPts += intervalMicros
      return value
    }
  }
}
