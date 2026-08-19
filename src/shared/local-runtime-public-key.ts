// Why: the runtime RPC server's E2EE public key is the stable identity of an
// Orca server. Reading it from disk lets non-Electron entry points (the CLI)
// recognize a pairing offer that points back at this same server, without
// importing main-process modules.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const E2EE_KEYPAIR_FILENAME = 'orca-e2ee-keypair.json'

const MAX_KEYPAIR_FILE_BYTES = 8 * 1024

/**
 * Reads this host's runtime E2EE public key from `userDataPath`, or null when
 * no server has generated one yet. Never creates the keypair: callers only
 * compare identities, and generating one here would race the RPC server.
 */
export function readLocalRuntimePublicKeyB64(userDataPath: string): string | null {
  const filePath = join(userDataPath, E2EE_KEYPAIR_FILENAME)
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const raw = readFileSync(filePath, 'utf8')
    if (raw.length > MAX_KEYPAIR_FILE_BYTES) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    const publicKeyB64 = (parsed as { publicKeyB64?: unknown } | null)?.publicKeyB64
    return typeof publicKeyB64 === 'string' && publicKeyB64.length > 0 ? publicKeyB64 : null
  } catch {
    // Malformed keypair file: fall back to allowing the pair rather than
    // blocking every add.
    return null
  }
}
