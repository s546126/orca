import { describe, expect, it, vi } from 'vitest'
import { sweepAndroidOrphansAtStartup } from './android-startup-orphan-sweep'
import type { AndroidHost } from './android-device-backend'

const LOCAL: AndroidHost = { mode: 'local' }

describe('sweepAndroidOrphansAtStartup', () => {
  it('reaps stale containers, leaving live session ids untouched', async () => {
    const reap = vi.fn(async (_live: Iterable<string>, _host: AndroidHost) => ['c2'])
    const reaped = await sweepAndroidOrphansAtStartup(reap, LOCAL, ['live'])
    expect(reaped).toEqual(['c2'])
    expect(reap).toHaveBeenCalledWith(['live'], LOCAL)
  })

  it('is a no-op when no host is reachable (never calls reap)', async () => {
    const reap = vi.fn(async () => ['x'])
    const reaped = await sweepAndroidOrphansAtStartup(reap, null, [])
    expect(reaped).toEqual([])
    expect(reap).not.toHaveBeenCalled()
  })

  it('never throws when docker/host is absent (reap rejects)', async () => {
    const reap = vi.fn(async () => {
      throw new Error('docker daemon not reachable')
    })
    await expect(sweepAndroidOrphansAtStartup(reap, LOCAL, [])).resolves.toEqual([])
  })
})
