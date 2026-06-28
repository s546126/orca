import { spawn } from 'child_process'
import { ADB_PROGRAM } from './adb-android-devices'
import { sweepAndroidOrphansAtStartup } from './android-startup-orphan-sweep'
import {
  AndroidTrackDevicesWatcher,
  buildTrackDevicesCommand,
  type AndroidTrackDevicesSink,
  type TrackDevicesChannel
} from './android-track-devices-watcher'
import type { AndroidHost } from './android-device-backend'
import type { RedroidDockerBackend } from './redroid-docker-backend'
import type { SshConnection } from '../ssh/ssh-connection'

// Why: Android host services (orphan sweep + track-devices auto-attach watcher)
// are activated lazily when a reachable host exists and androidEnabled is set —
// never at import, and never process-global. All SSH access is resolved at call
// time from the manager so nothing connects here. iOS/serve-sim is unaffected.

export type AndroidHostActivationDeps = {
  backend: RedroidDockerBackend
  host: AndroidHost
  sink: AndroidTrackDevicesSink
  // Live session ids for the startup sweep (empty at startup: nothing is live, so
  // every prior-crash orphan is reaped).
  getLiveSessionIds: () => Iterable<string>
  // Resolved at call time so the watcher binds to the current SSH connection.
  getConnection: (sshTargetId: string) => SshConnection | null
  // Per-target SSH reconnect subscription; re-establishes the watcher channel.
  subscribeReconnect: (sshTargetId: string, cb: () => void) => () => void
}

// Local Linux host: `adb track-devices` long-lived child, adapted to the watcher's
// channel slice. Remote rides SshConnection.exec on the configured target.
function openTrackDevicesChannel(deps: AndroidHostActivationDeps): () => Promise<TrackDevicesChannel> {
  const { host } = deps
  if (host.mode === 'remote') {
    return async () => {
      const conn = deps.getConnection(host.sshTargetId)
      if (!conn) {
        throw new Error('SSH host for remote Android is not connected.')
      }
      return conn.exec(buildTrackDevicesCommand()) as unknown as TrackDevicesChannel
    }
  }
  return async () => {
    const child = spawn(ADB_PROGRAM, ['track-devices'], { shell: false })
    child.on('error', () => {})
    return {
      on(event: 'data' | 'close' | 'error', listener: (...args: never[]) => void): unknown {
        if (event === 'data') {
          child.stdout?.on('data', listener as never)
        } else {
          child.on(event, listener as never)
        }
        return undefined
      },
      close: () => {
        child.kill()
      }
    }
  }
}

// Starts the host's track-devices watcher + runs the startup orphan sweep. Returns
// a teardown that stops the watcher (call on app quit / host deactivation).
export function activateAndroidHostServices(deps: AndroidHostActivationDeps): () => void {
  void sweepAndroidOrphansAtStartup(
    (live, host) => deps.backend.reapOrphans(live, host),
    deps.host,
    deps.getLiveSessionIds()
  )
  // Local watchers have no SSH reconnect to re-establish on; only remote ones do.
  const remoteTargetId = deps.host.mode === 'remote' ? deps.host.sshTargetId : null
  const onReconnect = remoteTargetId
    ? (cb: () => void) => deps.subscribeReconnect(remoteTargetId, cb)
    : undefined
  const watcher = new AndroidTrackDevicesWatcher({
    openChannel: openTrackDevicesChannel(deps),
    sink: deps.sink,
    onReconnect
  })
  watcher.start()
  return () => watcher.stop()
}
