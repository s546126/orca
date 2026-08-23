import type { WebContents } from 'electron'
import { captureScreenshot } from './cdp-screenshot'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'

export type CdpPageSessionSink = {
  send: (payload: unknown) => void
}

export type CdpPageCommand = {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

const ROOT_SESSION_PLACEHOLDER = 'orca-view-session'

type BoundPageSink = {
  sink: CdpPageSessionSink
  sessionId: string
}

export class CdpViewPageSession {
  private debuggerLease: ElectronDebuggerLease | null = null
  private attached = false
  private readonly sinks = new Map<CdpPageSessionSink, BoundPageSink>()
  private debuggerMessageHandler: ((...args: unknown[]) => void) | null = null
  private debuggerDetachHandler: (() => void) | null = null
  private attachPromise: Promise<void> | null = null

  constructor(
    private readonly webContents: WebContents,
    readonly targetId: string
  ) {}

  addSink(sink: CdpPageSessionSink, sessionId: string): void {
    this.sinks.set(sink, { sink, sessionId })
  }

  removeSink(sink: CdpPageSessionSink): void {
    this.sinks.delete(sink)
  }

  get sinkCount(): number {
    return this.sinks.size
  }

  async attach(): Promise<void> {
    if (this.attached) {
      return
    }
    if (this.attachPromise) {
      await this.attachPromise
      return
    }
    this.attachPromise = this.attachDebugger()
    try {
      await this.attachPromise
    } finally {
      this.attachPromise = null
    }
  }

  dispose(): void {
    this.detachDebugger()
    this.sinks.clear()
  }

  handleCommand(command: CdpPageCommand, sink: CdpPageSessionSink): void {
    if (this.webContents.isDestroyed()) {
      sink.send({
        id: command.id,
        error: { code: -32000, message: 'Browser tab is no longer available' }
      })
      return
    }

    if (command.method === 'Page.bringToFront') {
      this.webContents.focus()
      sink.send({ id: command.id, result: {} })
      return
    }
    if (command.method === 'Page.captureScreenshot') {
      captureScreenshot(
        this.webContents,
        command.params,
        (result) => sink.send({ id: command.id, result }),
        (message) => sink.send({ id: command.id, error: { code: -32000, message } })
      )
      return
    }
    if (command.method === 'Page.navigate') {
      void this.navigateWithLifecycleEnsured(command, sink)
      return
    }
    if (command.method === 'Input.insertText' && !this.webContents.isDestroyed()) {
      this.webContents.focus()
    }
    this.forwardCommand(command, sink)
  }

  private async attachDebugger(): Promise<void> {
    if (this.attached || this.webContents.isDestroyed()) {
      return
    }
    this.debuggerLease = acquireElectronDebugger(this.webContents)
    this.attached = true
    this.debuggerMessageHandler = (_event: unknown, ...rest: unknown[]) => {
      const [method, params, sessionId] = rest as [
        string,
        Record<string, unknown>,
        string | undefined
      ]
      this.emit({ method, params }, sessionId)
    }
    this.debuggerDetachHandler = () => {
      this.attached = false
      const lease = this.debuggerLease
      this.debuggerLease = null
      lease?.release()
      this.emit({
        method: 'Inspector.detached',
        params: { reason: 'target_closed' }
      })
    }
    this.webContents.debugger.on('message', this.debuggerMessageHandler as never)
    this.webContents.debugger.on('detach', this.debuggerDetachHandler as never)
  }

  private detachDebugger(): void {
    if (this.debuggerMessageHandler) {
      this.webContents.debugger.removeListener('message', this.debuggerMessageHandler as never)
      this.debuggerMessageHandler = null
    }
    if (this.debuggerDetachHandler) {
      this.webContents.debugger.removeListener('detach', this.debuggerDetachHandler as never)
      this.debuggerDetachHandler = null
    }
    const lease = this.debuggerLease
    this.debuggerLease = null
    lease?.release()
    this.attached = false
  }

  private async navigateWithLifecycleEnsured(
    command: CdpPageCommand,
    sink: CdpPageSessionSink
  ): Promise<void> {
    try {
      const dbg = this.webContents.debugger
      await dbg.sendCommand('Network.enable', {})
      await dbg.sendCommand('Page.enable', {})
      await dbg.sendCommand('Page.setLifecycleEventsEnabled', { enabled: true })
    } catch {
      /* best-effort — Electron webview CDP subscriptions can lapse after swaps */
    }
    this.forwardCommand(command, sink)
  }

  private forwardCommand(command: CdpPageCommand, sink: CdpPageSessionSink): void {
    const bound = this.sinks.get(sink)
    const sessionId =
      command.sessionId &&
      command.sessionId !== bound?.sessionId &&
      command.sessionId !== ROOT_SESSION_PLACEHOLDER
        ? command.sessionId
        : undefined
    try {
      Promise.resolve(
        sessionId
          ? this.webContents.debugger.sendCommand(command.method, command.params, sessionId)
          : this.webContents.debugger.sendCommand(command.method, command.params)
      )
        .then((result) => {
          sink.send({ id: command.id, result })
        })
        .catch((error: Error) => {
          sink.send({
            id: command.id,
            error: { code: -32000, message: error.message }
          })
        })
    } catch (error) {
      sink.send({
        id: command.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      })
    }
  }

  private emit(payload: Record<string, unknown>, electronSessionId?: string): void {
    for (const bound of this.sinks.values()) {
      bound.sink.send({
        ...payload,
        sessionId: electronSessionId || bound.sessionId
      })
    }
  }
}
