// Pure H.264 Annex-B framing: scan a byte stream into NAL units, group them into
// access units, and classify key vs delta. screenrecord emits an Annex-B
// elementary stream whose NAL boundaries are unaligned to socket reads, so this
// stateful framer buffers across arbitrary chunks and yields only complete access
// units — preserving the renderer's "one IPC message = one decodable unit"
// contract. No I/O here; the stream source feeds it chunks.
import { parseSpsDimensions } from './h264-sps-dimensions'

export const NAL_TYPE_NON_IDR = 1
export const NAL_TYPE_IDR = 5
export const NAL_TYPE_SEI = 6
export const NAL_TYPE_SPS = 7
export const NAL_TYPE_PPS = 8
export const NAL_TYPE_AUD = 9

// data keeps the 1-byte NAL header (needed for type classification); start codes
// are stripped — they're re-added uniformly when an access unit is assembled.
type NalUnit = { type: number; data: Uint8Array }

export type AccessUnit = {
  // Annex-B bytes with 4-byte start codes, ready to hand to the decoder.
  data: Uint8Array
  // True when the AU carries an IDR slice (screenrecord prefixes it with SPS+PPS).
  key: boolean
  width: number | null
  height: number | null
}

type StartCode = { offset: number; codeLen: number }

const START_CODE = Uint8Array.of(0, 0, 0, 1)

// Locate every 00 00 01 start code; a leading extra 00 makes it a 4-byte code so
// the trailing zero is not mis-attributed to the preceding NAL payload.
function findStartCodes(buf: Uint8Array): StartCode[] {
  const codes: StartCode[] = []
  let i = 0
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (i > 0 && buf[i - 1] === 0) {
        codes.push({ offset: i - 1, codeLen: 4 })
      } else {
        codes.push({ offset: i, codeLen: 3 })
      }
      i += 3
    } else {
      i++
    }
  }
  return codes
}

// trailing_zero_8bits are not significant; stripping them also discards the extra
// zero of a following 4-byte start code split across a chunk boundary.
function stripTrailingZeros(payload: Uint8Array): Uint8Array {
  let end = payload.length
  while (end > 0 && payload[end - 1] === 0) {
    end--
  }
  return payload.subarray(0, end)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b
  }
  if (b.length === 0) {
    return a
  }
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function assembleAnnexB(nals: NalUnit[]): Uint8Array {
  let total = 0
  for (const nal of nals) {
    total += START_CODE.length + nal.data.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const nal of nals) {
    out.set(START_CODE, offset)
    offset += START_CODE.length
    out.set(nal.data, offset)
    offset += nal.data.length
  }
  return out
}

function isVclType(type: number): boolean {
  return type >= NAL_TYPE_NON_IDR && type <= NAL_TYPE_IDR
}

export class AnnexBFramer {
  // ArrayBufferLike: subarray of an incoming chunk may be backed by any buffer.
  private leftover: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private currentNals: NalUnit[] = []
  private currentHasVcl = false
  private lastWidth: number | null = null
  private lastHeight: number | null = null

  // Feed an arbitrary byte chunk; returns the access units completed by it.
  push(chunk: Uint8Array): AccessUnit[] {
    const aus: AccessUnit[] = []
    const buffer = concat(this.leftover, chunk)
    const starts = findStartCodes(buffer)
    if (starts.length === 0) {
      this.leftover = buffer
      return aus
    }
    // A NAL spans from the end of its start code to the start of the next one, so
    // the final NAL stays pending until its successor's start code arrives.
    for (let i = 0; i < starts.length - 1; i++) {
      const payloadStart = starts[i].offset + starts[i].codeLen
      this.consumeNal(buffer.subarray(payloadStart, starts[i + 1].offset), aus)
    }
    // starts is non-empty here (the length-0 case returned above).
    const lastStart = starts.at(-1) as StartCode
    this.leftover = buffer.subarray(lastStart.offset)
    return aus
  }

  // Drain the buffered trailing NAL and any open access unit. Mandatory on stream
  // end (e.g. screenrecord's 180s exit) or the segment's last AU is lost.
  flush(): AccessUnit[] {
    const aus: AccessUnit[] = []
    if (this.leftover.length > 0) {
      const starts = findStartCodes(this.leftover)
      const last = starts.at(-1)
      if (last) {
        this.consumeNal(this.leftover.subarray(last.offset + last.codeLen), aus)
      }
      this.leftover = new Uint8Array(0)
    }
    const au = this.buildAccessUnit()
    if (au) {
      aus.push(au)
    }
    return aus
  }

  private consumeNal(payload: Uint8Array, aus: AccessUnit[]): void {
    const data = stripTrailingZeros(payload)
    if (data.length === 0) {
      return
    }
    const type = data[0] & 0x1f
    // AUD / parameter sets / a new VCL begin a new access unit, but only once the
    // current AU already holds a VCL — this keeps SPS+PPS+IDR together as one AU.
    const startsAu =
      isVclType(type) ||
      type === NAL_TYPE_AUD ||
      type === NAL_TYPE_SPS ||
      type === NAL_TYPE_PPS ||
      type === NAL_TYPE_SEI
    if (startsAu && this.currentHasVcl) {
      const au = this.buildAccessUnit()
      if (au) {
        aus.push(au)
      }
    }
    if (type === NAL_TYPE_SPS) {
      const dims = parseSpsDimensions(data)
      if (dims) {
        this.lastWidth = dims.width
        this.lastHeight = dims.height
      }
    }
    this.currentNals.push({ type, data })
    if (isVclType(type)) {
      this.currentHasVcl = true
    }
  }

  private buildAccessUnit(): AccessUnit | null {
    if (this.currentNals.length === 0) {
      return null
    }
    const key = this.currentNals.some((nal) => nal.type === NAL_TYPE_IDR)
    const data = assembleAnnexB(this.currentNals)
    this.currentNals = []
    this.currentHasVcl = false
    return { data, key, width: this.lastWidth, height: this.lastHeight }
  }
}
