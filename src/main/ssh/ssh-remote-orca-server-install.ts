import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'

const ORCA_RUNTIME_DIR = '.orca-runtime'
const ORCA_APPIMAGE_NAME = 'orca-linux.AppImage'
const ORCA_APPIMAGE_DOWNLOAD_URL =
  'https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage'
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000

// Why: probe common install locations before downloading — a host that
// already followed docs/reference/headless-linux-server.md (shared /opt/orca
// path) or was previously converted by this same flow (~/.orca-runtime)
// should never trigger a redundant download.
const KNOWN_BINARY_PATHS = [
  `$HOME/${ORCA_RUNTIME_DIR}/${ORCA_APPIMAGE_NAME}`,
  '/opt/orca/orca-linux.AppImage'
]

export async function detectRemoteOrcaServerBinary(conn: SshConnection): Promise<string | null> {
  const script = KNOWN_BINARY_PATHS.map(
    (candidate) => `[ -x "${candidate}" ] && echo "${candidate}"`
  ).join('\n')
  const result = await execCommand(conn, `${script}\ntrue`).catch(() => '')
  for (const line of result.split('\n')) {
    const candidate = line.trim()
    if (candidate) {
      return candidate
    }
  }
  return null
}

export async function ensureRemoteOrcaServerBinary(conn: SshConnection): Promise<string> {
  const existing = await detectRemoteOrcaServerBinary(conn)
  if (existing) {
    return existing
  }

  const installDir = `$HOME/${ORCA_RUNTIME_DIR}`
  const binaryPath = `${installDir}/${ORCA_APPIMAGE_NAME}`
  const downloader = await resolveRemoteDownloader(conn)
  const downloadCommand =
    downloader === 'curl'
      ? `curl -fsSL '${ORCA_APPIMAGE_DOWNLOAD_URL}' -o '${binaryPath}'`
      : `wget -q '${ORCA_APPIMAGE_DOWNLOAD_URL}' -O '${binaryPath}'`

  try {
    await execCommand(
      conn,
      `mkdir -p "${installDir}" && ${downloadCommand} && chmod +x "${binaryPath}"`,
      { timeoutMs: DOWNLOAD_TIMEOUT_MS }
    )
  } catch (err) {
    throw new Error(
      [
        `Could not download Orca to the remote host: ${err instanceof Error ? err.message : String(err)}`,
        '',
        'Install it manually instead — see docs/reference/headless-linux-server.md, or run on the remote host:',
        `  mkdir -p ${installDir}`,
        `  curl -fsSL ${ORCA_APPIMAGE_DOWNLOAD_URL} -o ${binaryPath}`,
        `  chmod +x ${binaryPath}`
      ].join('\n')
    )
  }

  const verified = await execCommand(conn, `[ -x "${binaryPath}" ] && echo ok`).catch(() => '')
  if (!verified.trim()) {
    throw new Error(
      `Downloaded Orca to ${binaryPath} on the remote host, but it is not executable.`
    )
  }
  return binaryPath
}

async function resolveRemoteDownloader(conn: SshConnection): Promise<'curl' | 'wget'> {
  const result = await execCommand(
    conn,
    'command -v curl >/dev/null 2>&1 && echo curl || (command -v wget >/dev/null 2>&1 && echo wget)'
  ).catch(() => '')
  const tool = result.trim()
  if (tool === 'curl' || tool === 'wget') {
    return tool
  }
  throw new Error(
    'Neither curl nor wget is available on the remote host to download Orca. Install one of them, then try again.'
  )
}
