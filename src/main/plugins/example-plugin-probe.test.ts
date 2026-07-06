import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../../shared/plugins/plugin-manifest'
import type { PluginHostChildMessage } from '../../shared/plugins/plugin-host-protocol'
import { createPluginHostRuntime } from './plugin-host-runtime'

const EXAMPLE_ROOT = resolve(__dirname, '../../../examples/plugins/hello-orca')
const MODEL_SHIFT_ROOT = resolve(__dirname, '../../../examples/plugins/model-shift')

describe('shipped hello-orca example plugin', () => {
  it('activates through the real host runtime and answers searchSymbols', async () => {
    const manifestRaw = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(EXAMPLE_ROOT, 'orca-plugin.json'), 'utf8')
    )
    const parsed = parsePluginManifest(JSON.parse(manifestRaw))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }

    const messages: PluginHostChildMessage[] = []
    const runtime = createPluginHostRuntime({ send: (m) => messages.push(m) })
    await runtime.handleMessage({
      type: 'init',
      pluginRoot: EXAMPLE_ROOT,
      mainEntry: parsed.manifest.main!,
      pluginId: parsed.manifest.id
    })
    const ready = messages.find((m) => m.type === 'ready')
    expect(ready).toBeTruthy()
    if (ready?.type !== 'ready') {
      return
    }
    expect(ready.registrations[0]).toMatchObject({
      extensionPoint: 'codeProvider',
      providerId: 'todo-scanner',
      methods: ['searchSymbols']
    })

    const workspaceRoot = mkdtempSync(join(tmpdir(), 'orca-plugin-probe-'))
    writeFileSync(join(workspaceRoot, 'sample.ts'), '// TODO: probe the plugin system\n')
    await runtime.handleMessage({
      type: 'invoke',
      callId: 1,
      extensionPoint: 'codeProvider',
      providerId: 'todo-scanner',
      method: 'searchSymbols',
      args: ['probe', { workspaceRoot }]
    })
    const result = messages.find((m) => m.type === 'result')
    expect(result).toMatchObject({ ok: true })
    if (result?.type !== 'result') {
      return
    }
    expect(result.value).toEqual([
      { name: 'probe the plugin system', kind: 'todo', file: 'sample.ts', line: 1 }
    ])
  })
})

describe('shipped model-shift example plugin', () => {
  it('has a valid manifest granting only panel-bridge permissions', async () => {
    const manifestRaw = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(MODEL_SHIFT_ROOT, 'orca-plugin.json'), 'utf8')
    )
    const parsed = parsePluginManifest(JSON.parse(manifestRaw))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.manifest.id).toBe('model-shift')
    expect(parsed.manifest.contributes.permissions).toEqual([
      'terminal.sendText',
      'workspace.readContext'
    ])
    expect(parsed.manifest.contributes.panels).toEqual([
      { id: 'gear-shifter', title: 'ModelShift', icon: 'gauge', entry: 'panel.html' }
    ])
    // Panel-only plugin: no host process should ever be spawned for it.
    expect(parsed.manifest.main).toBeUndefined()
  })
})
