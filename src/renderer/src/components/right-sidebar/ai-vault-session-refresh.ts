import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AiVaultImportExternalTranscriptsResult,
  AiVaultListResult,
  AiVaultSession
} from '../../../../shared/ai-vault-types'

const SESSION_LIMIT = 500

export function useAiVaultSessionRefresh(scopePaths: readonly string[]): {
  error: string | null
  loading: boolean
  importing: boolean
  refresh: (args?: { force?: boolean }) => Promise<void>
  importExternalTranscripts: () => Promise<AiVaultImportExternalTranscriptsResult | null>
  scanResult: AiVaultListResult | null
  sessions: AiVaultSession[]
} {
  const [sessions, setSessions] = useState<AiVaultSession[]>([])
  const [scanResult, setScanResult] = useState<AiVaultListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshIdRef = useRef(0)
  const refreshInFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const pendingForceRef = useRef(false)
  const mountedRef = useRef(true)
  const scopePathsKey = useMemo(() => scopePaths.join('\n'), [scopePaths])
  const scopePathsRef = useRef<readonly string[]>(scopePaths)
  scopePathsRef.current = scopePaths

  const refresh = useCallback(async (args: { force?: boolean } = {}): Promise<void> => {
    // A scope change during an in-flight scan must not be dropped; queue one more
    // scan so the current scoped view is refreshed after the older scan settles.
    if (refreshInFlightRef.current) {
      pendingRefreshRef.current = true
      pendingForceRef.current ||= args.force === true
      return
    }

    refreshInFlightRef.current = true
    const refreshId = refreshIdRef.current + 1
    refreshIdRef.current = refreshId
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.aiVault.listSessions({
        limit: SESSION_LIMIT,
        scopePaths: scopePathsRef.current,
        force: args.force
      })
      if (!mountedRef.current || refreshIdRef.current !== refreshId) {
        return
      }
      setScanResult(result)
      setSessions(result.sessions)
    } catch (err) {
      if (mountedRef.current && refreshIdRef.current === refreshId) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      refreshInFlightRef.current = false
      if (mountedRef.current && refreshIdRef.current === refreshId) {
        setLoading(false)
      }
      if (pendingRefreshRef.current && mountedRef.current) {
        pendingRefreshRef.current = false
        const force = pendingForceRef.current
        pendingForceRef.current = false
        void refresh({ force })
      }
    }
    // Deps are intentionally empty: refresh reads changing values through refs
    // and recurses on itself, so its identity must stay stable.
  }, [])

  const importExternalTranscripts =
    useCallback(async (): Promise<AiVaultImportExternalTranscriptsResult | null> => {
      if (refreshInFlightRef.current || importing) {
        return null
      }
      setImporting(true)
      setError(null)
      try {
        const result = await window.api.aiVault.importExternalTranscripts({
          limit: SESSION_LIMIT,
          scopePaths: scopePathsRef.current
        })
        if (!mountedRef.current) {
          return null
        }
        setScanResult(result.listResult)
        setSessions(result.listResult.sessions)
        return result
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
        return null
      } finally {
        if (mountedRef.current) {
          setImporting(false)
        }
      }
    }, [importing])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      refreshIdRef.current += 1
      refreshInFlightRef.current = false
    }
  }, [])

  // Re-scan on mount and whenever the active scope changes, since the scanner
  // tailors its in-scope results to scopePaths.
  useEffect(() => {
    void refresh()
  }, [refresh, scopePathsKey])

  return {
    error,
    loading,
    importing,
    refresh,
    importExternalTranscripts,
    scanResult,
    sessions
  }
}
