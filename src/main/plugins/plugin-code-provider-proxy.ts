import { z } from 'zod'
import {
  codeHoverSchema,
  codeLocationSchema,
  codeSymbolSchema,
  type CodeProvider,
  type CodeProviderContext
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

  // Why: results crossed the fork IPC boundary as structured-clone data from
  // code Orca does not control — decode instead of casting so a malformed
  // plugin response fails here, not in a hover/symbol consumer.
  const decode = <T>(method: string, schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      throw new Error(`plugin returned a malformed ${method} result`, { cause: parsed.error })
    }
    return parsed.data
  }

  const provider: CodeProvider = { id: registration.providerId }
  if (registration.methods.includes('searchSymbols')) {
    provider.searchSymbols = async (query: string, context: CodeProviderContext) =>
      decode(
        'searchSymbols',
        z.array(codeSymbolSchema),
        await forward('searchSymbols', [query, context])
      )
  }
  if (registration.methods.includes('provideHover')) {
    provider.provideHover = async (
      file: string,
      line: number,
      column: number,
      context: CodeProviderContext
    ) =>
      decode(
        'provideHover',
        // Plugins may resolve undefined for "no hover"; normalize to null.
        codeHoverSchema.nullish().transform((value) => value ?? null),
        await forward('provideHover', [file, line, column, context])
      )
  }
  if (registration.methods.includes('provideDefinition')) {
    provider.provideDefinition = async (
      file: string,
      line: number,
      column: number,
      context: CodeProviderContext
    ) =>
      decode(
        'provideDefinition',
        z.array(codeLocationSchema),
        await forward('provideDefinition', [file, line, column, context])
      )
  }
  return provider
}
