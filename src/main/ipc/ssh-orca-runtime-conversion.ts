import { app, ipcMain } from 'electron'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { convertSshHostToOrcaRuntime } from '../ssh/ssh-remote-orca-server-conversion'
import { getSshConnectionManager, getSshConnectionStore } from './ssh'

const CHANNEL = 'ssh:convertToOrcaRuntime'

export type SshConvertToOrcaRuntimeResult = {
  environment: PublicKnownRuntimeEnvironment
}

// Why: `name` collides with an existing environment name are rejected by
// addEnvironmentFromPairingCode; suffixing "(SSH)" keeps the default distinct
// from a runtime environment the user may have already paired manually.
function buildRuntimeEnvironmentName(hostLabel: string): string {
  return `${hostLabel} (SSH)`
}

export function registerSshOrcaRuntimeConversionHandlers(): void {
  ipcMain.removeHandler(CHANNEL)
  ipcMain.handle(
    CHANNEL,
    async (_event, args: { targetId: string }): Promise<SshConvertToOrcaRuntimeResult> => {
      const sshStore = getSshConnectionStore()
      const connectionManager = getSshConnectionManager()
      if (!sshStore || !connectionManager) {
        throw new Error('SSH is not initialized.')
      }

      const target = sshStore.getTarget(args.targetId)
      if (!target) {
        throw new Error('SSH host not found.')
      }

      const state = connectionManager.getState(args.targetId)
      const conn = connectionManager.getConnection(args.targetId)
      if (!conn || state?.status !== 'connected') {
        throw new Error(`Connect to "${target.label}" before converting it into an Orca runtime.`)
      }

      const ready = await convertSshHostToOrcaRuntime(conn, {
        pairingAddress: target.host
      })

      const environment = addEnvironmentFromPairingCode(app.getPath('userData'), {
        name: buildRuntimeEnvironmentName(target.label),
        pairingCode: ready.pairingUrl,
        source: 'manual'
      })

      return { environment: redactRuntimeEnvironment(environment) }
    }
  )
}
