import { describe, expect, it } from 'vitest'
import {
  PANEL_ACTION_TEXT_MAX_LENGTH,
  looksLikePanelActionRequest,
  parsePanelActionRequest,
  terminalSendTextParamsSchema
} from './plugin-panel-bridge'

const VALID_REQUEST = {
  type: 'orca-panel-action',
  requestId: 'req-1',
  action: 'terminal.sendText',
  params: { text: '/model opus', enter: true }
}

describe('parsePanelActionRequest', () => {
  it('accepts a well-formed bridge request', () => {
    const result = parsePanelActionRequest(VALID_REQUEST)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.request.requestId).toBe('req-1')
    expect(result.request.action).toBe('terminal.sendText')
  })

  it('rejects payloads with the wrong envelope type', () => {
    expect(parsePanelActionRequest({ ...VALID_REQUEST, type: 'other' }).ok).toBe(false)
    expect(parsePanelActionRequest(null).ok).toBe(false)
    expect(parsePanelActionRequest('orca-panel-action').ok).toBe(false)
  })

  it('rejects unknown actions', () => {
    const result = parsePanelActionRequest({ ...VALID_REQUEST, action: 'fs.readFile' })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error).toContain('action')
  })

  it('rejects a missing or oversized requestId', () => {
    expect(parsePanelActionRequest({ ...VALID_REQUEST, requestId: undefined }).ok).toBe(false)
    expect(parsePanelActionRequest({ ...VALID_REQUEST, requestId: '' }).ok).toBe(false)
    expect(parsePanelActionRequest({ ...VALID_REQUEST, requestId: 'x'.repeat(129) }).ok).toBe(false)
  })

  it('surfaces a usable requestId from an invalid request so the host can reply', () => {
    const result = parsePanelActionRequest({ ...VALID_REQUEST, action: 'nope' })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.requestId).toBe('req-1')
  })

  it('does not echo back a malformed requestId', () => {
    const result = parsePanelActionRequest({
      ...VALID_REQUEST,
      action: 'nope',
      requestId: 'x'.repeat(200)
    })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.requestId).toBeNull()
  })
})

describe('terminalSendTextParamsSchema', () => {
  it('accepts text with an optional enter flag', () => {
    const parsed = terminalSendTextParamsSchema.safeParse({ text: '/model haiku' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) {
      return
    }
    expect(parsed.data.enter).toBe(false)
  })

  it('rejects empty, missing, and oversized text', () => {
    expect(terminalSendTextParamsSchema.safeParse({ text: '' }).success).toBe(false)
    expect(terminalSendTextParamsSchema.safeParse({}).success).toBe(false)
    expect(
      terminalSendTextParamsSchema.safeParse({
        text: 'x'.repeat(PANEL_ACTION_TEXT_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
  })

  it('rejects non-boolean enter values', () => {
    expect(terminalSendTextParamsSchema.safeParse({ text: 'hi', enter: 'yes' }).success).toBe(false)
  })
})

describe('looksLikePanelActionRequest', () => {
  it('matches only the bridge envelope type', () => {
    expect(looksLikePanelActionRequest(VALID_REQUEST)).toBe(true)
    expect(looksLikePanelActionRequest({ type: 'orca-panel-action' })).toBe(true)
    expect(looksLikePanelActionRequest({ type: 'orca-panel-action-result' })).toBe(false)
    expect(looksLikePanelActionRequest(undefined)).toBe(false)
  })
})
