import { useCallback } from 'react'
import { useEmulatorControlStream } from './use-emulator-control-stream'
import { useEmulatorScreenKeyboard } from './use-emulator-screen-keyboard'
import type { ServeSimTouchFrame } from '../../../../shared/emulator-touch-frame'

// Kind-based pointer-transport selection. iOS drives the serve-sim WebSocket HID
// path (live drag + HID keyboard); Android has no HID socket, so live drag is
// gated off and pointer interaction falls back to the discrete tap/gesture RPC.
export type EmulatorPointerKind = 'ios' | 'android'

type UseEmulatorPointerTransportArgs = {
  kind: EmulatorPointerKind
  wsUrl: string | undefined
  canInteract: boolean
}

type KeyboardTransport = ReturnType<typeof useEmulatorScreenKeyboard>

export type EmulatorPointerTransport = KeyboardTransport & {
  // Live-drag touch sink. Returns false on Android (no socket), which makes the
  // caller fall through to the discrete tap/gesture path.
  sendTouch: (touch: ServeSimTouchFrame) => boolean
  liveDragEnabled: boolean
}

export function useEmulatorPointerTransport({
  kind,
  wsUrl,
  canInteract
}: UseEmulatorPointerTransportArgs): EmulatorPointerTransport {
  const liveDragEnabled = kind === 'ios'
  // Only iOS opens the HID socket; disabling it for Android avoids a dead
  // reconnect loop against a wsUrl the Android session never provides.
  const control = useEmulatorControlStream(wsUrl, canInteract && liveDragEnabled)
  const keyboard = useEmulatorScreenKeyboard({
    cancelKeyboardFrames: control.cancelKeyboardFrames,
    canInteract: canInteract && liveDragEnabled,
    sendKeyboardFrames: control.sendKeyboardFrames
  })

  const sendTouch = useCallback(
    (touch: ServeSimTouchFrame): boolean =>
      liveDragEnabled ? control.sendTouch(touch) : false,
    [control, liveDragEnabled]
  )

  return { ...keyboard, sendTouch, liveDragEnabled }
}
