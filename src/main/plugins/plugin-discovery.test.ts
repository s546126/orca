import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PLUGIN_MANIFEST_FILENAME } from '../../shared/plugins/plugin-manifest'
import { discoverPlugins, getUserPluginsDir, isInvalidDiscoveredPlugin } from './plugin-discovery'

function validManifest(id: string): string {
  return JSON.stringify({
    id,
    name: `Plugin ${id}`,
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    main: 'index.js',
    contributes: {
      panels: [{ id: 'panel', title: 'Panel', entry: 'panel/index.html' }]
    }
  })
}

describe('plugin-discovery', () => {
  let pluginsDir: string

  beforeEach(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), 'orca-plugins-'))
  })

  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true })
  })

  async function writePlugin(dirName: string, manifestText: string): Promise<void> {
    const dir = join(pluginsDir, dirName)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, PLUGIN_MANIFEST_FILENAME), manifestText)
  }

  it('discovers a valid plugin with its parsed manifest', async () => {
    await writePlugin('alpha', validManifest('alpha'))
    const discovered = await discoverPlugins(pluginsDir)
    expect(discovered).toHaveLength(1)
    const plugin = discovered[0]!
    expect(isInvalidDiscoveredPlugin(plugin)).toBe(false)
    if (!isInvalidDiscoveredPlugin(plugin)) {
      expect(plugin.pluginId).toBe('alpha')
      expect(plugin.rootDir).toBe(join(pluginsDir, 'alpha'))
      expect(plugin.manifest.name).toBe('Plugin alpha')
      expect(plugin.manifest.contributes.panels).toHaveLength(1)
    }
  })

  it('records invalid JSON as an error entry', async () => {
    await writePlugin('broken', '{ not json')
    const discovered = await discoverPlugins(pluginsDir)
    expect(discovered).toHaveLength(1)
    const plugin = discovered[0]!
    expect(isInvalidDiscoveredPlugin(plugin)).toBe(true)
    if (isInvalidDiscoveredPlugin(plugin)) {
      expect(plugin.error).toContain('invalid JSON')
      expect(plugin.pluginId).toBeUndefined()
    }
  })

  it('records a schema-invalid manifest as an error entry', async () => {
    await writePlugin('bad-schema', JSON.stringify({ id: 'bad-schema', name: 'x' }))
    const discovered = await discoverPlugins(pluginsDir)
    expect(discovered).toHaveLength(1)
    expect(isInvalidDiscoveredPlugin(discovered[0]!)).toBe(true)
  })

  it('records a directory/manifest id mismatch as an error entry', async () => {
    await writePlugin('wrong-dir', validManifest('other-id'))
    const discovered = await discoverPlugins(pluginsDir)
    expect(discovered).toHaveLength(1)
    const plugin = discovered[0]!
    expect(isInvalidDiscoveredPlugin(plugin)).toBe(true)
    if (isInvalidDiscoveredPlugin(plugin)) {
      expect(plugin.pluginId).toBe('other-id')
      expect(plugin.error).toContain('does not match directory name')
    }
  })

  it('records a directory without a manifest as an error entry', async () => {
    await mkdir(join(pluginsDir, 'empty-dir'))
    const discovered = await discoverPlugins(pluginsDir)
    expect(discovered).toHaveLength(1)
    const plugin = discovered[0]!
    expect(isInvalidDiscoveredPlugin(plugin)).toBe(true)
    if (isInvalidDiscoveredPlugin(plugin)) {
      expect(plugin.error).toContain(PLUGIN_MANIFEST_FILENAME)
    }
  })

  it('skips loose files and dot-directories', async () => {
    await writeFile(join(pluginsDir, 'stray.txt'), 'not a plugin')
    await mkdir(join(pluginsDir, '.hidden'))
    await writePlugin('alpha', validManifest('alpha'))
    const discovered = await discoverPlugins(pluginsDir)
    expect(discovered).toHaveLength(1)
  })

  it('returns an empty list for a missing plugins dir', async () => {
    const discovered = await discoverPlugins(join(pluginsDir, 'does-not-exist'))
    expect(discovered).toEqual([])
  })

  it('getUserPluginsDir joins userData with plugins', () => {
    expect(getUserPluginsDir('/data')).toBe(join('/data', 'plugins'))
  })
})
