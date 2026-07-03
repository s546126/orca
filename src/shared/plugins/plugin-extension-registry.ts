import type { CodeProvider } from './code-provider'

/**
 * Typed extension-point registry. An extension point is a named, typed slot
 * (like a Go interface value); plugins register implementations and hosts
 * resolve them without compile-time knowledge of the implementor. Follows the
 * `FORGE_PROVIDERS` registry shape but with runtime registration because
 * plugins load dynamically.
 */

declare const extensionPointBrand: unique symbol

export type PluginExtensionPoint<T> = {
  readonly key: string
  // Why: phantom field carries T so register/resolve stay type-safe per point
  // even though the runtime value is just `{ key }`.
  readonly [extensionPointBrand]?: T
}

export function definePluginExtensionPoint<T>(key: string): PluginExtensionPoint<T> {
  return { key }
}

export const CODE_PROVIDER_EXTENSION_POINT = definePluginExtensionPoint<CodeProvider>('codeProvider')

export type PluginExtensionRegistration<T> = {
  pluginId: string
  implementation: T
}

export type PluginExtensionRegistry = {
  register<T>(point: PluginExtensionPoint<T>, pluginId: string, implementation: T): () => void
  resolveAll<T>(point: PluginExtensionPoint<T>): PluginExtensionRegistration<T>[]
  resolve<T>(point: PluginExtensionPoint<T>, pluginId: string): T | null
  clearPlugin(pluginId: string): void
}

export function createPluginExtensionRegistry(): PluginExtensionRegistry {
  const byPoint = new Map<string, PluginExtensionRegistration<unknown>[]>()

  return {
    register(point, pluginId, implementation) {
      const registrations = byPoint.get(point.key) ?? []
      const entry = { pluginId, implementation }
      byPoint.set(point.key, [...registrations, entry])
      return () => {
        const current = byPoint.get(point.key) ?? []
        byPoint.set(
          point.key,
          current.filter((registration) => registration !== entry)
        )
      }
    },
    resolveAll<T>(point: PluginExtensionPoint<T>) {
      return (byPoint.get(point.key) ?? []) as PluginExtensionRegistration<T>[]
    },
    resolve<T>(point: PluginExtensionPoint<T>, pluginId: string) {
      const registrations = (byPoint.get(point.key) ?? []) as PluginExtensionRegistration<T>[]
      return registrations.find((registration) => registration.pluginId === pluginId)?.implementation ?? null
    },
    clearPlugin(pluginId) {
      for (const [key, registrations] of byPoint) {
        byPoint.set(
          key,
          registrations.filter((registration) => registration.pluginId !== pluginId)
        )
      }
    }
  }
}

export function isPluginEnabled(pluginId: string, disabledPlugins: readonly string[]): boolean {
  return !disabledPlugins.includes(pluginId)
}

export function normalizeDisabledPlugins(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))]
}
