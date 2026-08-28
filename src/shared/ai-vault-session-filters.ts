// Why: this is the pure filter/group/query core for Agent Session History.
// It lives in /shared (not renderer) so the mobile package can reuse it —
// Metro only watches mobile/ + repo-root src/shared, never src/renderer.
// INVARIANT: /shared is a leaf — this module must NOT import from src/renderer.
import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'
import type {
  AiVaultAgent,
  AiVaultScope,
  AiVaultSession,
  AiVaultSessionHost,
  AiVaultSort,
  AiVaultTimeRange
} from './ai-vault-types'
import {
  isAiVaultSessionRecoverableEmpty,
  isAiVaultSessionResumableContent
} from './ai-vault-types'
import {
  AiVaultSessionSearchIndex,
  type AiVaultIndexQueryMode,
  type AiVaultIndexedSession
} from './ai-vault-session-index'
import {
  agentLabel,
  folderGroupKey,
  folderLabel,
  groupAiVaultSessions,
  type AiVaultSessionGroup,
  type AiVaultSessionProject
} from './ai-vault-session-groups'
import {
  AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES,
  isAiVaultSessionFilterQueryTooLarge,
  parseVaultQuery,
  timeRangeStartMs,
  type ParsedVaultQuery
} from './ai-vault-session-query'
import {
  DEFAULT_AI_VAULT_SEARCH_SCOPE,
  isAiVaultRgSearchScope,
  type AiVaultSearchScope
} from './ai-vault-session-search-scope'

export type { AiVaultSessionGroup, AiVaultSessionProject }
export {
  AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES,
  agentLabel,
  folderGroupKey,
  folderLabel,
  groupAiVaultSessions,
  isAiVaultSessionFilterQueryTooLarge,
  parseVaultQuery
}

export type AiVaultSessionFilterState = {
  query: string
  agents: readonly AiVaultAgent[]
  scope: AiVaultScope
  sort: AiVaultSort
  activeWorktreePaths: readonly string[]
  activeProjectKey?: string | null
  sessionProjectById?: ReadonlyMap<string, AiVaultSessionProject>
  projectLabelByKey?: ReadonlyMap<string, string>
  hideEmptySessions: boolean
  timeRange?: AiVaultTimeRange
  hosts?: readonly AiVaultSessionHost[]
  searchScope?: AiVaultSearchScope
}

export type AiVaultSessionFilterOptions = {
  index?: AiVaultSessionSearchIndex
  nowMs?: number
  termMode?: AiVaultIndexQueryMode
  queryTerms?: readonly string[]
  forceCardTerms?: boolean
}

export function filterAiVaultSessions(
  sessions: readonly AiVaultSession[],
  filters: AiVaultSessionFilterState,
  options: AiVaultSessionFilterOptions = {}
): AiVaultSession[] {
  if (isAiVaultSessionFilterQueryTooLarge(filters.query)) {
    return []
  }

  const parsedQuery = parseVaultQuery(filters.query)
  const index = options.index ?? createEphemeralIndex(sessions, filters)
  const termMode = options.termMode ?? 'and'
  const queryTerms = options.queryTerms ?? parsedQuery.terms
  const searchScope = filters.searchScope ?? DEFAULT_AI_VAULT_SEARCH_SCOPE
  const skipIndexTerms = isAiVaultRgSearchScope(searchScope) && options.forceCardTerms !== true
  const candidateIds = skipIndexTerms ? null : index.query(queryTerms, termMode)
  const agentSet = new Set(filters.agents)
  const hostSet = new Set(filters.hosts ?? [])
  const rangeStartMs = timeRangeStartMs(filters.timeRange ?? 'all', options.nowMs ?? Date.now())
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const workspaceMatchers =
    filters.scope === 'workspace'
      ? filters.activeWorktreePaths.map(createAiVaultWorkspaceMatcher)
      : []

  const matches: AiVaultSession[] = []
  for (const session of sessions) {
    if (candidateIds && !candidateIds.has(session.id)) {
      continue
    }
    const document = index.get(session.id)
    if (!document) {
      continue
    }
    if (
      !matchesIndexedSession(
        session,
        document,
        filters,
        parsedQuery,
        agentSet,
        hostSet,
        rangeStartMs,
        workspaceMatchers
      )
    ) {
      continue
    }
    if (
      !matchesSearchScopeTerms(
        document,
        queryTerms,
        searchScope,
        termMode,
        options.forceCardTerms === true
      )
    ) {
      continue
    }
    matches.push(byId.get(session.id) ?? session)
  }

  if (matches.length < 2) {
    return matches
  }
  return matches
    .map((session) => ({ session, time: sessionSortTime(session, filters.sort) }))
    .sort((left, right) => right.time - left.time)
    .map(({ session }) => session)
}

function createEphemeralIndex(
  sessions: readonly AiVaultSession[],
  filters: Pick<AiVaultSessionFilterState, 'sessionProjectById' | 'projectLabelByKey'>
): AiVaultSessionSearchIndex {
  const index = new AiVaultSessionSearchIndex()
  index.sync(sessions, {
    sessionProjectById: filters.sessionProjectById,
    projectLabelByKey: filters.projectLabelByKey
  })
  return index
}

function matchesSearchScopeTerms(
  document: AiVaultIndexedSession,
  terms: readonly string[],
  searchScope: AiVaultSearchScope,
  termMode: AiVaultIndexQueryMode,
  forceCardTerms: boolean
): boolean {
  if (terms.length === 0) {
    return true
  }
  if (isAiVaultRgSearchScope(searchScope) && !forceCardTerms) {
    return true
  }
  const haystack = forceCardTerms
    ? document.searchable
    : searchScope === 'title'
      ? document.titleSearchable
      : document.summarySearchable
  if (termMode === 'or') {
    return terms.some((term) => haystack.includes(term))
  }
  return terms.every((term) => haystack.includes(term))
}

function matchesIndexedSession(
  session: AiVaultSession,
  document: AiVaultIndexedSession,
  filters: AiVaultSessionFilterState,
  parsed: ParsedVaultQuery,
  agentSet: ReadonlySet<AiVaultAgent>,
  hostSet: ReadonlySet<AiVaultSessionHost>,
  rangeStartMs: number | null,
  workspaceMatchers: readonly ((normalizedCwd: string) => boolean)[]
): boolean {
  if (!agentSet.has(session.agent)) {
    return false
  }
  // Hide plain empty sessions, but keep sessions with resumable content
  // (some parsers only learn turns from previews, e.g. Grok) and zero-turn
  // sessions that still carry recoverable content (queued prompts /
  // subagent transcripts) so a lost conversation is surfaced distinctly.
  if (
    filters.hideEmptySessions &&
    !isAiVaultSessionResumableContent(session) &&
    !isAiVaultSessionRecoverableEmpty(session)
  ) {
    return false
  }
  if (hostSet.size > 0 && !hostSet.has(document.host)) {
    return false
  }
  if (rangeStartMs !== null && document.updatedAtMs < rangeStartMs) {
    return false
  }
  if (parsed.afterMs !== null && document.updatedAtMs < parsed.afterMs) {
    return false
  }
  if (parsed.beforeMs !== null && document.updatedAtMs > parsed.beforeMs) {
    return false
  }
  if (parsed.hostTerms.length > 0 && !parsed.hostTerms.includes(document.host)) {
    return false
  }
  if (parsed.modelTerms.some((term) => !document.model.includes(term))) {
    return false
  }
  if (parsed.branchTerms.some((term) => !document.branch.includes(term))) {
    return false
  }
  if (filters.scope === 'workspace') {
    const cwd = session.cwd
    const normalizedCwd = cwd ? normalizeRuntimePathForComparison(cwd) : null
    if (normalizedCwd === null || !workspaceMatchers.some((matches) => matches(normalizedCwd))) {
      return false
    }
  }
  if (filters.scope === 'project') {
    if (!filters.activeProjectKey || document.projectKey !== filters.activeProjectKey) {
      return false
    }
  }
  if (parsed.repoTerms.some((term) => !document.repoLabel.includes(term))) {
    return false
  }
  const pathSearch = `${document.cwd} ${document.filePath}`.toLowerCase()
  if (parsed.pathTerms.some((term) => !pathSearch.includes(term))) {
    return false
  }
  return true
}

function sessionSortTime(session: AiVaultSession, sort: AiVaultSort): number {
  const value = sort === 'created' ? session.createdAt : session.updatedAt
  return Date.parse(value ?? session.modifiedAt)
}

function createAiVaultWorkspaceMatcher(workspacePath: string): (normalizedCwd: string) => boolean {
  const matches = createNormalizedPathInsideOrEqualMatcher(workspacePath)
  const workspaceWslPath = parseWslUncPath(workspacePath)
  if (!workspaceWslPath) {
    return matches
  }
  // WSL transcripts record Linux cwd even when the workspace uses a UNC path.
  const matchesLinux = createNormalizedPathInsideOrEqualMatcher(workspaceWslPath.linuxPath)
  return (cwd) => matches(cwd) || matchesLinux(cwd)
}
