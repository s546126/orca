import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import {
  PLUGIN_HOST_INVOKE_TIMEOUT_MS,
  PLUGIN_HOST_READY_TIMEOUT_MS,
  pluginHostChildMessageSchema,
  type PluginHostParentMessage,
  type PluginHostRegistration
} from '../../shared/plugins/plugin-host-protocol'

// Grace between the shutdown message and SIGKILL: long enough for plugin
// cleanup, short enough that disable/quit never feels stuck.
const PLUGIN_HOST_SHUTDOWN_GRACE_MS = 2_000

export type PluginHostHandle = {
  registrations: PluginHostRegistration[]
  invoke(
    extensionPoint: string,
    providerId: string,
    method: string,
    args: unknown[]
  ): Promise<unknown>
  dispose(): Promise<void>
  onExit(callback: (code: number | null) => void): void
}

export type StartPluginHostOptions = {
  pluginId: string
  rootDir: string
  mainEntry: string
  /** Absolute path to the compiled plugin-host-entry.js, resolved by the caller. */
  entryPath: string
  readyTimeoutMs?: number
  invokeTimeoutMs?: number
}

/**
 * Resolves the compiled child entry from the app path. Mirrors
 * getDaemonEntryPath(): packaged apps must fork the asar-unpacked copy
 * because fork() cannot execute scripts from inside app.asar.
 */
export function resolvePluginHostEntryPath(appPath: string, isPackaged: boolean): string {
  const basePath = isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const directEntryPath = join(basePath, 'plugin-host-entry.js')
  if (existsSync(directEntryPath)) {
    return directEntryPath
  }
  return join(basePath, 'out', 'main', 'plugin-host-entry.js')
}

function pipeChildOutputLines(stream: Readable | null, tag: string): void {
  if (!stream) {
    return
  }
  let buffered = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffered += chunk
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim().length > 0) {
        console.warn(`${tag} ${line}`)
      }
    }
  })
  stream.on('end', () => {
    if (buffered.trim().length > 0) {
      console.warn(`${tag} ${buffered}`)
    }
  })
}

type PendingInvoke = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export async function startPluginHost(options: StartPluginHostOptions): Promise<PluginHostHandle> {
  const { pluginId, rootDir, mainEntry, entryPath } = options
  const readyTimeoutMs = options.readyTimeoutMs ?? PLUGIN_HOST_READY_TIMEOUT_MS
  const invokeTimeoutMs = options.invokeTimeoutMs ?? PLUGIN_HOST_INVOKE_TIMEOUT_MS
  const tag = `[plugin:${pluginId}]`

  const child: ChildProcess = fork(entryPath, [], {
    // Why: ELECTRON_RUN_AS_NODE makes the forked Electron binary behave as
    // plain Node — same pattern as the terminal daemon (daemon-init.ts).
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  pipeChildOutputLines(child.stdout, tag)
  pipeChildOutputLines(child.stderr, tag)

  const pending = new Map<number, PendingInvoke>()
  const exitCallbacks: ((code: number | null) => void)[] = []
  let nextCallId = 0
  let exited = false
  let disposed = false

  function sendToChild(message: PluginHostParentMessage): void {
    if (child.connected) {
      child.send(message)
    }
  }

  function rejectAllPending(reason: string): void {
    for (const [callId, entry] of pending) {
      clearTimeout(entry.timer)
      pending.delete(callId)
      entry.reject(new Error(reason))
    }
  }

  child.on('exit', (code) => {
    exited = true
    rejectAllPending(`${tag} host exited before responding`)
    for (const callback of exitCallbacks) {
      callback(code)
    }
  })

  const registrations = await new Promise<PluginHostRegistration[]>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      fail(new Error(`${tag} host did not become ready within ${readyTimeoutMs}ms`))
      child.kill('SIGKILL')
    }, readyTimeoutMs)
    function fail(error: Error): void {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    }
    child.on('error', (error) => fail(new Error(`${tag} failed to start host: ${error.message}`)))
    child.on('exit', (code) => fail(new Error(`${tag} host exited before ready (code ${code})`)))
    child.on('message', (raw) => {
      const parsed = pluginHostChildMessageSchema.safeParse(raw)
      if (!parsed.success) {
        console.warn(`${tag} ignoring malformed host message`)
        return
      }
      const message = parsed.data
      if (message.type === 'ready') {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(message.registrations)
        }
      } else if (message.type === 'result') {
        const entry = pending.get(message.callId)
        if (!entry) {
          return
        }
        clearTimeout(entry.timer)
        pending.delete(message.callId)
        if (message.ok) {
          entry.resolve(message.value)
        } else {
          entry.reject(new Error(message.error ?? 'plugin invocation failed'))
        }
      } else if (message.type === 'log') {
        console.warn(`${tag} ${message.message}`)
      } else {
        fail(new Error(`${tag} host crashed: ${message.error}`))
        rejectAllPending(`${tag} host crashed: ${message.error}`)
      }
    })
    sendToChild({ type: 'init', pluginRoot: rootDir, mainEntry, pluginId })
  })

  return {
    registrations,
    invoke(extensionPoint, providerId, method, args) {
      if (exited || disposed) {
        return Promise.reject(new Error(`${tag} host is not running`))
      }
      const callId = nextCallId++
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(callId)
          reject(new Error(`${tag} ${method} timed out after ${invokeTimeoutMs}ms`))
        }, invokeTimeoutMs)
        pending.set(callId, { resolve, reject, timer })
        sendToChild({ type: 'invoke', callId, extensionPoint, providerId, method, args })
      })
    },
    async dispose() {
      if (disposed) {
        return
      }
      disposed = true
      if (exited) {
        return
      }
      sendToChild({ type: 'shutdown' })
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill('SIGKILL')
        }, PLUGIN_HOST_SHUTDOWN_GRACE_MS)
        child.once('exit', () => {
          clearTimeout(killTimer)
          resolve()
        })
        if (exited) {
          clearTimeout(killTimer)
          resolve()
        }
      })
    },
    onExit(callback) {
      exitCallbacks.push(callback)
    }
  }
}
