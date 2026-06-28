import { describe, expect, it } from 'vitest'
import {
  H264_DEFAULT_CODEC,
  codecStringFromAccessUnit,
  codecStringFromSps,
  findSpsNal,
  scanNalUnits
} from './h264-decoder-config'

// SPS NAL (type 7) with profile_idc=66 (0x42), constraint=0xC0, level=0x1E.
const SPS = Uint8Array.from([0x67, 0x42, 0xc0, 0x1e, 0xaa, 0xbb])
const PPS = Uint8Array.from([0x68, 0xce, 0x3c, 0x80])
const IDR = Uint8Array.from([0x65, 0x11, 0x22])
const P_FRAME = Uint8Array.from([0x41, 0x33, 0x44])

function sc4(body: Uint8Array): number[] {
  return [0, 0, 0, 1, ...body]
}

describe('scanNalUnits', () => {
  it('finds each NAL type in an Annex-B access unit', () => {
    const au = Uint8Array.from([...sc4(SPS), ...sc4(PPS), ...sc4(IDR)])
    expect(scanNalUnits(au).map((n) => n.type)).toEqual([7, 8, 5])
  })
})

describe('codecStringFromSps', () => {
  it('formats avc1.PPCCLL from the SPS profile/constraint/level bytes', () => {
    expect(codecStringFromSps(SPS)).toBe('avc1.42C01E')
  })

  it('falls back for a too-short SPS', () => {
    expect(codecStringFromSps(Uint8Array.of(0x67, 0x42))).toBe(H264_DEFAULT_CODEC)
  })
})

describe('findSpsNal / codecStringFromAccessUnit', () => {
  it('derives the codec string from a keyframe access unit', () => {
    const keyAu = Uint8Array.from([...sc4(SPS), ...sc4(PPS), ...sc4(IDR)])
    expect(findSpsNal(keyAu)).not.toBeNull()
    expect(codecStringFromAccessUnit(keyAu)).toBe('avc1.42C01E')
  })

  it('falls back to the default codec for a delta access unit with no SPS', () => {
    const deltaAu = Uint8Array.from(sc4(P_FRAME))
    expect(findSpsNal(deltaAu)).toBeNull()
    expect(codecStringFromAccessUnit(deltaAu)).toBe(H264_DEFAULT_CODEC)
  })
})
