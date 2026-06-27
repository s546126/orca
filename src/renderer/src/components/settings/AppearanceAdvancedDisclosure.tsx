import type React from 'react'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { normalizeSettingsSearchQuery } from './settings-search'
import { translate } from '@/i18n/i18n'

type AppearanceAdvancedDisclosureProps = {
  /** Optional override label; defaults to "Advanced". */
  label?: string
  children: React.ReactNode
}

/** Inline "Advanced" disclosure for low-frequency controls. An active settings
 *  search force-opens it so matching controls stay reachable instead of being
 *  hidden behind a collapsed trigger. */
export function AppearanceAdvancedDisclosure({
  label,
  children
}: AppearanceAdvancedDisclosureProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const [open, setOpen] = useState(false)
  const expanded = open || isSearching

  return (
    <div className="mt-3 border-t border-border/50 pt-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen((prev) => !prev)}
        // Why: while searching the disclosure is forced open, so disable the
        // toggle's collapse affordance rather than letting it fight the search.
        disabled={isSearching}
        className="flex w-full items-center gap-2 py-1 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
      >
        <ChevronRight
          className={cn(
            'size-3.5 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
        {label ??
          translate('auto.components.settings.AppearanceAdvancedDisclosure.advanced', 'Advanced')}
      </button>
      {expanded ? <div className="pt-1">{children}</div> : null}
    </div>
  )
}
