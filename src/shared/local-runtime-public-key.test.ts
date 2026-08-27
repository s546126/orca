import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  E2EE_KEYPAIR_FILENAME,
  MAX_KEYPAIR_FILE_BYTES,
  readLocalRuntimePublicKeyB64
} from './local-runtime-public-key'

describe('readLocalRuntimePublicKeyB64', () => {
  const tempDirs: string[] = []

  function makeUserDataPath(): string {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-local-key-'))
    tempDirs.push(userDataPath)
    return userDataPath
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the public key written by the runtime server', () => {
    const userDataPath = makeUserDataPath()
    writeFileSync(
      join(userDataPath, E2EE_KEYPAIR_FILENAME),
      JSON.stringify({ v: 1, publicKeyB64: 'public-key', secretKeyB64: 'secret-key' })
    )

    expect(readLocalRuntimePublicKeyB64(userDataPath)).toBe('public-key')
  })

  it('returns null when no keypair has been generated yet', () => {
    expect(readLocalRuntimePublicKeyB64(makeUserDataPath())).toBeNull()
  })

  it('returns null for a malformed keypair file instead of throwing', () => {
    const userDataPath = makeUserDataPath()
    writeFileSync(join(userDataPath, E2EE_KEYPAIR_FILENAME), 'not json')

    expect(readLocalRuntimePublicKeyB64(userDataPath)).toBeNull()
  })

  it('never creates the keypair file', () => {
    const userDataPath = makeUserDataPath()

    expect(readLocalRuntimePublicKeyB64(userDataPath)).toBeNull()
    expect(readLocalRuntimePublicKeyB64(userDataPath)).toBeNull()
    expect(existsSync(join(userDataPath, E2EE_KEYPAIR_FILENAME))).toBe(false)
  })

  it('returns null for an oversized sparse keypair without reading it wholesale', () => {
    const userDataPath = makeUserDataPath()
    const path = join(userDataPath, E2EE_KEYPAIR_FILENAME)
    writeFileSync(
      path,
      JSON.stringify({ v: 1, publicKeyB64: 'public-key', secretKeyB64: 'secret-key' })
    )
    truncateSync(path, MAX_KEYPAIR_FILE_BYTES + 1)

    expect(readLocalRuntimePublicKeyB64(userDataPath)).toBeNull()
  })
})
