import { EmulatorError } from './android-errors'
import type {
  AndroidBackendAvailability,
  AndroidDeviceBackend,
  AndroidHost,
  AndroidProvisionTarget,
  AndroidStreamHandle
} from './android-device-backend'

export type RedroidDockerBackendOptions = {
  // References an SshConnectionStore target for the remote redroid path.
  sshTargetId?: string
}

// Phase 1 scaffold: no docker/adb/ssh work. inspect() reports a safe-default
// "unavailable" so the pane shows actionable capability copy; the runtime verbs
// throw TODO until later phases wire provisioning/streaming/teardown.
export class RedroidDockerBackend implements AndroidDeviceBackend {
  readonly id = 'redroid-docker' as const

  constructor(private readonly options: RedroidDockerBackendOptions = {}) {}

  async inspect(host: AndroidHost): Promise<AndroidBackendAvailability> {
    void this.options
    if (host.mode === 'remote') {
      return {
        ok: false,
        reason: 'host_not_linux',
        message: 'Remote Android (redroid over SSH) is not available yet.'
      }
    }
    return {
      ok: false,
      reason: 'no_remote_host',
      message:
        'Android devices require a Linux redroid host (local binder support or a configured SSH target).'
    }
  }

  async provision(
    _target: AndroidProvisionTarget
  ): Promise<{ serial: string; host: AndroidHost; hostId: string }> {
    throw new EmulatorError(
      'emulator_redroid_unreachable',
      'TODO: redroid container provisioning is not implemented (Phase 3).'
    )
  }

  async startStream(_serial: string, _host: AndroidHost): Promise<AndroidStreamHandle> {
    throw new EmulatorError(
      'emulator_redroid_unreachable',
      'TODO: redroid H.264 streaming is not implemented (Phase 4).'
    )
  }

  async teardown(
    _serial: string,
    _host: AndroidHost,
    _opts?: { destroy?: boolean }
  ): Promise<void> {
    throw new EmulatorError(
      'emulator_redroid_unreachable',
      'TODO: redroid teardown is not implemented (Phase 3).'
    )
  }
}
