import { z } from 'zod'
import { PLUGIN_PANEL_ACTIONS } from './plugin-panel-bridge'

/**
 * Plugin manifest (`orca-plugin.json` at the plugin root). The `contributes`
 * key names deliberately mirror VS Code manifest conventions so a future
 * adapter can map VS Code extension manifests onto Orca extension points.
 *
 * Lives in `shared` so the desktop app, the headless `orca serve` runtime,
 * and the CLI validate manifests identically (SSH/remote parity).
 */

// Why: ids become filesystem paths, IPC channel fragments, and sidebar tab
// keys — restrict to kebab-case so they never need escaping downstream.
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const pluginIdSchema = z.string().regex(PLUGIN_ID_RE, 'must be kebab-case (a-z, 0-9, dashes)')

// Why: entry paths are resolved against the plugin root; reject absolute
// paths and traversal so a manifest cannot point outside its own directory.
const relativeEntrySchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') && !value.startsWith('\\') && !/^[a-zA-Z]:/.test(value) && !value.split(/[\\/]/).includes('..'),
    'must be a relative path inside the plugin directory'
  )

const codeProviderContributionSchema = z.object({
  id: pluginIdSchema,
  displayName: z.string().min(1),
  /** Language ids the provider serves; `['*']` means all languages. */
  languages: z.array(z.string().min(1)).nonempty().default(['*'])
})

const panelContributionSchema = z.object({
  id: pluginIdSchema,
  title: z.string().min(1),
  /** Lucide icon name rendered in the right-sidebar activity bar. */
  icon: z.string().min(1).optional(),
  /** HTML entry rendered inside a sandboxed panel frame. */
  entry: relativeEntrySchema
})

const commandContributionSchema = z.object({
  id: pluginIdSchema,
  title: z.string().min(1)
})

export const pluginManifestSchema = z.object({
  id: pluginIdSchema,
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'must be semver'),
  description: z.string().optional(),
  engines: z.object({ orca: z.string().min(1) }),
  /** Node entry executed inside the out-of-process plugin host. */
  main: relativeEntrySchema.optional(),
  contributes: z
    .object({
      codeProviders: z.array(codeProviderContributionSchema).default([]),
      panels: z.array(panelContributionSchema).default([]),
      commands: z.array(commandContributionSchema).default([]),
      // Why: permission ids are a closed enum so a typo (or a permission from
      // a newer Orca) fails manifest validation instead of silently granting
      // nothing at action time.
      permissions: z.array(z.enum(PLUGIN_PANEL_ACTIONS)).default([])
    })
    .default({ codeProviders: [], panels: [], commands: [], permissions: [] })
})

export type PluginManifest = z.infer<typeof pluginManifestSchema>
export type PluginCodeProviderContribution = z.infer<typeof codeProviderContributionSchema>
export type PluginPanelContribution = z.infer<typeof panelContributionSchema>
export type PluginCommandContribution = z.infer<typeof commandContributionSchema>

export const PLUGIN_MANIFEST_FILENAME = 'orca-plugin.json'

export type PluginManifestParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string }

export function parsePluginManifest(raw: unknown): PluginManifestParseResult {
  const parsed = pluginManifestSchema.safeParse(raw)
  if (parsed.success) {
    return { ok: true, manifest: parsed.data }
  }
  const issue = parsed.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid manifest'}` }
}

/** Sidebar tab key for a plugin panel: `plugin:<pluginId>/<panelId>`. */
export function pluginPanelTabKey(pluginId: string, panelId: string): `plugin:${string}` {
  return `plugin:${pluginId}/${panelId}`
}

export function isPluginPanelTabKey(tab: string): tab is `plugin:${string}` {
  if (!tab.startsWith('plugin:')) {
    return false
  }
  const rest = tab.slice('plugin:'.length)
  const [pluginId, panelId, ...extra] = rest.split('/')
  return (
    extra.length === 0 &&
    !!pluginId &&
    !!panelId &&
    PLUGIN_ID_RE.test(pluginId) &&
    PLUGIN_ID_RE.test(panelId)
  )
}
