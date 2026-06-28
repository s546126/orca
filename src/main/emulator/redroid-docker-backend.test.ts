import { describe, expect, it, vi } from 'vitest'
import { parseDockerSessionContainers, RedroidDockerBackend } from './redroid-docker-backend'
import type { AdbCommandExecutor, AdbCommandResult } from './adb-command-execution'
import type { WaitClock } from './adb-android-devices'
import type { SshConnection } from '../ssh/ssh-connection'
import type { RemoteExecChannel } from './android-remote-screenrecord-spawner'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'

function ok(stdout: string, exitCode = 0): AdbCommandResult {
  return { stdout, stderr: '', exitCode, spawnError: false }
}

// Virtual clock: sleep advances `now`, so the boot-wait poll terminates without
// real time. Probes at least once before the timeout check.
function fakeClock(): WaitClock {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    }
  }
}

type ExecHandler = (program: string, args: string[]) => AdbCommandResult
function recordingExecutor(handler: ExecHandler): {
  executor: AdbCommandExecutor
  calls: string[][]
} {
  const calls: string[][] = []
  const executor: AdbCommandExecutor = {
    mode: 'local',
    exec: vi.fn(async (program: string, args: string[]) => {
      calls.push([program, ...args])
      return handler(program, args)
    })
  }
  return { executor, calls }
}

function localBackend(executor: AdbCommandExecutor, clock: WaitClock): RedroidDockerBackend {
  return new RedroidDockerBackend({
    localHostPlatform: () => getRemoteHostPlatform('linux-arm64'),
    createLocalExecutor: () => executor,
    clock,
    bootTimeoutMs: 3000,
    bootPollIntervalMs: 1000
  })
}

describe('RedroidDockerBackend.startStream', () => {
  it('builds a local h264 stream source from the injected spawner', async () => {
    const { executor } = recordingExecutor(() => ok(''))
    const child = {
      chunks: (async function* () {})(),
      stop: vi.fn()
    }
    const spawn = vi.fn(() => child)
    const backend = new RedroidDockerBackend({
      localHostPlatform: () => getRemoteHostPlatform('linux-arm64'),
      createLocalExecutor: () => executor,
      createStreamSpawner: () => spawn
    })
    const handle = await backend.startStream('127.0.0.1:5555', { mode: 'local' })
    expect(handle.streamKind).toBe('h264')
    expect(typeof handle.streamId).toBe('string')
    handle.stop()
  })

  it('builds a remote h264 stream source from the resolved SSH connection', async () => {
    const conn = { getState: () => ({ status: 'connected' }) } as unknown as SshConnection
    const remoteExecutor: AdbCommandExecutor = { mode: 'remote', exec: vi.fn(async () => ok('')) }
    const spawn = vi.fn(() => ({ chunks: (async function* () {})(), stop: vi.fn() }))
    const backend = new RedroidDockerBackend({
      getConnection: () => conn,
      detectHostPlatform: async () => getRemoteHostPlatform('linux-arm64'),
      createRemoteExecutor: () => remoteExecutor,
      createStreamSpawner: () => spawn,
      subscribeReconnect: vi.fn(() => () => {})
    })
    const handle = await backend.startStream('127.0.0.1:5555', {
      mode: 'remote',
      sshTargetId: 't1'
    })
    expect(handle.streamKind).toBe('h264')
    handle.stop()
  })

  it('throws emulator_redroid_unreachable for a remote host with no live connection', async () => {
    // Connected for the executor resolution, but getConnection returns null when
    // the stream tries to resolve the live channel.
    let calls = 0
    const conn = { getState: () => ({ status: 'connected' }) } as unknown as SshConnection
    const backend = new RedroidDockerBackend({
      getConnection: () => (calls++ === 0 ? conn : null),
      detectHostPlatform: async () => getRemoteHostPlatform('linux-arm64'),
      createRemoteExecutor: () => ({ mode: 'remote', exec: vi.fn(async () => ok('')) })
    })
    await expect(
      backend.startStream('127.0.0.1:5555', { mode: 'remote', sshTargetId: 't1' })
    ).rejects.toMatchObject({ code: 'emulator_redroid_unreachable' })
  })

  it('re-resolves the SSH connection per exec so a reconnect-swapped instance is used, not a captured dead one', async () => {
    // A reconnect makes SshConnectionManager dispose instance A and build B; the
    // spawner must exec against the current instance, never a captured one.
    let resolveExec!: () => void
    const execCalled = new Promise<void>((r) => {
      resolveExec = r
    })
    // close() must fire the 'close' listener so the spawner's wake-loop unparks
    // when handle.stop() tears the channel down; otherwise the generator hangs.
    const stubChannel = (): RemoteExecChannel => {
      let onClose: (() => void) | null = null
      const channel = {
        on: (event: string, listener: () => void) => {
          if (event === 'close') {
            onClose = listener
          }
          return channel
        },
        stderr: { on: () => channel.stderr },
        close: () => onClose?.()
      }
      return channel as unknown as RemoteExecChannel
    }
    const execA = vi.fn(async () => {
      resolveExec()
      return stubChannel()
    })
    const execB = vi.fn(async () => {
      resolveExec()
      return stubChannel()
    })
    const connA = {
      getState: () => ({ status: 'connected' }),
      exec: execA
    } as unknown as SshConnection
    const connB = {
      getState: () => ({ status: 'connected' }),
      exec: execB
    } as unknown as SshConnection
    let conn = connA
    const backend = new RedroidDockerBackend({
      getConnection: () => conn,
      detectHostPlatform: async () => getRemoteHostPlatform('linux-arm64'),
      createRemoteExecutor: () => ({ mode: 'remote', exec: vi.fn(async () => ok('')) })
    })
    const handle = await backend.startStream('127.0.0.1:5555', {
      mode: 'remote',
      sshTargetId: 't1'
    })
    conn = connB // SshConnectionManager swapped A->B on reconnect.
    const gen = handle.units()[Symbol.asyncIterator]()
    const pumped = gen.next()
    await execCalled
    handle.stop()
    await pumped.catch(() => {})
    expect(execB).toHaveBeenCalledTimes(1)
    expect(execA).not.toHaveBeenCalled()
  })
})

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

describe('RedroidDockerBackend.provision', () => {
  it('runs a fresh container when none is labeled, connects, and waits for boot', async () => {
    const { executor, calls } = recordingExecutor((program, args) => {
      if (program === 'docker' && args[0] === 'ps') {
        return ok('') // no existing container
      }
      if (program === 'adb' && args.includes('getprop')) {
        return ok('1\n')
      }
      return ok('')
    })
    const backend = localBackend(executor, fakeClock())
    const result = await backend.provision({ deviceId: 'sess1', host: { mode: 'local' } })

    expect(result).toEqual({ serial: '127.0.0.1:5555', host: { mode: 'local' }, hostId: 'local' })
    const runCall = calls.find((c) => c[0] === 'docker' && c[1] === 'run')
    expect(runCall).toBeDefined()
    expect(runCall).toContain('orca-redroid-sess1')
    expect(calls.some((c) => c[0] === 'docker' && c[1] === 'start')).toBe(false)
    expect(calls).toContainEqual(['adb', 'connect', '127.0.0.1:5555'])
  })

  it('restarts an existing labeled container instead of running a new one', async () => {
    const { executor, calls } = recordingExecutor((program, args) => {
      if (program === 'docker' && args[0] === 'ps') {
        return ok('cid\torca-redroid-sess1\torca.session=sess1\n')
      }
      if (program === 'adb' && args.includes('getprop')) {
        return ok('1\n')
      }
      return ok('')
    })
    const backend = localBackend(executor, fakeClock())
    await backend.provision({ deviceId: 'sess1', host: { mode: 'local' } })

    expect(calls).toContainEqual(['docker', 'start', 'orca-redroid-sess1'])
    expect(calls.some((c) => c[0] === 'docker' && c[1] === 'run')).toBe(false)
  })

  it('throws emulator_redroid_unreachable when boot never completes', async () => {
    const { executor } = recordingExecutor((program, args) => {
      if (program === 'docker' && args[0] === 'ps') {
        return ok('')
      }
      if (program === 'adb' && args.includes('getprop')) {
        return ok('0\n') // never boots
      }
      return ok('')
    })
    const backend = localBackend(executor, fakeClock())
    await expect(backend.provision({ deviceId: 'sess1', host: { mode: 'local' } })).rejects.toThrow(
      /redroid/i
    )
  })

  it('removes a freshly-run container that never boots so it is not orphaned', async () => {
    const { executor, calls } = recordingExecutor((program, args) => {
      if (program === 'docker' && args[0] === 'ps') {
        return ok('') // no existing container -> fresh `docker run`
      }
      if (program === 'adb' && args.includes('getprop')) {
        return ok('0\n') // never boots
      }
      return ok('')
    })
    const backend = localBackend(executor, fakeClock())
    await expect(
      backend.provision({ deviceId: 'sess1', host: { mode: 'local' } })
    ).rejects.toMatchObject({ code: 'emulator_redroid_unreachable' })
    // The container we created must be torn down, not leaked, on boot timeout.
    expect(calls.some((c) => c[0] === 'docker' && c[1] === 'rm' && c.includes('-f'))).toBe(true)
  })

  it('fails fast with emulator_docker_unprivileged on a privilege denial, never entering boot-wait', async () => {
    const { executor, calls } = recordingExecutor((program, args) => {
      if (program === 'docker' && args[0] === 'ps') {
        return ok('') // no existing container
      }
      if (program === 'docker' && args[0] === 'run') {
        return { stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket', exitCode: 1, spawnError: false }
      }
      return ok('')
    })
    const backend = localBackend(executor, fakeClock())
    await expect(
      backend.provision({ deviceId: 'sess1', host: { mode: 'local' } })
    ).rejects.toMatchObject({ code: 'emulator_docker_unprivileged' })
    // The container never started, so the boot poll (adb getprop) must not run.
    expect(calls.some((c) => c[0] === 'adb' && c.includes('getprop'))).toBe(false)
  })

  it('surfaces the docker stderr as emulator_redroid_unreachable on a non-privilege run failure', async () => {
    const { executor, calls } = recordingExecutor((program, args) => {
      if (program === 'docker' && args[0] === 'ps') {
        return ok('')
      }
      if (program === 'docker' && args[0] === 'run') {
        return { stdout: '', stderr: 'docker: Error response from daemon: no such image', exitCode: 125, spawnError: false }
      }
      return ok('')
    })
    const backend = localBackend(executor, fakeClock())
    await expect(
      backend.provision({ deviceId: 'sess1', host: { mode: 'local' } })
    ).rejects.toMatchObject({ code: 'emulator_redroid_unreachable' })
    expect(calls.some((c) => c[0] === 'adb' && c.includes('getprop'))).toBe(false)
  })

  it('throws emulator_redroid_unreachable when the host is unreachable', async () => {
    const backend = new RedroidDockerBackend({ localHostPlatform: () => null })
    await expect(backend.provision({ deviceId: 's', host: { mode: 'local' } })).rejects.toMatchObject(
      { code: 'emulator_redroid_unreachable' }
    )
  })
})

describe('RedroidDockerBackend.teardown', () => {
  async function provisionExisting(): Promise<{
    backend: RedroidDockerBackend
    calls: string[][]
  }> {
    const { executor, calls } = recordingExecutor((program, args) => {
      if (program === 'docker' && args[0] === 'ps') {
        return ok('cid\torca-redroid-sess1\torca.session=sess1\n')
      }
      if (program === 'adb' && args.includes('getprop')) {
        return ok('1\n')
      }
      // rm -f a missing container exits non-zero — must be tolerated.
      if (program === 'docker' && args[0] === 'rm') {
        return ok('Error: No such container', 1)
      }
      return ok('')
    })
    const backend = localBackend(executor, fakeClock())
    await backend.provision({ deviceId: 'sess1', host: { mode: 'local' } })
    calls.length = 0
    return { backend, calls }
  }

  it('disconnects and force-removes the container when destroy is set', async () => {
    const { backend, calls } = await provisionExisting()
    await backend.teardown('127.0.0.1:5555', { mode: 'local' }, { destroy: true })
    expect(calls).toContainEqual(['adb', 'disconnect', '127.0.0.1:5555'])
    expect(calls).toContainEqual(['docker', 'rm', '-f', 'orca-redroid-sess1'])
  })

  it('disconnects only (no rm) when destroy is not set', async () => {
    const { backend, calls } = await provisionExisting()
    await backend.teardown('127.0.0.1:5555', { mode: 'local' })
    expect(calls).toContainEqual(['adb', 'disconnect', '127.0.0.1:5555'])
    expect(calls.some((c) => c[0] === 'docker' && c[1] === 'rm')).toBe(false)
  })

  it('tolerates an already-gone container (rm exits non-zero) without throwing', async () => {
    const { backend } = await provisionExisting()
    await expect(
      backend.teardown('127.0.0.1:5555', { mode: 'local' }, { destroy: true })
    ).resolves.toBeUndefined()
  })

  it('destroy of an unmapped serial only disconnects (reaper handles the container)', async () => {
    const { executor, calls } = recordingExecutor(() => ok(''))
    const backend = localBackend(executor, fakeClock())
    await backend.teardown('127.0.0.1:5555', { mode: 'local' }, { destroy: true })
    expect(calls).toContainEqual(['adb', 'disconnect', '127.0.0.1:5555'])
    expect(calls.some((c) => c[0] === 'docker' && c[1] === 'rm')).toBe(false)
  })
})

describe('RedroidDockerBackend.reapOrphans', () => {
  it('removes stale labeled containers and leaves live ones', async () => {
    const { executor, calls } = recordingExecutor((program, args) => {
      if (program === 'docker' && args[0] === 'ps') {
        return ok(
          [
            'c1\torca-redroid-live\torca.session=live,orca.host=local',
            'c2\torca-redroid-stale\torca.session=stale,orca.host=local'
          ].join('\n')
        )
      }
      return ok('')
    })
    const backend = localBackend(executor, fakeClock())
    const reaped = await backend.reapOrphans(['live'], { mode: 'local' })
    expect(reaped).toEqual(['c2'])
    expect(calls).toContainEqual(['docker', 'rm', '-f', 'c2'])
    expect(calls.some((c) => c[0] === 'docker' && c.includes('c1'))).toBe(false)
  })
})
