import type { IncomingMessage, ServerResponse } from 'http'
import type { WebContents } from 'electron'

export type CdpMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: Record<string, unknown>
  error?: { code?: number; message?: string; data?: string }
}

export type CdpViewTab = {
  targetId: string
  url: string
  title: string
  active: boolean
}

export type CdpViewGatewayController = {
  viewId: string
  listTabs: () => Promise<CdpViewTab[]>
  ownsTarget: (targetId: string) => boolean
  getWebContents: (targetId: string) => WebContents | null
  createTarget: (url: string) => Promise<CdpViewTab>
  activateTarget: (targetId: string) => Promise<CdpViewTab>
  closeTarget: (targetId: string) => Promise<void>
}

export type CdpViewGateway = {
  viewId: string
  httpUrl: string
  browserWebSocketUrl: string
  pageWebSocketUrl: (targetId: string) => string
  notifyTargetCreated: (tab: CdpViewTab) => void
  notifyTargetDestroyed: (targetId: string) => void
  notifyTargetInfoChanged: (tab: CdpViewTab) => void
  close: () => Promise<void>
}

export type PendingCdpRequest = {
  method: string
  params: Record<string, unknown>
}

export function parseCdpMessage(text: string): CdpMessage | null {
  try {
    return JSON.parse(text) as CdpMessage
  } catch {
    return null
  }
}

export function cdpMessageText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(value)
  }
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(value)
  }
  return String(value)
}

export function normalizedHttpPath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

export function targetIdFromHttpPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) {
    return null
  }
  const value = pathname.slice(prefix.length)
  return value ? decodeURIComponent(value) : null
}

export function isBrowserSocketPath(pathname: string): boolean {
  return pathname.startsWith('/devtools/browser/')
}

export function pageTargetFromPath(pathname: string): string | null {
  return targetIdFromHttpPath(pathname, '/devtools/page/')
}

export function writeJson(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(value))
}

export function writeText(res: ServerResponse, value: string, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(value)
}

export function requestUrl(req: IncomingMessage, host: string): URL {
  return new URL(req.url ?? '/', `http://${host}`)
}

export function requiredTargetId(params: Record<string, unknown>): string {
  if (typeof params.targetId !== 'string' || params.targetId === '') {
    throw new Error('missing targetId')
  }
  return params.targetId
}

export function chromeProductString(): string {
  const chromeVersion = process.versions.chrome ?? '134.0.0.0'
  return `Chrome/${chromeVersion}`
}
