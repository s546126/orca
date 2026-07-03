import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest,
  type PluginManifest
} from '../../shared/plugins/plugin-manifest'

export type ValidDiscoveredPlugin = {
  pluginId: string
  rootDir: string
  manifest: PluginManifest
}

export type InvalidDiscoveredPlugin = {
  pluginId?: string
  rootDir: string
  error: string
}

export type DiscoveredPlugin = ValidDiscoveredPlugin | InvalidDiscoveredPlugin

export function isInvalidDiscoveredPlugin(
  plugin: DiscoveredPlugin
): plugin is InvalidDiscoveredPlugin {
  return 'error' in plugin
}

export function getUserPluginsDir(userDataPath: string): string {
  return join(userDataPath, 'plugins')
}

async function readPluginDir(rootDir: string, dirName: string): Promise<DiscoveredPlugin> {
  const manifestPath = join(rootDir, PLUGIN_MANIFEST_FILENAME)
  let rawText: string
  try {
    rawText = await readFile(manifestPath, 'utf8')
  } catch {
    return { rootDir, error: `missing ${PLUGIN_MANIFEST_FILENAME}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch (error) {
    return {
      rootDir,
      error: `invalid JSON in ${PLUGIN_MANIFEST_FILENAME}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const parsed = parsePluginManifest(raw)
  if (!parsed.ok) {
    return { rootDir, error: `invalid manifest: ${parsed.error}` }
  }
  // Why: the directory name is the install key (and future uninstall target);
  // a mismatched manifest id would let two directories claim the same plugin.
  if (parsed.manifest.id !== dirName) {
    return {
      pluginId: parsed.manifest.id,
      rootDir,
      error: `manifest id "${parsed.manifest.id}" does not match directory name "${dirName}"`
    }
  }
  return { pluginId: parsed.manifest.id, rootDir, manifest: parsed.manifest }
}

export async function discoverPlugins(pluginsDir: string): Promise<DiscoveredPlugin[]> {
  let entries
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true })
  } catch {
    // A missing plugins dir just means no plugins are installed yet.
    return []
  }
  const discovered: DiscoveredPlugin[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue
    }
    discovered.push(await readPluginDir(join(pluginsDir, entry.name), entry.name))
  }
  return discovered
}
