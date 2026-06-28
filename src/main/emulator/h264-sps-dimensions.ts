// Pure H.264 SPS parsing: extract coded picture dimensions (and the codec
// profile/level bytes) from a single SPS NAL. screenrecord bakes resolution into
// the SPS, so the stream source reads it here rather than guessing. No I/O.

// Why: the input NAL keeps its 1-byte header (used for type classification), so
// every reader skips byte 0 before touching profile/level/RBSP payload.
const NAL_HEADER_BYTES = 1

export type SpsDimensions = {
  width: number
  height: number
}

// avc1.PPCCLL codec bytes — profile_idc, constraint flags, level_idc — read raw
// (before emulation-prevention removal they're never 0x000003-adjacent here).
export type SpsCodecBytes = {
  profileIdc: number
  constraintFlags: number
  levelIdc: number
}

export function parseSpsCodecBytes(spsNal: Uint8Array): SpsCodecBytes | null {
  if (spsNal.length < NAL_HEADER_BYTES + 3) {
    return null
  }
  return {
    profileIdc: spsNal[NAL_HEADER_BYTES],
    constraintFlags: spsNal[NAL_HEADER_BYTES + 1],
    levelIdc: spsNal[NAL_HEADER_BYTES + 2]
  }
}

// Strip emulation-prevention bytes (00 00 03 -> 00 00) so Exp-Golomb decoding
// reads the true RBSP. Operates on the SPS payload after the NAL header byte.
function unescapeRbsp(spsNal: Uint8Array): Uint8Array {
  const out: number[] = []
  let zeros = 0
  for (let i = NAL_HEADER_BYTES; i < spsNal.length; i++) {
    const byte = spsNal[i]
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0
      continue
    }
    out.push(byte)
    zeros = byte === 0x00 ? zeros + 1 : 0
  }
  return Uint8Array.from(out)
}

class BitReader {
  private bytePos = 0
  private bitPos = 0
  constructor(private readonly data: Uint8Array) {}

  readBit(): number {
    if (this.bytePos >= this.data.length) {
      return 0
    }
    const bit = (this.data[this.bytePos] >> (7 - this.bitPos)) & 1
    this.bitPos++
    if (this.bitPos === 8) {
      this.bitPos = 0
      this.bytePos++
    }
    return bit
  }

  readBits(count: number): number {
    let value = 0
    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.readBit()
    }
    return value
  }

  // Unsigned Exp-Golomb.
  readUe(): number {
    let leadingZeros = 0
    while (this.readBit() === 0 && leadingZeros < 32) {
      leadingZeros++
    }
    return (1 << leadingZeros) - 1 + this.readBits(leadingZeros)
  }

  // Signed Exp-Golomb.
  readSe(): number {
    const value = this.readUe()
    const sign = value & 1 ? 1 : -1
    return sign * Math.ceil(value / 2)
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

function skipScalingList(reader: BitReader, size: number): void {
  let lastScale = 8
  let nextScale = 8
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) {
      const delta = reader.readSe()
      nextScale = (lastScale + delta + 256) % 256
    }
    lastScale = nextScale === 0 ? lastScale : nextScale
  }
}

export function parseSpsDimensions(spsNal: Uint8Array): SpsDimensions | null {
  if (spsNal.length < NAL_HEADER_BYTES + 4) {
    return null
  }
  const rbsp = unescapeRbsp(spsNal)
  const reader = new BitReader(rbsp)
  const profileIdc = reader.readBits(8)
  reader.readBits(8) // constraint flags + reserved
  reader.readBits(8) // level_idc
  reader.readUe() // seq_parameter_set_id

  let chromaFormatIdc = 1
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = reader.readUe()
    if (chromaFormatIdc === 3) {
      reader.readBit() // separate_colour_plane_flag
    }
    reader.readUe() // bit_depth_luma_minus8
    reader.readUe() // bit_depth_chroma_minus8
    reader.readBit() // qpprime_y_zero_transform_bypass_flag
    if (reader.readBit() === 1) {
      // seq_scaling_matrix_present_flag
      const lists = chromaFormatIdc === 3 ? 12 : 8
      for (let i = 0; i < lists; i++) {
        if (reader.readBit() === 1) {
          skipScalingList(reader, i < 6 ? 16 : 64)
        }
      }
    }
  }

  reader.readUe() // log2_max_frame_num_minus4
  const picOrderCntType = reader.readUe()
  if (picOrderCntType === 0) {
    reader.readUe() // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    reader.readBit() // delta_pic_order_always_zero_flag
    reader.readSe() // offset_for_non_ref_pic
    reader.readSe() // offset_for_top_to_bottom_field
    const numRefFrames = reader.readUe()
    for (let i = 0; i < numRefFrames; i++) {
      reader.readSe()
    }
  }

  reader.readUe() // max_num_ref_frames
  reader.readBit() // gaps_in_frame_num_value_allowed_flag
  const picWidthInMbsMinus1 = reader.readUe()
  const picHeightInMapUnitsMinus1 = reader.readUe()
  const frameMbsOnlyFlag = reader.readBit()
  if (frameMbsOnlyFlag === 0) {
    reader.readBit() // mb_adaptive_frame_field_flag
  }
  reader.readBit() // direct_8x8_inference_flag

  let width = (picWidthInMbsMinus1 + 1) * 16
  let height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16

  if (reader.readBit() === 1) {
    // frame_cropping_flag — crop offsets are in chroma sample units.
    const cropLeft = reader.readUe()
    const cropRight = reader.readUe()
    const cropTop = reader.readUe()
    const cropBottom = reader.readUe()
    const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1
    const cropUnitX = chromaFormatIdc === 0 ? 1 : subWidthC
    const cropUnitY = (chromaFormatIdc === 0 ? 1 : subHeightC) * (2 - frameMbsOnlyFlag)
    width -= (cropLeft + cropRight) * cropUnitX
    height -= (cropTop + cropBottom) * cropUnitY
  }

  if (width <= 0 || height <= 0) {
    return null
  }
  return { width, height }
}
