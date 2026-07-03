import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startPluginHost, resolvePluginHostEntryPath } from './plugin-host-process'

// Speaks the parent/child protocol like plugin-host-entry.js would; the real
// entry's logic is covered by plugin-host-runtime.test.ts without forking.
const ECHO_HOST_FIXTURE = `
process.on('message', (message) => {
  if (message.type === 'init') {
    process.send({
      type: 'ready',
      registrations: [
        {
          extensionPoint: 'codeProvider',
          providerId: message.pluginId + '-provider',
          methods: ['searchSymbols']
        }
      ]
    })
  } else if (message.type === 'invoke') {
    if (message.method === 'searchSymbols') {
      process.send({ type: 'result', callId: message.callId, ok: true, value: message.args })
    } else {
      process.send({ type: 'result', callId: message.callId, ok: false, error: 'echo: boom' })
    }
  } else if (message.type === 'shutdown') {
    process.exit(0)
  }
})
`

const SILENT_HOST_FIXTURE = `
setInterval(() => {}, 1000)
process.on('message', () => {})
`

const EXITING_HOST_FIXTURE = `
process.exit(3)
`

describe('plugin-host-process', () => {
  let fixtureDir: string
  let echoEntryPath: string
  let silentEntryPath: string
  let exitingEntryPath: string

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'orca-plugin-host-fixture-'))
    echoEntryPath = join(fixtureDir, 'echo-host.cjs')
    silentEntryPath = join(fixtureDir, 'silent-host.cjs')
    exitingEntryPath = join(fixtureDir, 'exiting-host.cjs')
    await writeFile(echoEntryPath, ECHO_HOST_FIXTURE)
    await writeFile(silentEntryPath, SILENT_HOST_FIXTURE)
    await writeFile(exitingEntryPath, EXITING_HOST_FIXTURE)
  })

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true })
  })

  it('starts a host, receives registrations, invokes, and disposes', async () => {
    const host = await startPluginHost({
      pluginId: 'alpha',
      rootDir: '/plugin/alpha',
      mainEntry: 'index.js',
      entryPath: echoEntryPath
    })
    expect(host.registrations).toEqual([
      { extensionPoint: 'codeProvider', providerId: 'alpha-provider', methods: ['searchSymbols'] }
    ])

    const echoed = await host.invoke('codeProvider', 'alpha-provider', 'searchSymbols', [
      'query',
      { workspaceRoot: '/ws' }
    ])
    expect(echoed).toEqual(['query', { workspaceRoot: '/ws' }])

    await expect(host.invoke('codeProvider', 'alpha-provider', 'provideHover', [])).rejects.toThrow(
      'echo: boom'
    )

    const exitCode = new Promise<number | null>((resolve) => host.onExit(resolve))
    await host.dispose()
    expect(await exitCode).toBe(0)
    await expect(
      host.invoke('codeProvider', 'alpha-provider', 'searchSymbols', [])
    ).rejects.toThrow('not running')
  })

  it('rejects with a ready timeout when the child never replies', async () => {
    await expect(
      startPluginHost({
        pluginId: 'silent',
        rootDir: '/plugin/silent',
        mainEntry: 'index.js',
        entryPath: silentEntryPath,
        readyTimeoutMs: 400
      })
    ).rejects.toThrow('did not become ready')
  })

  it('rejects when the child exits before signalling ready', async () => {
    await expect(
      startPluginHost({
        pluginId: 'exiting',
        rootDir: '/plugin/exiting',
        mainEntry: 'index.js',
        entryPath: exitingEntryPath
      })
    ).rejects.toThrow('exited before ready')
  })

  it('resolvePluginHostEntryPath redirects packaged asar paths to the unpacked copy', () => {
    const packaged = resolvePluginHostEntryPath(join('/apps', 'app.asar'), true)
    expect(packaged).toBe(join('/apps', 'app.asar.unpacked', 'out', 'main', 'plugin-host-entry.js'))
    const dev = resolvePluginHostEntryPath('/repo', false)
    expect(dev).toBe(join('/repo', 'out', 'main', 'plugin-host-entry.js'))
  })
})
