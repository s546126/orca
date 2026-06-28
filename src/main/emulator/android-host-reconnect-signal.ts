import type { SshConnectionState } from '../../shared/ssh-types'

// Why: SshConnection exposes no per-subscriber reconnect hook — the only signal
// is the manager-owned onStateChange callback (src/main/ipc/ssh.ts:389), which is
// already claimed for relay re-establishment. Rather than reach into that, index.ts
// polls the public SshConnectionManager.getState() and feeds snapshots here. This
// pure detector turns the status stream into reconnect/disconnect events the
// Android stream source and track-devices watcher subscribe to. No timer here so
// it tests without a clock; the caller owns the polling interval.

type Phase = 'unknown' | 'up' | 'down' | 'gone'

// SSH statuses that are terminal: the connection won't recover on its own.
// SshConnection bounds reconnection attempts and then sets 'reconnection-failed',
// so a permanently-lost remote stream/watcher ends via onGone (never an infinite
// respawn). 'disconnected' is an explicit teardown; 'auth-failed'/'error' are hard.
const TERMINAL_STATUSES = new Set<SshConnectionState['status']>([
  'reconnection-failed',
  'auth-failed',
  'error',
  'disconnected'
])

export type AndroidHostReconnectSignal = {
  // Fires when a previously-down connection returns to connected — the same
  // condition (connected + reconnectAttempt===0) ssh.ts uses to rebuild the relay.
  onReconnect(cb: () => void): () => void
  // Fires once when the connection drops out of 'connected' (transient or terminal).
  onDisconnect(cb: () => void): () => void
  // Fires once when the connection reaches a terminal (unrecoverable) status.
  onGone(cb: () => void): () => void
  ingest(state: SshConnectionState | null): void
}

export function createAndroidHostReconnectSignal(): AndroidHostReconnectSignal {
  let phase: Phase = 'unknown'
  const reconnectCbs = new Set<() => void>()
  const disconnectCbs = new Set<() => void>()
  const goneCbs = new Set<() => void>()

  const fire = (cbs: Set<() => void>): void => {
    for (const cb of cbs) {
      cb()
    }
  }

  return {
    onReconnect(cb) {
      reconnectCbs.add(cb)
      return () => reconnectCbs.delete(cb)
    },
    onDisconnect(cb) {
      disconnectCbs.add(cb)
      return () => disconnectCbs.delete(cb)
    },
    onGone(cb) {
      goneCbs.add(cb)
      return () => goneCbs.delete(cb)
    },
    ingest(state) {
      const status = state?.status
      if (status === 'connected') {
        // A fresh reconnect after any down/gone phase; reconnectAttempt===0
        // mirrors the relay-rebuild trigger in ssh.ts.
        if ((phase === 'down' || phase === 'gone') && state?.reconnectAttempt === 0) {
          fire(reconnectCbs)
        }
        phase = 'up'
        return
      }
      const terminal = status === undefined || TERMINAL_STATUSES.has(status)
      // A drop out of 'connected' fires disconnect once, regardless of severity.
      if (phase === 'up') {
        fire(disconnectCbs)
      }
      if (terminal && phase !== 'gone') {
        fire(goneCbs)
        phase = 'gone'
        return
      }
      // Transient down ('reconnecting'/'connecting'/'deploying-relay'): keep
      // retrying. Don't downgrade an already-terminal 'gone' back to 'down'.
      if (phase !== 'gone') {
        phase = 'down'
      }
    }
  }
}
