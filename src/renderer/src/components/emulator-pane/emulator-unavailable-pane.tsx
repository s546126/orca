import { Smartphone } from 'lucide-react'
import { translate } from '@/i18n/i18n'

// Capability-based copy. The default 'ios-macos-only' variant is byte-identical to
// the prior iOS-only pane; Android/remote variants explain the redroid host
// requirements instead of regressing to "requires a Mac".
export type EmulatorUnavailableVariant =
  | 'ios-macos-only'
  | 'android-no-remote-host'
  | 'android-host-unsupported'

type EmulatorUnavailablePaneProps = {
  variant?: EmulatorUnavailableVariant
}

function unavailableCopy(variant: EmulatorUnavailableVariant): { title: string; body: string } {
  if (variant === 'android-no-remote-host') {
    return {
      title: translate(
        'auto.components.emulator.pane.emulator.unavailable.pane.android.no.remote.host.title',
        'Android needs a redroid host'
      ),
      body: translate(
        'auto.components.emulator.pane.emulator.unavailable.pane.android.no.remote.host.body',
        'Configure a remote SSH target with redroid, or run Orca on a Linux host with binder support, to drive an Android device.'
      )
    }
  }
  if (variant === 'android-host-unsupported') {
    return {
      title: translate(
        'auto.components.emulator.pane.emulator.unavailable.pane.android.host.unsupported.title',
        'This host cannot run redroid'
      ),
      body: translate(
        'auto.components.emulator.pane.emulator.unavailable.pane.android.host.unsupported.body',
        'redroid requires a Linux kernel with binder support and a matching CPU architecture. Use a supported Linux host or a remote SSH target.'
      )
    }
  }
  return {
    title: translate(
      'auto.components.emulator.pane.emulator.unavailable.pane.b2c268a0b9',
      'Mobile Emulator is macOS only'
    ),
    body: translate(
      'auto.components.emulator.pane.emulator.unavailable.pane.f630b9ca9f',
      'Mobile Emulator requires a Mac with Xcode and the iOS Simulator runtime. On Linux or Windows, use a physical device or a remote Mac build host.'
    )
  }
}

export function EmulatorUnavailablePane({
  variant = 'ios-macos-only'
}: EmulatorUnavailablePaneProps = {}) {
  const copy = unavailableCopy(variant)
  return (
    <div
      data-emulator-pane
      className="flex h-full flex-col items-center justify-center gap-3 bg-background px-6 text-center text-sm text-muted-foreground"
    >
      <Smartphone className="size-8 text-muted-foreground" />
      <p className="max-w-md font-medium text-foreground">{copy.title}</p>
      <p className="max-w-md text-xs">{copy.body}</p>
    </div>
  )
}
