import { describe, expect, it } from 'vitest'
import { parseSpsCodecBytes, parseSpsDimensions } from './h264-sps-dimensions'

// Bit writer mirror of the SPS bit layout so the fixture is constructed from
// explicit field values rather than hand-typed bytes — the expected dimensions
// are computed from those same fields, keeping the test self-checking.
class BitWriter {
  private bits: number[] = []
  writeBit(bit: number): void {
    this.bits.push(bit & 1)
  }
  writeBits(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.writeBit((value >> i) & 1)
    }
  }
  writeUe(value: number): void {
    const code = value + 1
    const length = Math.floor(Math.log2(code))
    for (let i = 0; i < length; i++) {
      this.writeBit(0)
    }
    this.writeBits(code, length + 1)
  }
  toBytes(): Uint8Array {
    const bytes: number[] = []
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0
      for (let j = 0; j < 8; j++) {
        byte = (byte << 1) | (this.bits[i + j] ?? 0)
      }
      bytes.push(byte)
    }
    return Uint8Array.from(bytes)
  }
}

// Build a baseline (profile 66) SPS NAL for a given mb width/height with no crop.
function buildBaselineSps(widthInMbs: number, heightInMbs: number): Uint8Array {
  const w = new BitWriter()
  w.writeUe(0) // seq_parameter_set_id
  w.writeUe(0) // log2_max_frame_num_minus4
  w.writeUe(0) // pic_order_cnt_type
  w.writeUe(0) // log2_max_pic_order_cnt_lsb_minus4
  w.writeUe(1) // max_num_ref_frames
  w.writeBit(0) // gaps_in_frame_num_value_allowed_flag
  w.writeUe(widthInMbs - 1) // pic_width_in_mbs_minus1
  w.writeUe(heightInMbs - 1) // pic_height_in_map_units_minus1
  w.writeBit(1) // frame_mbs_only_flag
  w.writeBit(1) // direct_8x8_inference_flag
  w.writeBit(0) // frame_cropping_flag
  w.writeBit(0) // vui_parameters_present_flag
  const payload = w.toBytes()
  // NAL header (type 7) + profile_idc(66) + constraint flags(0) + level_idc(40).
  return Uint8Array.from([0x67, 66, 0, 40, ...payload])
}

// Baseline SPS with frame_cropping_flag=1 — crop offsets are in chroma sample
// units (4:2:0 -> CropUnitX=CropUnitY=2 for frame_mbs_only). Real devices crop a
// 16-aligned coded picture down to e.g. 1080x2340, so this exercises the path
// most likely to mis-map taps on hardware.
function buildCroppedSps(
  widthInMbs: number,
  heightInMbs: number,
  crop: { left: number; right: number; top: number; bottom: number }
): Uint8Array {
  const w = new BitWriter()
  w.writeUe(0) // seq_parameter_set_id
  w.writeUe(0) // log2_max_frame_num_minus4
  w.writeUe(0) // pic_order_cnt_type
  w.writeUe(0) // log2_max_pic_order_cnt_lsb_minus4
  w.writeUe(1) // max_num_ref_frames
  w.writeBit(0) // gaps_in_frame_num_value_allowed_flag
  w.writeUe(widthInMbs - 1)
  w.writeUe(heightInMbs - 1)
  w.writeBit(1) // frame_mbs_only_flag
  w.writeBit(1) // direct_8x8_inference_flag
  w.writeBit(1) // frame_cropping_flag
  w.writeUe(crop.left)
  w.writeUe(crop.right)
  w.writeUe(crop.top)
  w.writeUe(crop.bottom)
  w.writeBit(0) // vui_parameters_present_flag
  return Uint8Array.from([0x67, 66, 0, 40, ...w.toBytes()])
}

// Encoder-side emulation-prevention: insert 0x03 after any 00 00 {00..03} run in
// the RBSP payload (the inverse of the parser's unescapeRbsp).
function escapeRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [nal[0]]
  let zeros = 0
  for (let i = 1; i < nal.length; i++) {
    const byte = nal[i]
    if (zeros >= 2 && byte <= 0x03) {
      out.push(0x03)
      zeros = 0
    }
    out.push(byte)
    zeros = byte === 0x00 ? zeros + 1 : 0
  }
  return Uint8Array.from(out)
}

describe('parseSpsDimensions', () => {
  it('parses cropped real-device dimensions (1080x2340 portrait)', () => {
    // 68 mbs -> 1088 coded, crop right 4 -> 1080; 147 mbs -> 2352, crop bottom 6 -> 2340.
    const sps = buildCroppedSps(68, 147, { left: 0, right: 4, top: 0, bottom: 6 })
    expect(parseSpsDimensions(sps)).toEqual({ width: 1080, height: 2340 })
  })

  it('strips emulation-prevention bytes before Exp-Golomb decoding', () => {
    // Append trailing zeros so the escaper is guaranteed to inject a 00 00 03 the
    // parser must strip; dimensions are read well before the trailing data.
    const base = buildCroppedSps(68, 147, { left: 0, right: 4, top: 0, bottom: 6 })
    const padded = Uint8Array.from([...base, 0x00, 0x00, 0x00])
    const escaped = escapeRbsp(padded)
    expect(escaped.length).toBeGreaterThan(padded.length) // a 0x03 was really inserted
    expect(parseSpsDimensions(escaped)).toEqual({ width: 1080, height: 2340 })
  })

  it('parses dimensions for an uncropped baseline SPS', () => {
    const widthInMbs = 68 // 1088 -> not a typical crop here, exact multiple of 16
    const heightInMbs = 120 // 1920
    const sps = buildBaselineSps(widthInMbs, heightInMbs)
    expect(parseSpsDimensions(sps)).toEqual({
      width: widthInMbs * 16,
      height: heightInMbs * 16
    })
  })

  it('parses standard 720x1280 portrait', () => {
    const sps = buildBaselineSps(45, 80)
    expect(parseSpsDimensions(sps)).toEqual({ width: 720, height: 1280 })
  })

  it('returns null for a too-short NAL', () => {
    expect(parseSpsDimensions(Uint8Array.of(0x67, 66))).toBeNull()
  })
})

describe('parseSpsCodecBytes', () => {
  it('reads profile/constraint/level for avc1 codec strings', () => {
    const sps = buildBaselineSps(45, 80)
    expect(parseSpsCodecBytes(sps)).toEqual({
      profileIdc: 66,
      constraintFlags: 0,
      levelIdc: 40
    })
  })
})
