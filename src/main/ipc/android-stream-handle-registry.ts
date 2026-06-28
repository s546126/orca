import type { AndroidStreamHandle } from '../emulator/android-device-backend'

// Why: the H.264 source is a main-spawned child that AndroidBridge already owns
// from provisioning, but `emulator:frameStreamStart` is renderer-initiated and
// URL-addressed. This registry bridges the two: AndroidBridge registers a live
// handle by streamId, and the frame-stream handler resolves it instead of opening
// a URL. Session teardown owns the handle lifecycle and wins over renderer stop.
class AndroidStreamHandleRegistry {
  private readonly handles = new Map<string, AndroidStreamHandle>()

  register(handle: AndroidStreamHandle): void {
    this.handles.set(handle.streamId, handle)
  }

  get(streamId: string): AndroidStreamHandle | undefined {
    return this.handles.get(streamId)
  }

  // Stop the underlying source and drop it. Called on session teardown.
  remove(streamId: string): void {
    const handle = this.handles.get(streamId)
    if (!handle) {
      return
    }
    handle.stop()
    this.handles.delete(streamId)
  }
}

// One shared instance keyed by streamId — mirrors the module-level session map in
// emulator-frame-stream.ts.
export const androidStreamHandleRegistry = new AndroidStreamHandleRegistry()
