import { describe, expect, it } from 'vitest'
import {
  isPluginPanelTabKey,
  parsePluginManifest,
  pluginPanelTabKey
} from './plugin-manifest'

const VALID = {
  id: 'hello-orca',
  name: 'Hello Orca',
  version: '1.0.0',
  engines: { orca: '>=1.4.0' },
  main: 'main.js',
  contributes: {
    codeProviders: [{ id: 'todo-scanner', displayName: 'TODO Scanner' }],
    panels: [{ id: 'hello', title: 'Hello', entry: 'panel.html' }]
  }
}

describe('parsePluginManifest', () => {
  it('accepts a valid manifest and applies defaults', () => {
    const result = parsePluginManifest(VALID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.contributes.commands).toEqual([])
    expect(result.manifest.contributes.codeProviders[0].languages).toEqual(['*'])
  })

  it('rejects non-kebab-case ids', () => {
    const result = parsePluginManifest({ ...VALID, id: 'Hello_Orca' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('id')
  })

  it('rejects entry paths that escape the plugin directory', () => {
    for (const entry of ['../evil.html', '/etc/passwd', 'C:\\evil.html', 'a/../../b.html']) {
      const manifest = {
        ...VALID,
        contributes: { panels: [{ id: 'p', title: 'P', entry }] }
      }
      expect(parsePluginManifest(manifest).ok).toBe(false)
    }
  })

  it('rejects non-semver versions and missing engines', () => {
    expect(parsePluginManifest({ ...VALID, version: 'v1' }).ok).toBe(false)
    expect(parsePluginManifest({ ...VALID, engines: undefined }).ok).toBe(false)
  })
})

describe('plugin panel tab keys', () => {
  it('round-trips through the key builder', () => {
    const key = pluginPanelTabKey('hello-orca', 'hello')
    expect(key).toBe('plugin:hello-orca/hello')
    expect(isPluginPanelTabKey(key)).toBe(true)
  })

  it('rejects malformed keys', () => {
    expect(isPluginPanelTabKey('plugin:')).toBe(false)
    expect(isPluginPanelTabKey('plugin:only-plugin-id')).toBe(false)
    expect(isPluginPanelTabKey('plugin:a/b/c')).toBe(false)
    expect(isPluginPanelTabKey('plugin:Bad_Id/panel')).toBe(false)
    expect(isPluginPanelTabKey('explorer')).toBe(false)
  })
})
