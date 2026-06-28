import { describe, expect, it } from 'vitest'
import type { AdbCommandExecutor, AdbCommandResult } from './adb-command-execution'
import {
  inspectAndroidAvailability,
  parseBinderProbe,
  parseDockerAvailability
} from './android-availability'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'

const LINUX_ARM64 = getRemoteHostPlatform('linux-arm64')
const DARWIN_ARM64 = getRemoteHostPlatform('darwin-arm64')

function result(partial: Partial<AdbCommandResult>): AdbCommandResult {
  return { stdout: '', stderr: '', exitCode: 0, spawnError: false, ...partial }
}

// Maps each probed program to a fixture result, so the SAME pure logic runs for
// "local" and "remote" — the only difference is the failure-shape fixtures.
function executorWith(fixtures: {
  binder?: AdbCommandResult
  docker?: AdbCommandResult
}): AdbCommandExecutor {
  return {
    mode: 'local',
    async exec(program: string): Promise<AdbCommandResult> {
      if (program === 'sh') {
        return fixtures.binder ?? result({ stdout: 'BINDER_OK\n' })
      }
      if (program === 'docker') {
        return fixtures.docker ?? result({ stdout: '27.0.0\n' })
      }
      return result({})
    }
  }
}

describe('parseBinderProbe', () => {
  it('is true only on the BINDER_OK token', () => {
    expect(parseBinderProbe(result({ stdout: 'BINDER_OK\n' }))).toBe(true)
    expect(parseBinderProbe(result({ stdout: 'BINDER_MISSING\n' }))).toBe(false)
  })
})

describe('parseDockerAvailability normalizes both executor failure shapes', () => {
  it('local ENOENT (spawnError) => docker_missing', () => {
    expect(parseDockerAvailability(result({ spawnError: true, exitCode: null }))).toEqual({
      ok: false,
      reason: 'docker_missing'
    })
  })

  it('remote shell exit 127 / "not found" => docker_missing', () => {
    expect(
      parseDockerAvailability(result({ exitCode: 127, stderr: 'sh: docker: command not found' }))
    ).toEqual({ ok: false, reason: 'docker_missing' })
  })

  it('permission denied => docker_unprivileged (checked before generic non-zero)', () => {
    expect(
      parseDockerAvailability(
        result({
          exitCode: 1,
          stderr: 'dial unix /var/run/docker.sock: connect: permission denied'
        })
      )
    ).toEqual({ ok: false, reason: 'docker_unprivileged' })
  })

  it('clean exit => ok', () => {
    expect(parseDockerAvailability(result({ exitCode: 0, stdout: '27.0.0' }))).toEqual({ ok: true })
  })
})

describe('inspectAndroidAvailability reason codes (local + remote shapes)', () => {
  it('host_not_linux when the host OS is not linux', async () => {
    const availability = await inspectAndroidAvailability({
      executor: executorWith({}),
      hostPlatform: DARWIN_ARM64,
      imageArch: 'arm64'
    })
    expect(availability).toMatchObject({ ok: false, reason: 'host_not_linux' })
  })

  it('arch_mismatch when the image arch differs from the host CPU', async () => {
    const availability = await inspectAndroidAvailability({
      executor: executorWith({}),
      hostPlatform: LINUX_ARM64,
      imageArch: 'x64'
    })
    expect(availability).toMatchObject({ ok: false, reason: 'arch_mismatch' })
  })

  it('binder_unsupported when the binder probe reports missing', async () => {
    const availability = await inspectAndroidAvailability({
      executor: executorWith({ binder: result({ stdout: 'BINDER_MISSING\n' }) }),
      hostPlatform: LINUX_ARM64,
      imageArch: 'arm64'
    })
    expect(availability).toMatchObject({ ok: false, reason: 'binder_unsupported' })
  })

  it('docker_missing for a local spawnError shape', async () => {
    const availability = await inspectAndroidAvailability({
      executor: executorWith({ docker: result({ spawnError: true, exitCode: null }) }),
      hostPlatform: LINUX_ARM64,
      imageArch: 'arm64'
    })
    expect(availability).toMatchObject({ ok: false, reason: 'docker_missing' })
  })

  it('docker_missing for a remote exit-127 shape', async () => {
    const availability = await inspectAndroidAvailability({
      executor: executorWith({
        docker: result({ exitCode: 127, stderr: 'bash: docker: command not found' })
      }),
      hostPlatform: LINUX_ARM64,
      imageArch: 'arm64'
    })
    expect(availability).toMatchObject({ ok: false, reason: 'docker_missing' })
  })

  it('docker_unprivileged for a remote permission-denied shape', async () => {
    const availability = await inspectAndroidAvailability({
      executor: executorWith({
        docker: result({ exitCode: 1, stderr: 'Got permission denied while trying to connect' })
      }),
      hostPlatform: LINUX_ARM64,
      imageArch: 'arm64'
    })
    expect(availability).toMatchObject({ ok: false, reason: 'docker_unprivileged' })
  })

  it('ok when linux + arch match + binder + docker all pass', async () => {
    const availability = await inspectAndroidAvailability({
      executor: executorWith({}),
      hostPlatform: LINUX_ARM64,
      imageArch: 'arm64'
    })
    expect(availability).toEqual({ ok: true, message: 'Ready' })
  })
})
