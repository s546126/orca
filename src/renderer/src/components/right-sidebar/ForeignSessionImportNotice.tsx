import type { ReactElement } from 'react'
import { Archive } from 'lucide-react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'

export function ForeignSessionImportNotice({
  session
}: {
  session: AiVaultSession
}): ReactElement | null {
  const imported = session.foreignImport
  if (!imported) {
    return null
  }
  const harness = imported.provenance.sourceHarness === 'codex' ? 'Codex' : 'Pi'
  const detail =
    imported.resume.mode === 'read-only'
      ? imported.resume.reason
      : imported.provenance.sourceHarness === 'codex'
        ? 'Imported into Orca. Open this session to keep working in it.'
        : 'Imported into Orca. Continue it with Pi from this history row.'
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Archive className="size-3 text-muted-foreground" />
        <span>
          {translate(
            'auto.components.right.sidebar.ForeignSessionImportNotice.imported',
            'Imported from {{value0}}',
            { value0: harness }
          )}
        </span>
      </div>
      <p className="rounded-md border border-dashed border-border bg-muted/40 px-2.5 py-2 text-xs leading-4 text-muted-foreground">
        {detail}
      </p>
    </section>
  )
}
