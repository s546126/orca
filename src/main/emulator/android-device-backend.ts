// Why: backend Strategy boundary inside AndroidBridge. The only axis backends
// differ on is device existence, stream source, and teardown — input and
// session bookkeeping live in AndroidBridge and are shared. Type-only (.ts).

export type AndroidHost =
  | { mode: 'local' }
  // Remote redroid is the Mac/Win/Linux-desktop path. The backend resolves
  // docker/adb/screenrecord remote-side via SshConnection.exec on this target.
  | { mode: 'remote'; sshTargetId: string } // references an SshConnectionStore target

export type AndroidProvisionTarget = {
  deviceId?: string // adb serial or orca-generated container id; absent => backend default
  worktreeId?: string
  host: AndroidHost
}

// Opaque handle: main keeps owning the byte source. NAL framing happens in main
// BEFORE these chunks are emitted, so each yielded item is one decodable access
// unit, not a raw socket chunk.
export type AndroidVideoUnit = {
  data: Uint8Array // one H.264 access unit (Annex-B), key or delta
  key: boolean // IDR (carries/preceded by SPS+PPS) vs delta
  ptsMicros: number // synthesized; screenrecord/scrcpy give none
  width: number
  height: number
}

export type AndroidStreamHandle = {
  streamId: string
  streamKind: 'h264'
  units(): AsyncIterable<AndroidVideoUnit> // forwarded to emulator:frameStreamFrame
  stop(): void
}

// Summary row for `emulator list --kind android`: a redroid device seen by adb
// and/or a managed container seen by docker. Not a session record — listing is
// read-only discovery (provision/attach is Phase 3).
export type AndroidDeviceSummary = {
  serial: string
  state: string
  kind: 'android'
  // Orca session id from the container's orca.session label, when known.
  sessionId?: string
  containerId?: string
}

export type AndroidBackendAvailability = {
  ok: boolean
  reason?:
    | 'binder_unsupported' // host kernel lacks binder/binderfs/ashmem
    | 'arch_mismatch' // image arch != host arch
    | 'docker_missing'
    | 'docker_unprivileged' // user not in docker group / --privileged disallowed
    | 'ssh_unreachable'
    | 'no_remote_host' // non-Linux desktop, no SSH target configured
    | 'host_not_linux'
  message: string // actionable copy for the unavailable pane
}

export type AndroidDeviceBackend = {
  readonly id: 'redroid-docker' | 'local-adb-scrcpy'
  inspect(host: AndroidHost): Promise<AndroidBackendAvailability>
  // Read-only discovery for `emulator list --kind android`. Empty when the host
  // is unreachable/unsupported (the unavailable pane carries the reason).
  listDevices(host: AndroidHost): Promise<AndroidDeviceSummary[]>
  // Ensure device exists + adb-reachable + getprop sys.boot_completed === 1.
  provision(
    target: AndroidProvisionTarget
  ): Promise<{ serial: string; host: AndroidHost; hostId: string }>
  startStream(serial: string, host: AndroidHost): Promise<AndroidStreamHandle>
  teardown(serial: string, host: AndroidHost, opts?: { destroy?: boolean }): Promise<void>
}
