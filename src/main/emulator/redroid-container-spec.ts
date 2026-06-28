import type { RemoteArchitecture } from '../ssh/ssh-remote-platform'

// Pure builders for the redroid `docker run` invocation and the labels/serial
// that key it. No execution here — the backend feeds the returned argv to the
// injected executor, so image/arch/label/name selection stays unit-testable
// without docker.

// Published redroid tags are full semver (`13.0.0`), not a bare major (`13`); a
// `13`-tagged image does not exist and the container never pulls/boots.
export const DEFAULT_ANDROID_VERSION = '13.0.0'
// Single redroid container per host in Phase 3 (no port-allocation policy yet),
// so the adb endpoint is the fixed redroid loopback port. Concurrent containers
// on one host await a port allocator — see the Phase 3 deviation note.
export const DEFAULT_REDROID_PORT = 5555

// Natural (rotation-0) display the redroid container boots at. WHY: this is the
// single source of truth shared with the bridge's tap-mapping fallback
// (DEFAULT_STREAM_SIZE) so the booted dimensions and the pixel mapping can never
// drift. dpi is not load-bearing for (pixel-based) tap mapping but redroid
// requires it as a boot arg.
export const DEFAULT_REDROID_DISPLAY = { width: 1080, height: 1920, dpi: 420 } as const

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
  // Host arch is gated by the android-availability check, not the image tag
  // (redroid images are multi-arch manifests); kept for caller context.
  arch: RemoteArchitecture
  androidVersion?: string
  port?: number
}

// redroid publishes ONE multi-arch manifest per version under the `<version>-latest`
// tag (verified on Docker Hub: e.g. `13.0.0-latest` carries both linux/amd64 and
// linux/arm64 digests). There are NO per-arch tag variants like `13.0.0-arm64`;
// such a tag does not exist and the pull/boot fails. docker resolves the host arch
// from the manifest, and host-arch compatibility is gated earlier by the
// android-availability arch check.
function redroidImage(version: string): string {
  return `redroid/redroid:${version}-latest`
}

export function redroidContainerName(sessionId: string): string {
  return `orca-redroid-${sessionId}`
}

export function buildRedroidContainerSpec(input: RedroidContainerSpecInput): RedroidContainerSpec {
  const version = input.androidVersion ?? DEFAULT_ANDROID_VERSION
  const port = input.port ?? DEFAULT_REDROID_PORT
  const containerName = redroidContainerName(input.sessionId)
  const image = redroidImage(version)
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
    // Boot the container at the exact dims the bridge maps taps against; without
    // these redroid picks its own default and tap/gesture pixels land off-target.
    `androidboot.redroid_width=${DEFAULT_REDROID_DISPLAY.width}`,
    `androidboot.redroid_height=${DEFAULT_REDROID_DISPLAY.height}`,
    `androidboot.redroid_dpi=${DEFAULT_REDROID_DISPLAY.dpi}`,
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
