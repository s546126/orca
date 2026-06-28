import {
  resolveEmulatorStreamDescriptor,
  type EmulatorPaneSession,
  type SimulatorDeviceRow
} from './emulator-pane-types'

type BuildEmulatorPaneSessionViewArgs = {
  devices: SimulatorDeviceRow[]
  selectedUdid: string | null
  session: EmulatorPaneSession | null
}

export function buildEmulatorPaneSessionView({
  devices,
  selectedUdid,
  session
}: BuildEmulatorPaneSessionViewArgs) {
  const selectedDevice = devices.find((device) => device.udid === selectedUdid) ?? null
  const sessionDisplayName = session?.info?.displayName
  const hasSpecificSessionDisplayName =
    sessionDisplayName &&
    sessionDisplayName !== 'Simulator' &&
    sessionDisplayName !== 'Mobile Emulator'
  const descriptor = resolveEmulatorStreamDescriptor(session?.info)
  return {
    displayName: hasSpecificSessionDisplayName
      ? sessionDisplayName
      : selectedDevice?.name || sessionDisplayName || 'Mobile Emulator',
    previewUrl: descriptor?.source,
    streamKind: descriptor?.streamKind ?? 'mjpeg',
    kind: session?.info?.kind ?? 'ios',
    wsUrl: session?.info?.wsUrl,
    isLive: Boolean(descriptor && session?.attached),
    selectedDevice
  }
}
