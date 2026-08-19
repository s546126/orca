import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { E2EE_KEYPAIR_FILENAME } from './local-runtime-public-key'
import { encodePairingOffer } from './pairing'
import {
  RuntimeEnvironmentStoreError,
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  markEnvironmentUsed,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'

function writeStoredE2EEPublicKey(userDataPath: string, publicKey: Buffer): void {
  writeFileSync(
    join(userDataPath, E2EE_KEYPAIR_FILENAME),
    JSON.stringify({ v: 1, publicKeyB64: publicKey.toString('base64'), secretKeyB64: 'unused' })
  )
}

function pairingCode(endpoint = 'ws://127.0.0.1:6768', pairedDeviceId?: string): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
    ...(pairedDeviceId ? { pairedDeviceId } : {})
  })
}

describe('runtime environment store', () => {
  const tempDirs: string[] = []
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    // Why: this suite tests store timestamps, while secure-file tests cover Windows ACLs.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects duplicate server names instead of silently replacing the saved server', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)

    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode('ws://127.0.0.1:6768')
    })

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'dev box',
        pairingCode: pairingCode('ws://192.0.2.10:6768')
      })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(listEnvironments(userDataPath)).toEqual([first])
  })

  it('advances pairing revisions across equal and backward clock readings', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode(),
      now: 100
    })

    const sameClock = updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.10:6768'),
      now: 100
    })
    const backwardClock = updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.11:6768'),
      now: 50
    })
    const laterClock = updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.12:6768'),
      now: 200
    })

    expect([
      sameClock.pairingRevision,
      backwardClock.pairingRevision,
      laterClock.pairingRevision
    ]).toEqual([101, 102, 200])
  })

  it('rejects pairing the local Orca server to itself before saving it', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    writeStoredE2EEPublicKey(userDataPath, Buffer.from(new Uint8Array(32).fill(1)))

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'this server',
        pairingCode: pairingCode('ws://192.0.2.10:6768')
      })
    ).toThrow('This pairing code belongs to this Orca server.')
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('allows the same endpoint when it identifies a different Orca server', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    writeStoredE2EEPublicKey(userDataPath, Buffer.from(new Uint8Array(32).fill(2)))

    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'other server',
      pairingCode: pairingCode()
    })

    expect(listEnvironments(userDataPath)).toEqual([environment])
  })

  it('rejects self-pairing for callers that do not pass the local key, using the stored keypair', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    writeStoredE2EEPublicKey(userDataPath, Buffer.from(new Uint8Array(32).fill(1)))

    // The CLI and ephemeral-VM wiring call without localRuntimePublicKeyB64.
    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'this server',
        pairingCode: pairingCode()
      })
    ).toThrow('This pairing code belongs to this Orca server.')
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('allows a remote server reached over an SSH local port-forward at 127.0.0.1', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    // Why: a forwarded remote server shares this host's loopback address but
    // never its keypair, so identity-based detection must let it through.
    writeStoredE2EEPublicKey(userDataPath, Buffer.from(new Uint8Array(32).fill(9)))

    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'forwarded server',
      pairingCode: pairingCode('ws://127.0.0.1:6768')
    })

    expect(listEnvironments(userDataPath)).toEqual([environment])
  })

  it('keeps listing an already-saved self-referential environment', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    // Saved before this check existed; rejecting it at read time would break
    // startup and hide the entry the user needs in order to remove it.
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'itself',
      pairingCode: pairingCode()
    })
    writeStoredE2EEPublicKey(userDataPath, Buffer.from(new Uint8Array(32).fill(1)))

    expect(listEnvironments(userDataPath)).toEqual([environment])
  })

  it('still saves environments when no local keypair exists yet', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)

    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'workstation',
      pairingCode: pairingCode()
    })

    expect(listEnvironments(userDataPath)).toEqual([environment])
  })

  it('keeps SSH-tunnel metadata only while the pairing endpoint is loopback', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'tunneled box',
      pairingCode: pairingCode(),
      connectionDependency: 'ssh-tunnel'
    })
    expect(environment.connectionDependency).toBe('ssh-tunnel')

    const updated = updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.10:6768')
    })
    expect(updated).not.toHaveProperty('connectionDependency')

    const direct = addEnvironmentFromPairingCode(userDataPath, {
      name: 'direct box',
      pairingCode: pairingCode('ws://192.0.2.11:6768'),
      connectionDependency: 'ssh-tunnel'
    })
    expect(direct).not.toHaveProperty('connectionDependency')
  })

  it('throttles lastUsedAt writes so it does not rewrite the store on every runtime call', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    // First use persists (lastUsedAt started null).
    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 1_000 })
    expect(listEnvironments(userDataPath)[0]).toMatchObject({
      lastUsedAt: 1_000,
      runtimeId: 'runtime-1'
    })

    // A second use shortly after, same runtime, is skipped — lastUsedAt stays put.
    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 5_000 })
    expect(listEnvironments(userDataPath)[0]!.lastUsedAt).toBe(1_000)

    // Once the throttle window elapses, it persists again.
    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 61_000 })
    expect(listEnvironments(userDataPath)[0]!.lastUsedAt).toBe(61_000)
  })

  it('persists immediately when the runtimeId changes within the throttle window', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 1_000 })
    // A different runtimeId inside the window must not be dropped.
    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-2', now: 2_000 })
    expect(listEnvironments(userDataPath)[0]).toMatchObject({
      lastUsedAt: 2_000,
      runtimeId: 'runtime-2'
    })
  })

  it('persists paired device identity from pairing and status backfill', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const paired = addEnvironmentFromPairingCode(userDataPath, {
      name: 'paired box',
      pairingCode: pairingCode('ws://127.0.0.1:6768', 'device-from-offer'),
      now: 1_000
    })
    const legacy = addEnvironmentFromPairingCode(userDataPath, {
      name: 'legacy box',
      pairingCode: pairingCode('ws://192.0.2.10:6768'),
      now: 1_000
    })

    expect(paired.pairedDeviceId).toBe('device-from-offer')
    markEnvironmentUsed(userDataPath, legacy.id, {
      pairedDeviceId: 'device-from-status',
      now: 2_000
    })
    expect(listEnvironments(userDataPath).find((entry) => entry.id === legacy.id)).toMatchObject({
      pairedDeviceId: 'device-from-status',
      lastUsedAt: 2_000
    })
  })

  it('rejects an oversized sparse environment store before parsing it', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-bound-'))
    tempDirs.push(userDataPath)
    const path = getEnvironmentStorePath(userDataPath)
    writeFileSync(path, '{"version":1,"environments":[]}')
    truncateSync(path, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES + 1)

    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
  })

  it('rejects an oversized write without replacing the durable environment list', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-write-bound-'))
    tempDirs.push(userDataPath)
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'x'.repeat(MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES),
        pairingCode: pairingCode('ws://192.0.2.10:6768')
      })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(listEnvironments(userDataPath)).toEqual([first])
  })
})
