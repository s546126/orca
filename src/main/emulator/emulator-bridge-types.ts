import type { EmulatorSessionRegistry } from './emulator-session-registry'

export type EmulatorSessionState = {
  deviceUdid: string
  wsUrl: string
  streamUrl: string
  axUrl?: string
  pid?: number
  managed: boolean
  initialized: boolean
  kind: 'ios' | 'android'
  streamKind?: 'mjpeg' | 'h264'
  hostId?: string
}

export type EmulatorBridgeOptions = {
  waitForEndpointReady?: (endpoint: string) => Promise<boolean>
  // Why: iOS + Android bridges share one registry (routing source of truth);
  // default-constructed so existing callers keep working unchanged.
  registry?: EmulatorSessionRegistry
}
