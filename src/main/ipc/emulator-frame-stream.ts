import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import {
  createMobileFrameStream,
  type CreateMobileFrameStreamArgs
} from './mobile-frame-stream-factory'
import type { FrameStream } from './frame-stream-contract'

type FrameStreamSession = {
  owner: WebContents
  // Why: typed against FrameStream so the h264 stream can plug in unchanged.
  stream: FrameStream
}

const sessions = new Map<string, FrameStreamSession>()

function stopFrameStream(streamId: string): void {
  const session = sessions.get(streamId)
  if (!session) {
    return
  }
  session.stream.stop()
  sessions.delete(streamId)
}

export function registerEmulatorFrameStreamHandlers(): void {
  ipcMain.handle(
    'emulator:frameStreamStart',
    (
      event,
      args: CreateMobileFrameStreamArgs
    ): { streamId: string } => {
      const owner = event.sender
      const ownerWindow = BrowserWindow.fromWebContents(owner)
      if (!ownerWindow) {
        throw new Error('Emulator frame stream must originate from a BrowserWindow.')
      }

      const streamId = randomUUID()
      // Why: Chromium's NetworkService can restart under long-lived stream loads;
      // the main process owns the socket so the renderer only receives decodable
      // units. mjpeg sends JPEG bytes; h264 adds per-access-unit metadata.
      const stream = createMobileFrameStream(args, {
        onError: (message) => {
          if (!owner.isDestroyed()) {
            owner.send('emulator:frameStreamError', { streamId, message })
          }
        },
        onFrame: (bytes, meta) => {
          if (!owner.isDestroyed()) {
            owner.send('emulator:frameStreamFrame', { streamId, bytes, meta })
          }
        }
      })

      sessions.set(streamId, { owner, stream })
      owner.once('destroyed', () => stopFrameStream(streamId))
      stream.start()
      return { streamId }
    }
  )

  ipcMain.handle('emulator:frameStreamStop', (_event, args: { streamId: string }) => {
    stopFrameStream(args.streamId)
  })
}
