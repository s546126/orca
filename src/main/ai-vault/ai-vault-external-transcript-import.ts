import {
  syncSystemCodexSessionsIntoManagedHomeIncrementally,
  type CodexSessionBridgeSummary
} from '../codex/codex-session-bridge'

export type AiVaultExternalTranscriptImportSummary = {
  codexBridge: CodexSessionBridgeSummary
  importedAt: string
}

/**
 * Links non-Orca agent transcripts into Orca-managed stores so resume and
 * history scans can see sessions started outside Orca.
 */
export async function importExternalAgentTranscripts(): Promise<AiVaultExternalTranscriptImportSummary> {
  // Why: Codex sessions started in a plain terminal live under ~/.codex while
  // Orca-launched Codex writes to codex-runtime-home; bridge before scanning.
  const codexBridge = await syncSystemCodexSessionsIntoManagedHomeIncrementally()
  return {
    codexBridge,
    importedAt: new Date().toISOString()
  }
}
