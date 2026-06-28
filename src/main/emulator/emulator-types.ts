export type EmulatorSessionInfo = {
  deviceUdid: string
  wsUrl: string
  streamUrl: string
  axUrl?: string
  helperPid?: number
  // Why: the runtime routes interaction verbs by the kind recorded at attach
  // time; streamKind/hostId let Android (h264, per-host serials) coexist with iOS.
  kind?: 'ios' | 'android'
  streamKind?: 'mjpeg' | 'h264'
  hostId?: string
}

export type EmulatorCliTarget = {
  worktreeId?: string
  deviceUdid?: string
  emulatorId?: string // Orca-generated id from list (for stability, like browserPageId)
  kind?: 'ios' | 'android'
}
