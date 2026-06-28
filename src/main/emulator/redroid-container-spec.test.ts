import { describe, expect, it } from 'vitest'
import {
  buildRedroidContainerSpec,
  redroidContainerName,
  DEFAULT_ANDROID_VERSION
} from './redroid-container-spec'

describe('buildRedroidContainerSpec', () => {
  it('selects the arm64 image for an aarch64 host', () => {
    const spec = buildRedroidContainerSpec({ sessionId: 's1', hostId: 'local', arch: 'arm64' })
    expect(spec.image).toBe(`redroid/redroid:${DEFAULT_ANDROID_VERSION}-arm64`)
  })

  it('selects the x86_64 image for an x64 host', () => {
    const spec = buildRedroidContainerSpec({ sessionId: 's1', hostId: 'local', arch: 'x64' })
    expect(spec.image).toBe(`redroid/redroid:${DEFAULT_ANDROID_VERSION}-x86_64`)
  })

  it('honors an explicit android version', () => {
    const spec = buildRedroidContainerSpec({
      sessionId: 's1',
      hostId: 'local',
      arch: 'arm64',
      androidVersion: '11'
    })
    expect(spec.image).toBe('redroid/redroid:11-arm64')
  })

  it('derives the container name and serial from the session id and port', () => {
    const spec = buildRedroidContainerSpec({
      sessionId: 'wt-7',
      hostId: 'h1',
      arch: 'arm64',
      port: 5599
    })
    expect(spec.containerName).toBe('orca-redroid-wt-7')
    expect(redroidContainerName('wt-7')).toBe('orca-redroid-wt-7')
    expect(spec.serial).toBe('127.0.0.1:5599')
  })

  it('stamps orca.session and orca.host labels and a distinct binder context', () => {
    const a = buildRedroidContainerSpec({ sessionId: 'a', hostId: 'h1', arch: 'arm64' })
    const b = buildRedroidContainerSpec({ sessionId: 'b', hostId: 'h1', arch: 'arm64' })
    expect(a.labels).toEqual({ session: 'a', host: 'h1' })
    expect(a.binderContext).not.toBe(b.binderContext)
  })

  it('builds a privileged docker run argv carrying labels, port, image and binder id', () => {
    const spec = buildRedroidContainerSpec({ sessionId: 's1', hostId: 'h1', arch: 'arm64', port: 5555 })
    expect(spec.runArgs[0]).toBe('run')
    expect(spec.runArgs).toContain('-d')
    expect(spec.runArgs).toContain('--privileged')
    expect(spec.runArgs).toContain('--name')
    expect(spec.runArgs).toContain('orca-redroid-s1')
    expect(spec.runArgs).toContain('orca.session=s1')
    expect(spec.runArgs).toContain('orca.host=h1')
    expect(spec.runArgs).toContain('5555:5555')
    expect(spec.runArgs).toContain(`redroid/redroid:${DEFAULT_ANDROID_VERSION}-arm64`)
    expect(spec.runArgs).toContain('androidboot.serialno=orca_s1')
    // image must precede the redroid kernel args.
    const imageIdx = spec.runArgs.indexOf(`redroid/redroid:${DEFAULT_ANDROID_VERSION}-arm64`)
    const bootIdx = spec.runArgs.indexOf('androidboot.hardware=redroid')
    expect(imageIdx).toBeLessThan(bootIdx)
  })
})
