import { describe, expect, it } from 'vitest'
import { AnnexBFramer } from './h264-annexb-framing'

// Minimal Exp-Golomb SPS builder so dimension assertions derive from explicit
// field values, not hand-typed bytes. Baseline profile (66), no cropping.
function buildSps(widthInMbs: number, heightInMbs: number): Uint8Array {
  const bits: number[] = []
  const writeBit = (b: number) => bits.push(b & 1)
  const writeBits = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) {
      writeBit((value >> i) & 1)
    }
  }
  const writeUe = (value: number) => {
    const code = value + 1
    const length = Math.floor(Math.log2(code))
    for (let i = 0; i < length; i++) {
      writeBit(0)
    }
    writeBits(code, length + 1)
  }
  writeUe(0) // seq_parameter_set_id
  writeUe(0) // log2_max_frame_num_minus4
  writeUe(0) // pic_order_cnt_type
  writeUe(0) // log2_max_pic_order_cnt_lsb_minus4
  writeUe(1) // max_num_ref_frames
  writeBit(0) // gaps_in_frame_num_value_allowed_flag
  writeUe(widthInMbs - 1)
  writeUe(heightInMbs - 1)
  writeBit(1) // frame_mbs_only_flag
  writeBit(1) // direct_8x8_inference_flag
  writeBit(0) // frame_cropping_flag
  writeBit(0) // vui_parameters_present_flag
  const payload: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | (bits[i + j] ?? 0)
    }
    payload.push(byte)
  }
  return Uint8Array.from([0x67, 66, 0, 40, ...payload])
}

const SPS_720x1280 = buildSps(45, 80)
const PPS = Uint8Array.of(0x68, 0xce, 0x3c, 0x80)

// A NAL of the given type with a couple of payload bytes (kept non-zero so the
// trailing-zero strip never eats real content).
function nal(type: number, ...extra: number[]): Uint8Array {
  return Uint8Array.from([0x40 | type, 0x11, 0x22, ...extra])
}

function sc4(body: Uint8Array): Uint8Array {
  return Uint8Array.from([0, 0, 0, 1, ...body])
}
function sc3(body: Uint8Array): Uint8Array {
  return Uint8Array.from([0, 0, 1, ...body])
}
function join(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((p) => Array.from(p)))
}

const IDR = nal(5, 0xaa, 0xbb)
const P_FRAME = nal(1, 0xcc, 0xdd)

describe('AnnexBFramer', () => {
  it('frames a single SPS+PPS+IDR access unit, completed by flush', () => {
    const framer = new AnnexBFramer()
    const stream = join(sc4(SPS_720x1280), sc4(PPS), sc4(IDR))
    expect(framer.push(stream)).toEqual([])
    const flushed = framer.flush()
    expect(flushed).toHaveLength(1)
    expect(flushed[0].key).toBe(true)
    expect(flushed[0].width).toBe(720)
    expect(flushed[0].height).toBe(1280)
  })

  it('emits one access unit per picture across multiple frames', () => {
    const framer = new AnnexBFramer()
    const stream = join(
      sc4(SPS_720x1280),
      sc4(PPS),
      sc4(IDR),
      sc4(P_FRAME),
      sc4(nal(1, 0xee))
    )
    // The IDR's AU is closed only when the first P-frame's start code is consumed;
    // the two P-frame AUs close on the trailing flush.
    const pushed = framer.push(stream)
    expect(pushed).toHaveLength(1)
    expect(pushed[0].key).toBe(true)
    const flushed = framer.flush()
    expect(flushed).toHaveLength(2)
    expect(flushed[0].key).toBe(false)
    expect(flushed[1].key).toBe(false)
  })

  it('classifies a non-IDR slice as a delta access unit', () => {
    const framer = new AnnexBFramer()
    framer.push(join(sc4(P_FRAME), sc4(P_FRAME)))
    const flushed = framer.flush()
    expect(flushed.at(-1)?.key).toBe(false)
  })

  it('reassembles a 4-byte start code split across two chunks', () => {
    const framer = new AnnexBFramer()
    const stream = join(sc4(SPS_720x1280), sc4(PPS), sc4(IDR))
    // Split inside the IDR's 4-byte start code: "…00 00" | "00 01…".
    const splitAt = stream.length - IDR.length - 2
    expect(framer.push(stream.subarray(0, splitAt))).toEqual([])
    expect(framer.push(stream.subarray(splitAt))).toEqual([])
    const flushed = framer.flush()
    expect(flushed).toHaveLength(1)
    expect(flushed[0].key).toBe(true)
    expect(flushed[0].width).toBe(720)
  })

  it('reassembles a 3-byte start code split across two chunks', () => {
    const framer = new AnnexBFramer()
    const stream = join(sc3(SPS_720x1280), sc3(PPS), sc3(IDR), sc3(P_FRAME))
    // Split inside the P-frame's 3-byte start code: "…00 00" | "1 …".
    const splitAt = stream.length - P_FRAME.length - 1
    expect(framer.push(stream.subarray(0, splitAt))).toEqual([])
    expect(framer.push(stream.subarray(splitAt))).toEqual([])
    const flushed = framer.flush()
    expect(flushed).toHaveLength(2)
    expect(flushed[0].key).toBe(true)
    expect(flushed[0].width).toBe(720)
    expect(flushed[1].key).toBe(false)
  })

  it('buffers a trailing partial NAL until the next chunk', () => {
    const framer = new AnnexBFramer()
    // Feed SPS + PPS, then the IDR start code + header arrives in a later chunk.
    expect(framer.push(join(sc4(SPS_720x1280), sc4(PPS)))).toEqual([])
    expect(framer.push(sc4(IDR))).toEqual([])
    const flushed = framer.flush()
    expect(flushed).toHaveLength(1)
    expect(flushed[0].key).toBe(true)
  })
})
