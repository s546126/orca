import type { AdbCommandExecutor, AdbCommandResult } from './adb-command-execution'
import type { AndroidBackendAvailability } from './android-device-backend'
import type { RemoteArchitecture, RemoteHostPlatform } from '../ssh/ssh-remote-platform'

// Mirrors the SHAPE of inspectEmulatorAvailability (runtime capability probe, not
// a build-time constant) but checks redroid's REAL requirements: Linux host,
// binder support, CPU-arch match, and a reachable/privileged docker. NEVER KVM —
// redroid is a host-kernel container, not a hardware VM.

export type AndroidAvailabilityInput = {
  executor: AdbCommandExecutor
  // Detected remote platform, or synthesized-from-os for the local path. One
  // RemoteHostPlatform powers both code paths so arch/os logic is shared.
  hostPlatform: RemoteHostPlatform
  // redroid image arch the backend would launch (aarch64 host -> arm64 image).
  imageArch: RemoteArchitecture
}

// binder probe emits BINDER_OK when binderfs is mounted, /dev/binder exists, or
// the binder_linux module is loadable; BINDER_MISSING otherwise. Run via `sh -c`
// so it works under the remote POSIX shell and local Linux alike.
export const BINDER_PROBE_PROGRAM = 'sh'
export const BINDER_PROBE_ARGS: readonly string[] = [
  '-c',
  'if [ -d /dev/binderfs ] || [ -e /dev/binder ] || modinfo binder_linux >/dev/null 2>&1 || modprobe -n binder_linux >/dev/null 2>&1; then echo BINDER_OK; else echo BINDER_MISSING; fi'
]

export const DOCKER_PROBE_PROGRAM = 'docker'
export const DOCKER_PROBE_ARGS: readonly string[] = ['info', '--format', '{{.ServerVersion}}']

// Pure: binder is present iff the probe printed the OK token.
export function parseBinderProbe(result: AdbCommandResult): boolean {
  return /BINDER_OK/.test(result.stdout)
}

export type DockerAvailability = {
  ok: boolean
  reason?: 'docker_missing' | 'docker_unprivileged'
}

// Pure: normalize BOTH executor failure shapes. Local ENOENT (spawnError) and
// remote-shell exit 127 / "not found" both mean docker_missing; a permission /
// daemon-socket denial means docker_unprivileged. The privilege check must come
// before the generic non-zero branch so denials are not swallowed as "missing".
export function parseDockerAvailability(result: AdbCommandResult): DockerAvailability {
  const text = `${result.stdout}\n${result.stderr}`
  if (
    result.spawnError ||
    result.exitCode === 127 ||
    /not found|no such file|executable file not found/i.test(text)
  ) {
    return { ok: false, reason: 'docker_missing' }
  }
  if (/permission denied|connect: permission denied|dial unix.*permission/i.test(text)) {
    return { ok: false, reason: 'docker_unprivileged' }
  }
  if (result.exitCode !== 0) {
    // Daemon unreachable / not running — fold into "missing" for the pane copy.
    return { ok: false, reason: 'docker_missing' }
  }
  return { ok: true }
}

export async function inspectAndroidAvailability(
  input: AndroidAvailabilityInput
): Promise<AndroidBackendAvailability> {
  const { executor, hostPlatform, imageArch } = input

  if (hostPlatform.os !== 'linux') {
    return {
      ok: false,
      reason: 'host_not_linux',
      message: 'redroid Android requires a Linux host kernel with binder support.'
    }
  }

  if (hostPlatform.arch !== imageArch) {
    return {
      ok: false,
      reason: 'arch_mismatch',
      message: `redroid image arch (${imageArch}) does not match the host CPU (${hostPlatform.arch}).`
    }
  }

  const binder = await executor.exec(BINDER_PROBE_PROGRAM, [...BINDER_PROBE_ARGS])
  if (!parseBinderProbe(binder)) {
    return {
      ok: false,
      reason: 'binder_unsupported',
      message: 'Host kernel lacks binder/binderfs; redroid cannot run without binder support.'
    }
  }

  const docker = parseDockerAvailability(
    await executor.exec(DOCKER_PROBE_PROGRAM, [...DOCKER_PROBE_ARGS])
  )
  if (!docker.ok) {
    return docker.reason === 'docker_unprivileged'
      ? {
          ok: false,
          reason: 'docker_unprivileged',
          message:
            'docker is installed but this user cannot run privileged containers. Add the user to the docker group or use rootless docker.'
        }
      : {
          ok: false,
          reason: 'docker_missing',
          message: 'docker is not available on the host. Install Docker to run redroid containers.'
        }
  }

  return { ok: true, message: 'Ready' }
}
