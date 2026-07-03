import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CODE_PROVIDER_METHODS,
  isCodeProviderMethod,
  type CodeProvider
} from '../../shared/plugins/code-provider'
import { CODE_PROVIDER_EXTENSION_POINT } from '../../shared/plugins/plugin-extension-registry'
import {
  pluginHostParentMessageSchema,
  type PluginHostChildMessage,
  type PluginHostRegistration
} from '../../shared/plugins/plugin-host-protocol'

/**
 * Message-loop core of the out-of-process plugin host. Electron-free and
 * side-effect-free (send/import/exit are injected) so it unit-tests without
 * forking a real child process; `plugin-host-entry.ts` wires it to the fork
 * IPC channel.
 */

/** API surface handed to a plugin's `activate(orca)` export. */
export type PluginHostOrcaApi = {
  registerCodeProvider(provider: CodeProvider): void
}

export type PluginHostRuntimeOptions = {
  send: (message: PluginHostChildMessage) => void
  importModule?: (specifier: string) => Promise<unknown>
  exit?: (code: number) => void
}

export type PluginHostRuntime = {
  handleMessage(raw: unknown): Promise<void>
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

export function createPluginHostRuntime(options: PluginHostRuntimeOptions): PluginHostRuntime {
  const send = options.send
  const importModule = options.importModule ?? ((specifier: string) => import(specifier))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const providers = new Map<string, CodeProvider>()
  let initialized = false

  async function handleInit(pluginRoot: string, mainEntry: string): Promise<void> {
    if (initialized) {
      send({ type: 'log', level: 'warn', message: 'ignoring duplicate init message' })
      return
    }
    initialized = true
    // Why: file URL import keeps ESM plugin entries working on Windows paths.
    const entryUrl = pathToFileURL(join(pluginRoot, mainEntry)).href
    const module = (await importModule(entryUrl)) as { default?: unknown }
    const activate = module?.default
    if (typeof activate !== 'function') {
      throw new Error(`plugin entry ${mainEntry} has no default-exported activate function`)
    }
    const orca: PluginHostOrcaApi = {
      registerCodeProvider(provider) {
        providers.set(provider.id, provider)
      }
    }
    await activate(orca)
    const registrations: PluginHostRegistration[] = [...providers.values()].map((provider) => ({
      extensionPoint: CODE_PROVIDER_EXTENSION_POINT.key,
      providerId: provider.id,
      methods: CODE_PROVIDER_METHODS.filter((method) => typeof provider[method] === 'function')
    }))
    send({ type: 'ready', registrations })
  }

  async function handleInvoke(message: {
    callId: number
    extensionPoint: string
    providerId: string
    method: string
    args: unknown[]
  }): Promise<void> {
    try {
      if (message.extensionPoint !== CODE_PROVIDER_EXTENSION_POINT.key) {
        throw new Error(`unknown extension point: ${message.extensionPoint}`)
      }
      const provider = providers.get(message.providerId)
      if (!provider) {
        throw new Error(`unknown provider: ${message.providerId}`)
      }
      if (!isCodeProviderMethod(message.method)) {
        throw new Error(`unknown code provider method: ${message.method}`)
      }
      const implementation = provider[message.method]
      if (typeof implementation !== 'function') {
        throw new Error(`provider ${message.providerId} does not implement ${message.method}`)
      }
      const value = await (implementation as (...args: unknown[]) => unknown).apply(
        provider,
        message.args
      )
      send({ type: 'result', callId: message.callId, ok: true, value })
    } catch (error) {
      send({ type: 'result', callId: message.callId, ok: false, error: toErrorMessage(error) })
    }
  }

  return {
    async handleMessage(raw) {
      const parsed = pluginHostParentMessageSchema.safeParse(raw)
      if (!parsed.success) {
        send({ type: 'log', level: 'warn', message: 'ignoring malformed parent message' })
        return
      }
      const message = parsed.data
      try {
        if (message.type === 'init') {
          await handleInit(message.pluginRoot, message.mainEntry)
        } else if (message.type === 'invoke') {
          await handleInvoke(message)
        } else {
          exit(0)
        }
      } catch (error) {
        // Why: an init/activation failure leaves the host useless; report and
        // die so the parent can surface the error instead of hanging on ready.
        send({ type: 'fatal', error: toErrorMessage(error) })
        exit(1)
      }
    }
  }
}
