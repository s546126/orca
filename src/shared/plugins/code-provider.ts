/**
 * CodeProvider contract — the first Go-style plugin interface. A plugin
 * implements any subset of the optional methods; Orca dispatches through the
 * extension registry without knowing which plugin (or process) answers.
 *
 * Electron-free on purpose: implementations run in the out-of-process plugin
 * host, and proxies for them are constructed in both the desktop main process
 * and the headless `orca serve` runtime.
 */

import { z } from 'zod'

export type CodeProviderContext = {
  /** Absolute root of the workspace/worktree the request is scoped to. */
  workspaceRoot: string
}

export const CODE_SYMBOL_KINDS = [
  'file',
  'class',
  'function',
  'variable',
  'constant',
  'interface',
  'todo',
  'other'
] as const

export type CodeSymbolKind = (typeof CODE_SYMBOL_KINDS)[number]

// Why: method results cross the plugin-host fork boundary as structured-clone
// data; proxies decode with these schemas so a malformed plugin response
// fails loudly at the boundary instead of reaching consumers untyped.
export const codeSymbolSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(CODE_SYMBOL_KINDS),
  /** Path relative to the workspace root. */
  file: z.string(),
  /** 1-based line number. */
  line: z.number(),
  detail: z.string().optional()
})

export const codeHoverSchema = z.object({
  /** Markdown contents shown in the hover widget. */
  contents: z.string()
})

export const codeLocationSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number()
})

export type CodeSymbol = z.infer<typeof codeSymbolSchema>
export type CodeHover = z.infer<typeof codeHoverSchema>
export type CodeLocation = z.infer<typeof codeLocationSchema>

/**
 * All methods are optional so a provider can implement exactly the surface it
 * supports — callers probe with `supportsCodeProviderMethod` before invoking.
 */
export type CodeProvider = {
  readonly id: string
  searchSymbols?(query: string, context: CodeProviderContext): Promise<CodeSymbol[]>
  provideHover?(
    file: string,
    line: number,
    column: number,
    context: CodeProviderContext
  ): Promise<CodeHover | null>
  provideDefinition?(
    file: string,
    line: number,
    column: number,
    context: CodeProviderContext
  ): Promise<CodeLocation[]>
}

export const CODE_PROVIDER_METHODS = ['searchSymbols', 'provideHover', 'provideDefinition'] as const

export type CodeProviderMethod = (typeof CODE_PROVIDER_METHODS)[number]

export function isCodeProviderMethod(value: string): value is CodeProviderMethod {
  return (CODE_PROVIDER_METHODS as readonly string[]).includes(value)
}

export function supportsCodeProviderMethod(
  provider: CodeProvider,
  method: CodeProviderMethod
): boolean {
  return typeof provider[method] === 'function'
}
