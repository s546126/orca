import { useState } from 'react'
import { Archive, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { canSaveAiVaultSessionLog } from '../../../../shared/ai-vault-session-snapshot'
import { AI_VAULT_AGENT_LABELS, type AiVaultSession } from '../../../../shared/ai-vault-types'
import { setHistorySnapshotOverlay } from './ai-vault-history-snapshot-overlay'

export function SessionSnapshotButton({ session }: { session: AiVaultSession }) {
  const [busy, setBusy] = useState(false)
  const snapshot = session.historySnapshot
  if (!canOfferSnapshot(session) && !snapshot) {
    return null
  }
  const agentLabel = AI_VAULT_AGENT_LABELS[session.agent]
  const savedAt = snapshot ? formatSavedAt(snapshot.savedAt) : ''

  async function saveCopy(): Promise<void> {
    setBusy(true)
    try {
      const result = await window.api.aiVault.saveSessionSnapshot({
        agent: session.agent,
        sessionId: session.sessionId,
        executionHostId: session.executionHostId,
        filePath: session.filePath
      })
      if (result.outcome === 'failed') {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.snapshotSaveFailed',
            "Couldn't save snapshot: {{value0}}",
            { value0: result.message }
          )
        )
        return
      }
      setHistorySnapshotOverlay(session, result.snapshot)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Could not write the snapshot.'
      toast.error(
        translate(
          'auto.components.right.sidebar.AiVaultSessionDetails.snapshotSaveFailed',
          "Couldn't save snapshot: {{value0}}",
          { value0: reason }
        )
      )
    } finally {
      setBusy(false)
    }
  }

  async function deleteCopy(): Promise<void> {
    if (!snapshot) {
      return
    }
    setBusy(true)
    try {
      const result = await window.api.aiVault.deleteSessionSnapshot({
        archiveId: snapshot.archiveId,
        agent: session.agent,
        sessionId: session.sessionId,
        executionHostId: session.executionHostId,
        filePath: session.filePath
      })
      if (result.outcome === 'failed') {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.snapshotDeleteFailed',
            "Couldn't delete snapshot: {{value0}}",
            { value0: result.message }
          )
        )
        return
      }
      setHistorySnapshotOverlay(session, null)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Could not delete the snapshot.'
      toast.error(
        translate(
          'auto.components.right.sidebar.AiVaultSessionDetails.snapshotDeleteFailed',
          "Couldn't delete snapshot: {{value0}}",
          { value0: reason }
        )
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {snapshot ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={busy}
          draggable={false}
          onClick={(event) => {
            event.stopPropagation()
            void deleteCopy()
          }}
          className="h-7 shrink-0 px-2.5 text-[11px] text-muted-foreground"
        >
          <Trash2 className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.deleteSnapshot',
            'Delete copy'
          )}
        </Button>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          disabled={busy}
          draggable={false}
          onClick={(event) => {
            event.stopPropagation()
            void saveCopy()
          }}
          className="h-7 shrink-0 px-2.5 text-[11px]"
        >
          <Archive className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.saveSnapshot',
            'Save snapshot'
          )}
        </Button>
      )}
      <p className="basis-full text-[11px] leading-4 text-muted-foreground">
        {snapshot
          ? translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.snapshotSaved',
              'Saved · {{value0}} · {{value1}}. This is the log as of that save, including tool output.',
              { value0: agentLabel, value1: savedAt }
            )
          : translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.snapshotHint',
              'Saves this log only. Tool output is kept. It does not resume or back up subagent transcripts.'
            )}
      </p>
    </>
  )
}

function canOfferSnapshot(session: AiVaultSession): boolean {
  return canSaveAiVaultSessionLog(session)
}

function formatSavedAt(savedAt: string): string {
  const parsed = Date.parse(savedAt)
  if (!Number.isFinite(parsed)) {
    return savedAt
  }
  return new Date(parsed).toLocaleString()
}
