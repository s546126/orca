import { describe, expect, it, vi } from 'vitest'
import type { AdbCommandExecutor, AdbCommandResult } from './adb-command-execution'
import {
  DEFAULT_REDROID_SERIAL,
  parseAdbDevices,
  parseBootCompleted,
  resolveSerial,
  waitForBootCompleted,
  type WaitClock
} from './adb-android-devices'

function ok(stdout: string): AdbCommandResult {
  return { stdout, stderr: '', exitCode: 0, spawnError: false }
}

describe('parseAdbDevices', () => {
  it('parses multiple devices with -l descriptors', () => {
    const out = [
      'List of devices attached',
      'emulator-5554       device product:sdk_gphone model:Pixel_6 device:generic transport_id:1',
      '127.0.0.1:5555      device product:redroid model:redroid device:redroid transport_id:2',
      ''
    ].join('\n')
    const devices = parseAdbDevices(out)
    expect(devices).toHaveLength(2)
    expect(devices[0]).toMatchObject({
      serial: 'emulator-5554',
      state: 'device',
      model: 'Pixel_6',
      transportId: '1'
    })
    expect(devices[1].serial).toBe('127.0.0.1:5555')
  })

  it('parses offline and unauthorized states', () => {
    const out = [
      'List of devices attached',
      '127.0.0.1:5555      offline',
      '0123456789ABCDEF    unauthorized usb:1-1'
    ].join('\n')
    const devices = parseAdbDevices(out)
    expect(devices.map((d) => d.state)).toEqual(['offline', 'unauthorized'])
  })

  it('special-cases the "no permissions" state which contains a space', () => {
    const out = [
      'List of devices attached',
      'abcdef123           no permissions (udev requires plugdev group membership)'
    ].join('\n')
    const devices = parseAdbDevices(out)
    expect(devices).toEqual([{ serial: 'abcdef123', state: 'no permissions' }])
  })

  it('returns an empty list for header-only / blank output and skips daemon chatter', () => {
    expect(parseAdbDevices('List of devices attached\n\n')).toEqual([])
    expect(parseAdbDevices('')).toEqual([])
    expect(parseAdbDevices('* daemon started successfully *\nList of devices attached')).toEqual([])
  })
})

describe('parseBootCompleted', () => {
  it('is true only when getprop prints exactly 1', () => {
    expect(parseBootCompleted('1\n')).toBe(true)
    expect(parseBootCompleted(' 1 ')).toBe(true)
    expect(parseBootCompleted('0\n')).toBe(false)
    expect(parseBootCompleted('')).toBe(false)
  })
})

describe('resolveSerial', () => {
  it('prefers an explicit serial, then an online device, then the redroid default', () => {
    expect(resolveSerial([], 'explicit:1')).toBe('explicit:1')
    expect(
      resolveSerial([
        { serial: 'a', state: 'offline' },
        { serial: 'b', state: 'device' }
      ])
    ).toBe('b')
    expect(resolveSerial([{ serial: 'a', state: 'offline' }])).toBe(DEFAULT_REDROID_SERIAL)
  })
})

describe('waitForBootCompleted', () => {
  function bootExecutor(sequence: string[]): AdbCommandExecutor {
    let i = 0
    return {
      mode: 'local',
      async exec() {
        const value = sequence[Math.min(i, sequence.length - 1)]
        i += 1
        return ok(value)
      }
    }
  }

  it('resolves true once getprop reads 1, after polling with the injected sleep', async () => {
    const sleep = vi.fn(async () => {})
    const clock: WaitClock = { now: () => 0, sleep }
    const result = await waitForBootCompleted({
      executor: bootExecutor(['0', '0', '1']),
      serial: '127.0.0.1:5555',
      timeoutMs: 60_000,
      pollIntervalMs: 500,
      clock
    })
    expect(result).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(500)
  })

  it('times out (returns false) using a virtual clock advanced by the injected sleep', async () => {
    let nowMs = 0
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms
    })
    const clock: WaitClock = { now: () => nowMs, sleep }
    const result = await waitForBootCompleted({
      executor: bootExecutor(['0']),
      serial: '127.0.0.1:5555',
      timeoutMs: 1000,
      pollIntervalMs: 500,
      clock
    })
    expect(result).toBe(false)
    // Probes at 0, 500, 1000; the third probe sees now>=timeout and bails.
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})
