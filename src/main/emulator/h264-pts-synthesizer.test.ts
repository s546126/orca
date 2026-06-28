import { describe, expect, it } from 'vitest'
import { createPtsSynthesizer } from './h264-pts-synthesizer'

describe('createPtsSynthesizer', () => {
  it('produces strictly monotonic timestamps at a fixed cadence', () => {
    const pts = createPtsSynthesizer(30)
    const values = [pts.next(), pts.next(), pts.next(), pts.next()]
    expect(values[0]).toBe(0)
    const step = Math.round(1_000_000 / 30)
    expect(values[1]).toBe(step)
    expect(values[2]).toBe(step * 2)
    expect(values[3]).toBe(step * 3)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
  })

  it('falls back to a sane cadence for a non-positive fps', () => {
    const pts = createPtsSynthesizer(0)
    expect(pts.next()).toBe(0)
    expect(pts.next()).toBeGreaterThan(0)
  })
})
