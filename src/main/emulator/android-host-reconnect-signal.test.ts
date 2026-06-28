import { describe, expect, it, vi } from 'vitest'
import { createAndroidHostReconnectSignal } from './android-host-reconnect-signal'
import type { SshConnectionState } from '../../shared/ssh-types'

function state(
  status: SshConnectionState['status'],
  reconnectAttempt = 0
): SshConnectionState {
  return { targetId: 't1', status, error: null, reconnectAttempt }
}

describe('createAndroidHostReconnectSignal', () => {
  it('fires reconnect on a down -> connected(reconnectAttempt=0) transition', () => {
    const signal = createAndroidHostReconnectSignal()
    const onReconnect = vi.fn()
    signal.onReconnect(onReconnect)
    signal.ingest(state('connected'))
    expect(onReconnect).not.toHaveBeenCalled() // first connect is not a reconnect
    signal.ingest(state('reconnecting'))
    signal.ingest(state('connected'))
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('fires disconnect once per connected -> down edge, including a removed connection', () => {
    const signal = createAndroidHostReconnectSignal()
    const onDisconnect = vi.fn()
    signal.onDisconnect(onDisconnect)
    signal.ingest(state('connected'))
    signal.ingest(null) // connection removed from the manager
    signal.ingest(state('reconnection-failed'))
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })

  it('does not treat an unchanged connected status as a reconnect', () => {
    const signal = createAndroidHostReconnectSignal()
    const onReconnect = vi.fn()
    signal.onReconnect(onReconnect)
    signal.ingest(state('connected'))
    signal.ingest(state('connected'))
    expect(onReconnect).not.toHaveBeenCalled()
  })
})
