import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import {
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'
import { canSelectAddRepoHost } from './add-repo-host-availability'
import { translate } from '@/i18n/i18n'

export function useAddRepoHostSelection({
  isOpen,
  setStep
}: {
  isOpen: boolean
  setStep: (step: AddRepoDialogStep) => void
}): {
  hostOptions: ReturnType<typeof useSidebarHostScopeOptions>['hostOptions']
  selectedHostId: ExecutionHostId
  selectedParsedHost: ReturnType<typeof parseExecutionHostId>
  selectedSshTargetId: string | null
  hostSelectorOpen: boolean
  setHostSelectorOpen: (open: boolean) => void
  handleSelectAddProjectHost: (hostId: ExecutionHostId) => Promise<void>
  handleConnectAddProjectHost: (hostId: ExecutionHostId) => Promise<void>
} {
  const settings = useAppStore((s) => s.settings)
  const switchRuntimeEnvironment = useAppStore((s) => s.switchRuntimeEnvironment)
  const setSshConnectionState = useAppStore((s) => s.setSshConnectionState)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const { hostOptions } = useSidebarHostScopeOptions()
  const [selectedAddProjectHostId, setSelectedAddProjectHostId] =
    useState<ExecutionHostId>(LOCAL_EXECUTION_HOST_ID)
  const [hostSelectorOpen, setHostSelectorOpen] = useState(false)
  const previousOpenRef = useRef(false)

  const selectedHost =
    hostOptions.find(
      (host) => host.id === selectedAddProjectHostId && canSelectAddRepoHost(host)
    ) ??
    hostOptions.find((host) => host.id === LOCAL_EXECUTION_HOST_ID && canSelectAddRepoHost(host)) ??
    hostOptions.find((host) => canSelectAddRepoHost(host)) ??
    hostOptions[0]
  const selectedHostId = selectedHost?.id ?? LOCAL_EXECUTION_HOST_ID
  const selectedParsedHost = parseExecutionHostId(selectedHostId)
  const selectedSshTargetId =
    selectedParsedHost?.kind === 'ssh' ? selectedParsedHost.targetId : null

  useEffect(() => {
    if (isOpen && !previousOpenRef.current) {
      const focusedHostId = getSettingsFocusedExecutionHostId(settings)
      const nextHostId = hostOptions.some(
        (host) => host.id === focusedHostId && canSelectAddRepoHost(host)
      )
        ? focusedHostId
        : LOCAL_EXECUTION_HOST_ID
      setSelectedAddProjectHostId(nextHostId)
    }
    if (!isOpen) {
      setHostSelectorOpen(false)
    }
    previousOpenRef.current = isOpen
  }, [hostOptions, isOpen, settings])

  const handleSelectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<void> => {
      const host = hostOptions.find((candidate) => candidate.id === hostId)
      if (!host || !canSelectAddRepoHost(host)) {
        return
      }
      const parsed = parseExecutionHostId(hostId)
      if (parsed?.kind === 'runtime') {
        const switched = await switchRuntimeEnvironment(parsed.environmentId)
        if (!switched) {
          return
        }
      } else if (settings?.activeRuntimeEnvironmentId?.trim()) {
        const switched = await switchRuntimeEnvironment(null)
        if (!switched) {
          return
        }
      }
      setSelectedAddProjectHostId(hostId)
      setStep('add')
    },
    [hostOptions, settings?.activeRuntimeEnvironmentId, setStep, switchRuntimeEnvironment]
  )

  const handleConnectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<void> => {
      const host = hostOptions.find((candidate) => candidate.id === hostId)
      const parsed = parseExecutionHostId(hostId)
      if (!host || parsed?.kind !== 'ssh') {
        return
      }

      const previousState = sshConnectionStates.get(parsed.targetId)
      // Why: ssh.connect can complete before the global state-change event
      // reaches the renderer; optimistic state keeps this picker responsive.
      setSshConnectionState(parsed.targetId, {
        targetId: parsed.targetId,
        status: 'connecting',
        error: null,
        reconnectAttempt: previousState?.reconnectAttempt ?? 0,
        remotePlatform: previousState?.remotePlatform
      })

      try {
        const connectResult = (await window.api.ssh.connect({
          targetId: parsed.targetId
        })) as SshConnectionState | null | undefined
        const state =
          connectResult ??
          ((await window.api.ssh.getState({
            targetId: parsed.targetId
          })) as SshConnectionState | null)
        if (state) {
          setSshConnectionState(parsed.targetId, state)
        }
        if (state?.status !== 'connected') {
          return
        }
        if (settings?.activeRuntimeEnvironmentId?.trim()) {
          const switched = await switchRuntimeEnvironment(null)
          if (!switched) {
            return
          }
        }
        setSelectedAddProjectHostId(hostId)
        setStep('add')
        setHostSelectorOpen(false)
      } catch (err) {
        setSshConnectionState(
          parsed.targetId,
          previousState ?? {
            targetId: parsed.targetId,
            status: 'disconnected',
            error:
              err instanceof Error
                ? err.message
                : translate(
                    'auto.components.sidebar.useAddRepoHostSelection.connectionFailed',
                    'SSH connection failed.'
                  ),
            reconnectAttempt: 0
          }
        )
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.sidebar.useAddRepoHostSelection.connectionFailed',
                'SSH connection failed.'
              )
        )
      }
    },
    [
      hostOptions,
      settings?.activeRuntimeEnvironmentId,
      setSshConnectionState,
      setStep,
      sshConnectionStates,
      switchRuntimeEnvironment
    ]
  )

  return {
    hostOptions,
    selectedHostId,
    selectedParsedHost,
    selectedSshTargetId,
    hostSelectorOpen,
    setHostSelectorOpen,
    handleSelectAddProjectHost,
    handleConnectAddProjectHost
  }
}
