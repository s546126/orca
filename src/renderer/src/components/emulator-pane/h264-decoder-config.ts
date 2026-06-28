// Pure helpers for the WebCodecs H.264 consumer: derive an avc1 codec string from
// the SPS the source bakes into each keyframe, and locate NAL units inside an
// Annex-B access unit. No DOM — unit-tested directly since the decoder hook itself
// can only be typechecked here.

const NAL_TYPE_SPS = 7

// Baseline 3.0 — a safe default when the SPS cannot be read.
export const H264_DEFAULT_CODEC = 'avc1.42E01E'

type NalSpan = { type: number; start: number; end: number }

// Walk Annex-B start codes (3- and 4-byte) and return each NAL's type + payload
// span (payload includes the 1-byte NAL header, excludes the start code).
export function scanNalUnits(data: Uint8Array): NalSpan[] {
  const spans: NalSpan[] = []
  const starts: { offset: number; codeLen: number }[] = []
  let i = 0
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const fourByte = i > 0 && data[i - 1] === 0
      starts.push({ offset: fourByte ? i - 1 : i, codeLen: fourByte ? 4 : 3 })
      i += 3
    } else {
      i++
    }
  }
  for (let s = 0; s < starts.length; s++) {
    const payloadStart = starts[s].offset + starts[s].codeLen
    const payloadEnd = s + 1 < starts.length ? starts[s + 1].offset : data.length
    if (payloadEnd > payloadStart) {
      spans.push({ type: data[payloadStart] & 0x1f, start: payloadStart, end: payloadEnd })
    }
  }
  return spans
}

export function findSpsNal(data: Uint8Array): Uint8Array | null {
  for (const span of scanNalUnits(data)) {
    if (span.type === NAL_TYPE_SPS) {
      return data.subarray(span.start, span.end)
    }
  }
  return null
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase()
}

// avc1.PPCCLL from the SPS bytes after the NAL header: profile_idc, constraint
// flags, level_idc.
export function codecStringFromSps(spsNal: Uint8Array): string {
  if (spsNal.length < 4) {
    return H264_DEFAULT_CODEC
  }
  return `avc1.${hexByte(spsNal[1])}${hexByte(spsNal[2])}${hexByte(spsNal[3])}`
}

// Codec string for an access unit; falls back when it carries no SPS (delta AUs).
export function codecStringFromAccessUnit(data: Uint8Array): string {
  const sps = findSpsNal(data)
  return sps ? codecStringFromSps(sps) : H264_DEFAULT_CODEC
}

// Codec string ONLY when the access unit actually carries an SPS, else null.
// WHY: an SPS-less IDR (redroid emits these) must not regress an already-known
// codec back to the baseline default and force a needless decoder reconfigure —
// the caller keeps the previously configured codec when this returns null.
export function codecStringFromAccessUnitIfSps(data: Uint8Array): string | null {
  const sps = findSpsNal(data)
  return sps ? codecStringFromSps(sps) : null
}
