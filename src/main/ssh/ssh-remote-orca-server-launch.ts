import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'

const ORCA_RUNTIME_DIR = '.orca-runtime'
const SERVE_LOG_PATH = `$HOME/${ORCA_RUNTIME_DIR}/serve.log`
const READY_POLL_INTERVAL_MS = 1_000
const READY_POLL_TIMEOUT_MS = 45_000

export type RemoteOrcaServerReady = {
  pairingUrl: string
  endpoint: string | null
}

type ServeReadyLine = {
  type: string
  endpoint?: string
  pairing?: { url?: string } | null
}

// Why: Orca starts Xvfb automatically when no $DISPLAY is set, but only if
// Xvfb is already installed — see docs/reference/headless-linux-server.md.
// Failing fast here beats a confusing 45s poll timeout with no explanation.
export async function assertRemoteDisplayAvailable(conn: SshConnection): Promise<void> {
  const result = await execCommand(
    conn,
    '[ -n "$DISPLAY" ] && echo ok || (command -v Xvfb >/dev/null 2>&1 && echo ok)'
  ).catch(() => '')
  if (result.trim() !== 'ok') {
    throw new Error(
      [
        'The remote host has no $DISPLAY and Xvfb is not installed.',
        'Orca needs one of the two to run headless on Linux — install Xvfb on the remote host, then try again:',
        '  sudo apt-get install -y xvfb   # Debian/Ubuntu',
        '  sudo dnf install -y xorg-x11-server-Xvfb   # Fedora/RHEL',
        'See docs/reference/headless-linux-server.md for details.'
      ].join('\n')
    )
  }
}

export async function launchRemoteOrcaServer(
  conn: SshConnection,
  binaryPath: string,
  options: { pairingAddress: string }
): Promise<RemoteOrcaServerReady> {
  await assertRemoteDisplayAvailable(conn)

  const installDir = `$HOME/${ORCA_RUNTIME_DIR}`
  // Why: nohup + setsid + disown detaches the server from this SSH exec
  // channel so it keeps running after the channel (and any SSH disconnect)
  // closes; LIBGL_ALWAYS_SOFTWARE avoids GPU/DRI warnings on headless VPS
  // hosts per docs/reference/headless-linux-server.md.
  const launchCommand = [
    `mkdir -p "${installDir}"`,
    `: > "${SERVE_LOG_PATH}"`,
    `nohup env LIBGL_ALWAYS_SOFTWARE=1 setsid "${binaryPath}" serve --pairing-address '${options.pairingAddress}' --json >"${SERVE_LOG_PATH}" 2>&1 </dev/null &`,
    'disown'
  ].join('\n')

  await execCommand(conn, launchCommand)
  return await pollForReadyLine(conn)
}

async function pollForReadyLine(conn: SshConnection): Promise<RemoteOrcaServerReady> {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS
  let lastLog = ''
  while (Date.now() < deadline) {
    lastLog = await execCommand(conn, `cat "${SERVE_LOG_PATH}" 2>/dev/null || true`).catch(() => '')
    const ready = parseReadyLine(lastLog)
    if (ready) {
      return ready
    }
    await sleep(READY_POLL_INTERVAL_MS)
  }
  throw new Error(
    [
      'Timed out waiting for Orca to start on the remote host.',
      lastLog.trim() ? `Remote server log:\n${lastLog.trim()}` : 'The remote server log is empty.'
    ].join('\n')
  )
}

function parseReadyLine(log: string): RemoteOrcaServerReady | null {
  for (const line of log.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      continue
    }
    let parsed: ServeReadyLine
    try {
      parsed = JSON.parse(trimmed) as ServeReadyLine
    } catch {
      continue
    }
    if (parsed.type === 'orca_server_ready' && parsed.pairing?.url) {
      return { pairingUrl: parsed.pairing.url, endpoint: parsed.endpoint ?? null }
    }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
