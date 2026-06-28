import type { AndroidHost } from './android-device-backend'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { RelayPlatform } from '../ssh/relay-protocol'

// Pure host selection (importable + testable; index.ts just feeds it settings +
// process.platform). A configured SSH target wins (remote redroid over SSH);
// otherwise local redroid is only viable on Linux; everything else has no
// reachable redroid host (surfaced as no_remote_host downstream).
export type AndroidHostSettings = {
  androidRedroidSshTargetId?: string
}

export function resolveAndroidHost(
  settings: AndroidHostSettings,
  nodePlatform: NodeJS.Platform
): AndroidHost | null {
  if (settings.androidRedroidSshTargetId) {
    return { mode: 'remote', sshTargetId: settings.androidRedroidSshTargetId }
  }
  if (nodePlatform === 'linux') {
    return { mode: 'local' }
  }
  return null
}

// Synthesize a RemoteHostPlatform for the LOCAL machine so the availability probe
// shares one code path for local + remote. Returns null for OS/arch combos Orca
// has no relay descriptor for.
export function localRemoteHostPlatform(
  nodePlatform: NodeJS.Platform,
  nodeArch: string
): RemoteHostPlatform | null {
  const os =
    nodePlatform === 'linux'
      ? 'linux'
      : nodePlatform === 'darwin'
        ? 'darwin'
        : nodePlatform === 'win32'
          ? 'win32'
          : null
  const arch = nodeArch === 'arm64' ? 'arm64' : nodeArch === 'x64' ? 'x64' : null
  if (!os || !arch) {
    return null
  }
  return getRemoteHostPlatform(`${os}-${arch}` as RelayPlatform)
}
