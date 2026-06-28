import type { RemoteArchitecture } from '../ssh/ssh-remote-platform'

// Pure builders for the redroid `docker run` invocation and the labels/serial
// that key it. No execution here — the backend feeds the returned argv to the
// injected executor, so image/arch/label/name selection stays unit-testable
// without docker.

export const DEFAULT_ANDROID_VERSION = '13'
// Single redroid container per host in Phase 3 (no port-allocation policy yet),
// so the adb endpoint is the fixed redroid loopback port. Concurrent containers
// on one host await a port allocator — see the Phase 3 deviation note.
export const DEFAULT_REDROID_PORT = 5555

export const REDROID_SESSION_LABEL = 'orca.session'
export const REDROID_HOST_LABEL = 'orca.host'

// Parsed `docker ps` row. Shared by the backend parser, provision idempotency,
// and the orphan reaper so they agree on the container identity shape.
export type RedroidContainerRow = {
  containerId: string
  name: string
  sessionId?: string
}

export type RedroidContainerSpec = {
  image: string
  containerName: string
  // adb endpoint on the host where adb runs (local, or the remote host over SSH).
  serial: string
  labels: { session: string; host: string }
  // Per-container binder identity derived from the session id. WHY: >1 concurrent
  // container must not share binder nodes; under --privileged each container gets
  // its own binderfs mount, and this distinct id keeps their device identity
  // separate. The exact redroid cmdline for binder isolation is unverified on
  // hardware here (surfaced as an assumption), so it is kept explicit + testable.
  binderContext: string
  // Full `docker run` argv (starts at the `run` subcommand) for
  // executor.exec('docker', runArgs).
  runArgs: string[]
}

export type RedroidContainerSpecInput = {
  sessionId: string
  hostId: string
  arch: RemoteArchitecture
  androidVersion?: string
  port?: number
}

// redroid publishes arch-specific tags; the host CPU must match the image or the
// container fails to boot (gated earlier by the android-availability arch check).
function imageForArch(arch: RemoteArchitecture, version: string): string {
  const suffix = arch === 'arm64' ? 'arm64' : 'x86_64'
  return `redroid/redroid:${version}-${suffix}`
}

export function redroidContainerName(sessionId: string): string {
  return `orca-redroid-${sessionId}`
}

export function buildRedroidContainerSpec(input: RedroidContainerSpecInput): RedroidContainerSpec {
  const version = input.androidVersion ?? DEFAULT_ANDROID_VERSION
  const port = input.port ?? DEFAULT_REDROID_PORT
  const containerName = redroidContainerName(input.sessionId)
  const image = imageForArch(input.arch, version)
  const binderContext = `orca_${input.sessionId}`
  const runArgs = [
    'run',
    '-d',
    // --privileged: redroid needs host-kernel binder/binderfs + ashmem/memfd.
    '--privileged',
    '--name',
    containerName,
    '--label',
    `${REDROID_SESSION_LABEL}=${input.sessionId}`,
    '--label',
    `${REDROID_HOST_LABEL}=${input.hostId}`,
    '-p',
    `${port}:5555`,
    image,
    'androidboot.hardware=redroid',
    // Distinct per-container identity so concurrent containers do not collide on
    // one shared binder context (see binderContext note above).
    `androidboot.serialno=${binderContext}`
  ]
  return {
    image,
    containerName,
    serial: `127.0.0.1:${port}`,
    labels: { session: input.sessionId, host: input.hostId },
    binderContext,
    runArgs
  }
}
