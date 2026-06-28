import { describe, expect, it } from 'vitest'
import { localRemoteHostPlatform, resolveAndroidHost } from './android-host-resolution'

describe('resolveAndroidHost selection', () => {
  it('is remote when an SSH target id is configured (any platform)', () => {
    expect(resolveAndroidHost({ androidRedroidSshTargetId: 'ssh-target-1' }, 'darwin')).toEqual({
      mode: 'remote',
      sshTargetId: 'ssh-target-1'
    })
    expect(resolveAndroidHost({ androidRedroidSshTargetId: 'ssh-target-1' }, 'win32')).toEqual({
      mode: 'remote',
      sshTargetId: 'ssh-target-1'
    })
  })

  it('is local on linux when no SSH target is configured', () => {
    expect(resolveAndroidHost({}, 'linux')).toEqual({ mode: 'local' })
  })

  it('is null (no reachable host) on non-linux desktops without an SSH target', () => {
    expect(resolveAndroidHost({}, 'darwin')).toBeNull()
    expect(resolveAndroidHost({}, 'win32')).toBeNull()
  })
})

describe('localRemoteHostPlatform', () => {
  it('synthesizes a RemoteHostPlatform for supported OS/arch combos', () => {
    expect(localRemoteHostPlatform('linux', 'arm64')).toMatchObject({ os: 'linux', arch: 'arm64' })
    expect(localRemoteHostPlatform('darwin', 'x64')).toMatchObject({ os: 'darwin', arch: 'x64' })
  })

  it('returns null for combos Orca has no relay descriptor for', () => {
    expect(localRemoteHostPlatform('linux', 'mips')).toBeNull()
    expect(localRemoteHostPlatform('aix' as NodeJS.Platform, 'x64')).toBeNull()
  })
})
