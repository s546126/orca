import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  searchAiVaultSessionsWithAi,
  type AiVaultAiSearchResult
} from '../../../../shared/ai-vault-session-ai-query'
import {
  filterAiVaultSessions,
  type AiVaultSessionFilterState
} from '../../../../shared/ai-vault-session-filters'
import { AiVaultSessionSearchIndex } from '../../../../shared/ai-vault-session-index'
import { parseVaultQuery } from '../../../../shared/ai-vault-session-query'
import { isAiVaultRgSearchScope } from '../../../../shared/ai-vault-session-search-scope'
import type { AiVaultSessionMessageHit } from '../../../../shared/ai-vault-session-message-hit'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

const RG_SEARCH_DEBOUNCE_MS = 280

export function useAiVaultSessionSearch(args: {
  sessions: readonly AiVaultSession[]
  filters: AiVaultSessionFilterState
  repoId?: string | null
}): {
  filteredSessions: AiVaultSession[]
  aiLoading: boolean
  aiError: string | null
  usedModel: boolean
  rgLoading: boolean
  rgHitCount: number | null
  usedRg: boolean
  usedFts: boolean
  messageHitsBySessionId: ReadonlyMap<string, AiVaultSessionMessageHit>
  runAiSearch: () => Promise<void>
} {
  const { sessions, filters, repoId } = args
  const indexRef = useRef(new AiVaultSessionSearchIndex())
  const [aiResult, setAiResult] = useState<AiVaultAiSearchResult | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [rgMatchedIds, setRgMatchedIds] = useState<string[] | null>(null)
  const [rgLoading, setRgLoading] = useState(false)
  const [usedRg, setUsedRg] = useState(false)
  const [usedFts, setUsedFts] = useState(false)
  const [messageHits, setMessageHits] = useState<AiVaultSessionMessageHit[]>([])
  const [rgUnavailable, setRgUnavailable] = useState(false)
  const requestIdRef = useRef(0)
  const rgRequestIdRef = useRef(0)

  const lexicalSessions = useMemo(() => {
    indexRef.current.sync(sessions, {
      sessionProjectById: filters.sessionProjectById,
      projectLabelByKey: filters.projectLabelByKey
    })
    return filterAiVaultSessions(sessions, filters, {
      index: indexRef.current
    })
  }, [filters, sessions])

  const searchTerms = useMemo(() => parseVaultQuery(filters.query).terms, [filters.query])
  const usesRgScope = isAiVaultRgSearchScope(filters.searchScope ?? 'full')
  const rgQueryActive = usesRgScope && searchTerms.length > 0
  const candidateIdKey = lexicalSessions.map((session) => session.id).join('\n')

  useEffect(() => {
    // Why: a slower AI/rg request must not restore hits from a previous query,
    // host, project, or workspace scope after the user already changed inputs.
    requestIdRef.current += 1
    rgRequestIdRef.current += 1
    setAiResult(null)
    setAiError(null)
    setAiLoading(false)
    setRgMatchedIds(null)
    setRgLoading(false)
    setUsedRg(false)
    setUsedFts(false)
    setMessageHits([])
    setRgUnavailable(false)
  }, [
    filters.activeProjectKey,
    filters.activeWorktreePaths,
    filters.agents,
    filters.hideEmptySessions,
    filters.hosts,
    filters.projectLabelByKey,
    filters.query,
    filters.scope,
    filters.searchScope,
    filters.sessionProjectById,
    filters.sort,
    filters.timeRange,
    sessions
  ])

  useEffect(() => {
    if (!rgQueryActive) {
      rgRequestIdRef.current += 1
      setRgMatchedIds(null)
      setRgLoading(false)
      setUsedRg(false)
      setUsedFts(false)
      setMessageHits([])
      setRgUnavailable(false)
      return
    }

    const requestId = rgRequestIdRef.current + 1
    rgRequestIdRef.current = requestId
    setRgUnavailable(false)
    setRgLoading(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await window.api.aiVault.searchSessions({
            query: searchTerms.join(' '),
            searchScope:
              filters.searchScope === 'title' || filters.searchScope === 'summary'
                ? 'full'
                : (filters.searchScope ?? 'full'),
            sessionIds: candidateIdKey.split('\n').filter(Boolean)
          })
          if (rgRequestIdRef.current !== requestId) {
            return
          }
          if (!result.usedRg && !result.usedFts) {
            setRgMatchedIds(null)
            setUsedRg(false)
            setUsedFts(false)
            setMessageHits([])
            setRgUnavailable(true)
            return
          }
          setRgMatchedIds(result.matchedIds)
          setUsedRg(result.usedRg)
          setUsedFts(result.usedFts)
          setMessageHits(result.hits)
          setRgUnavailable(false)
        } catch {
          if (rgRequestIdRef.current === requestId) {
            setRgMatchedIds(null)
            setUsedRg(false)
            setUsedFts(false)
            setMessageHits([])
            setRgUnavailable(true)
          }
        } finally {
          if (rgRequestIdRef.current === requestId) {
            setRgLoading(false)
          }
        }
      })()
    }, RG_SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [candidateIdKey, filters.searchScope, rgQueryActive, searchTerms])

  const cardFallbackSessions = useMemo(() => {
    if (!rgQueryActive || !rgUnavailable) {
      return null
    }
    return filterAiVaultSessions(sessions, filters, {
      index: indexRef.current,
      forceCardTerms: true
    })
  }, [filters, rgQueryActive, rgUnavailable, sessions])

  const retrievalSessions = useMemo(() => {
    if (!rgQueryActive) {
      return lexicalSessions
    }
    if (cardFallbackSessions) {
      return cardFallbackSessions
    }
    if ((!usedRg && !usedFts) || rgMatchedIds === null) {
      // Why: keep the panel usable while rg is in flight; do not block typing.
      return lexicalSessions
    }
    const allowed = new Set(rgMatchedIds)
    return lexicalSessions.filter((session) => allowed.has(session.id))
  }, [cardFallbackSessions, lexicalSessions, rgMatchedIds, rgQueryActive, usedFts, usedRg])

  const runAiSearch = useCallback(async () => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setAiLoading(true)
    setAiError(null)
    try {
      const result = await searchAiVaultSessionsWithAi({
        sessions: retrievalSessions,
        filters,
        candidates: retrievalSessions,
        options: { index: indexRef.current },
        rerank: async (query, cards) => {
          const ranked = await window.api.aiVault.rankSessions({ query, cards, repoId })
          if (!ranked.ok && ranked.error) {
            throw new Error(ranked.error)
          }
          return { rankedIds: ranked.rankedIds, usedModel: ranked.usedModel }
        }
      })
      if (requestIdRef.current === requestId) {
        setAiResult(result)
      }
    } catch (error) {
      if (requestIdRef.current === requestId) {
        setAiError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setAiLoading(false)
      }
    }
  }, [filters, repoId, retrievalSessions])

  return {
    filteredSessions: aiResult?.sessions ?? retrievalSessions,
    aiLoading,
    aiError,
    usedModel: aiResult?.usedModel ?? false,
    rgLoading,
    rgHitCount: rgQueryActive && (usedRg || usedFts) && rgMatchedIds ? rgMatchedIds.length : null,
    usedRg,
    usedFts,
    messageHitsBySessionId: new Map(messageHits.map((hit) => [hit.sessionId, hit])),
    runAiSearch
  }
}
