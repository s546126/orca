export const FOREIGN_SESSION_IMPORT_SOURCE_BYTES = 16 * 1024 * 1024
export const FOREIGN_SESSION_IMPORT_MAX_FILES = 100
const MAX_GAPS = 8

export function rememberGap(gaps: string[], gap: string): void {
  if (gaps.length >= MAX_GAPS || gaps.includes(gap)) {
    return
  }
  gaps.push(gap)
}

export function titleFromUserText(text: string | null): string {
  const trimmed = text?.trim() ?? ''
  if (!trimmed) {
    return 'Imported session'
  }
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed
}
