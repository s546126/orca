import type { SshConnection } from './ssh-connection'
import { detectRemoteHostPlatform } from './ssh-remote-platform-detection'
import { ensureRemoteOrcaServerBinary } from './ssh-remote-orca-server-install'
import { launchRemoteOrcaServer, type RemoteOrcaServerReady } from './ssh-remote-orca-server-launch'

// Why: docs/reference/headless-linux-server.md only documents (and this repo
// only ships) a headless Linux path — macOS/Windows remotes need a real
// desktop session to run Electron, so fail with a clear message up front
// rather than a confusing download/launch error later.
export async function convertSshHostToOrcaRuntime(
  conn: SshConnection,
  options: { pairingAddress: string }
): Promise<RemoteOrcaServerReady> {
  const platform = await detectRemoteHostPlatform(conn)
  if (platform && platform.os !== 'linux') {
    throw new Error(
      `Converting an SSH remote into an Orca server is only supported on Linux hosts (detected ${platform.os}). See docs/reference/headless-linux-server.md.`
    )
  }

  const binaryPath = await ensureRemoteOrcaServerBinary(conn)
  return await launchRemoteOrcaServer(conn, binaryPath, options)
}
