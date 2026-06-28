import { describe, expect, it, vi } from 'vitest'
import { parseDockerSessionContainers, RedroidDockerBackend } from './redroid-docker-backend'
import type { AdbCommandExecutor, AdbCommandResult } from './adb-command-execution'
import type { SshConnection } from '../ssh/ssh-connection'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'

function ok(stdout: string): AdbCommandResult {
  return { stdout, stderr: '', exitCode: 0, spawnError: false }
}

describe('parseDockerSessionContainers', () => {
  it('extracts the orca.session label from tab-separated docker ps output', () => {
    const out = [
      'abc123\torca-redroid-sess1\torca.session=sess1,orca.host=h1',
      'def456\torca-redroid-sess2\torca.host=h2',
      ''
    ].join('\n')
    expect(parseDockerSessionContainers(out)).toEqual([
      { containerId: 'abc123', name: 'orca-redroid-sess1', sessionId: 'sess1' },
      { containerId: 'def456', name: 'orca-redroid-sess2', sessionId: undefined }
    ])
  })
})

describe('RedroidDockerBackend host dispatch', () => {
  it('reports ssh_unreachable when the remote connection is absent', async () => {
    const backend = new RedroidDockerBackend({ getConnection: () => null })
    const availability = await backend.inspect({ mode: 'remote', sshTargetId: 't1' })
    expect(availability).toMatchObject({ ok: false, reason: 'ssh_unreachable' })
  })

  it('reports ssh_unreachable when the connection is not in the connected state', async () => {
    const conn = { getState: () => ({ status: 'reconnecting' }) } as unknown as SshConnection
    const backend = new RedroidDockerBackend({ getConnection: () => conn })
    const availability = await backend.inspect({ mode: 'remote', sshTargetId: 't1' })
    expect(availability).toMatchObject({ ok: false, reason: 'ssh_unreachable' })
  })

  it('routes a connected remote host through the remote executor + detected platform', async () => {
    const conn = { getState: () => ({ status: 'connected' }) } as unknown as SshConnection
    const remoteExecutor: AdbCommandExecutor = {
      mode: 'remote',
      exec: vi.fn(async (program: string) =>
        program === 'sh' ? ok('BINDER_OK\n') : ok('27.0.0\n')
      )
    }
    const createRemoteExecutor = vi.fn(() => remoteExecutor)
    const backend = new RedroidDockerBackend({
      getConnection: () => conn,
      detectHostPlatform: async () => getRemoteHostPlatform('linux-arm64'),
      createRemoteExecutor
    })
    const availability = await backend.inspect({ mode: 'remote', sshTargetId: 't1' })
    expect(createRemoteExecutor).toHaveBeenCalledWith(conn)
    expect(availability).toEqual({ ok: true, message: 'Ready' })
  })

  it('reports host_not_linux for a local host with no relay descriptor', async () => {
    const backend = new RedroidDockerBackend({ localHostPlatform: () => null })
    const availability = await backend.inspect({ mode: 'local' })
    expect(availability).toMatchObject({ ok: false, reason: 'host_not_linux' })
  })

  it('lists adb devices merged with managed containers that have no adb entry yet', async () => {
    const executor: AdbCommandExecutor = {
      mode: 'local',
      exec: vi.fn(async (program: string, args: string[]) => {
        if (program === 'adb') {
          return ok('List of devices attached\n127.0.0.1:5555\tdevice\n')
        }
        if (program === 'docker' && args[0] === 'ps') {
          return ok('c1\torca-redroid-boot\torca.session=boot\n')
        }
        return ok('')
      })
    }
    const backend = new RedroidDockerBackend({
      localHostPlatform: () => getRemoteHostPlatform('linux-arm64'),
      createLocalExecutor: () => executor
    })
    const devices = await backend.listDevices({ mode: 'local' })
    expect(devices).toEqual([
      { serial: '127.0.0.1:5555', state: 'device', kind: 'android' },
      {
        serial: 'orca-redroid-boot',
        state: 'container',
        kind: 'android',
        sessionId: 'boot',
        containerId: 'c1'
      }
    ])
  })
})
