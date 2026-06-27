import type React from 'react'

import { type ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'

/** Renders one or more keyboard shortcut combos inline, or an "Unassigned"
 *  hint when the action has no binding. Platform-aware glyphs come from
 *  ShortcutKeyCombo. */
export function ShortcutHintList({
  combos
}: {
  combos: ShortcutKeyComboDetails[]
}): React.JSX.Element {
  if (combos.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AppearancePane.3057983501', 'Unassigned')}
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {combos.map((combo) => (
        <ShortcutKeyCombo
          key={combo.keys.join('-')}
          keys={combo.keys}
          doubleTap={combo.doubleTap}
          className="inline-flex gap-0.5"
          separatorClassName="text-[10px] text-muted-foreground"
        />
      ))}
    </span>
  )
}
