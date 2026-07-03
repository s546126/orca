import type {
  CodeHover,
  CodeLocation,
  CodeProvider,
  CodeProviderContext,
  CodeSymbol
} from '../../shared/plugins/code-provider'
import { CODE_PROVIDER_EXTENSION_POINT } from '../../shared/plugins/plugin-extension-registry'
import type { PluginHostRegistration } from '../../shared/plugins/plugin-host-protocol'
import type { PluginHostHandle } from './plugin-host-process'

/**
 * Builds an in-process CodeProvider whose methods forward to the plugin host
 * child process. Methods are attached only when the registration listed them,
 * so `supportsCodeProviderMethod` capability probing keeps working across the
 * process boundary.
 */
export function createCodeProviderProxy(
  host: PluginHostHandle,
  registration: PluginHostRegistration
): CodeProvider {
  const forward = (method: string, args: unknown[]): Promise<unknown> =>
    host.invoke(CODE_PROVIDER_EXTENSION_POINT.key, registration.providerId, method, args)

  const provider: CodeProvider = { id: registration.providerId }
  // Why: results crossed the fork IPC boundary as structured-clone data; the
  // protocol treats them as opaque, so the casts assert the contract shape.
  if (registration.methods.includes('searchSymbols')) {
    provider.searchSymbols = (query: string, context: CodeProviderContext) =>
      forward('searchSymbols', [query, context]) as Promise<CodeSymbol[]>
  }
  if (registration.methods.includes('provideHover')) {
    provider.provideHover = (
      file: string,
      line: number,
      column: number,
      context: CodeProviderContext
    ) => forward('provideHover', [file, line, column, context]) as Promise<CodeHover | null>
  }
  if (registration.methods.includes('provideDefinition')) {
    provider.provideDefinition = (
      file: string,
      line: number,
      column: number,
      context: CodeProviderContext
    ) => forward('provideDefinition', [file, line, column, context]) as Promise<CodeLocation[]>
  }
  return provider
}
