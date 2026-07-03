import { z } from 'zod'

/**
 * Message protocol between the Orca process and the out-of-process plugin
 * host (child_process.fork channel). Zod-validated on both sides because the
 * child runs third-party code — nothing it sends is trusted structurally.
 */

export const pluginHostInitSchema = z.object({
  type: z.literal('init'),
  pluginRoot: z.string().min(1),
  mainEntry: z.string().min(1),
  pluginId: z.string().min(1)
})

export const pluginHostInvokeSchema = z.object({
  type: z.literal('invoke'),
  callId: z.number().int().nonnegative(),
  extensionPoint: z.string().min(1),
  providerId: z.string().min(1),
  method: z.string().min(1),
  args: z.array(z.unknown())
})

export const pluginHostShutdownSchema = z.object({ type: z.literal('shutdown') })

export const pluginHostParentMessageSchema = z.discriminatedUnion('type', [
  pluginHostInitSchema,
  pluginHostInvokeSchema,
  pluginHostShutdownSchema
])

const registrationSchema = z.object({
  extensionPoint: z.string().min(1),
  providerId: z.string().min(1),
  methods: z.array(z.string().min(1))
})

export const pluginHostReadySchema = z.object({
  type: z.literal('ready'),
  registrations: z.array(registrationSchema)
})

export const pluginHostResultSchema = z.object({
  type: z.literal('result'),
  callId: z.number().int().nonnegative(),
  ok: z.boolean(),
  // Why: value crosses a fork() IPC boundary, so it is structured-clone data
  // by construction; zod treats it as opaque and callers re-validate shape.
  value: z.unknown().optional(),
  error: z.string().optional()
})

export const pluginHostLogSchema = z.object({
  type: z.literal('log'),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string()
})

export const pluginHostFatalSchema = z.object({
  type: z.literal('fatal'),
  error: z.string()
})

export const pluginHostChildMessageSchema = z.discriminatedUnion('type', [
  pluginHostReadySchema,
  pluginHostResultSchema,
  pluginHostLogSchema,
  pluginHostFatalSchema
])

export type PluginHostParentMessage = z.infer<typeof pluginHostParentMessageSchema>
export type PluginHostChildMessage = z.infer<typeof pluginHostChildMessageSchema>
export type PluginHostRegistration = z.infer<typeof registrationSchema>

export const PLUGIN_HOST_READY_TIMEOUT_MS = 10_000
export const PLUGIN_HOST_INVOKE_TIMEOUT_MS = 30_000
