/**
 * CodeProvider contract — the first Go-style plugin interface. A plugin
 * implements any subset of the optional methods; Orca dispatches through the
 * extension registry without knowing which plugin (or process) answers.
 *
 * Electron-free on purpose: implementations run in the out-of-process plugin
 * host, and proxies for them are constructed in both the desktop main process
 * and the headless `orca serve` runtime.
 */

export type CodeProviderContext = {
  /** Absolute root of the workspace/worktree the request is scoped to. */
  workspaceRoot: string
}

export type CodeSymbolKind =
  | 'file'
  | 'class'
  | 'function'
  | 'variable'
  | 'constant'
  | 'interface'
  | 'todo'
  | 'other'

export type CodeSymbol = {
  name: string
  kind: CodeSymbolKind
  /** Path relative to the workspace root. */
  file: string
  /** 1-based line number. */
  line: number
  detail?: string
}

export type CodeHover = {
  /** Markdown contents shown in the hover widget. */
  contents: string
}

export type CodeLocation = {
  file: string
  line: number
  column: number
}

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
