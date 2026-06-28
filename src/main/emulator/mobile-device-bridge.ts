import type { EmulatorGesturePoint } from './emulator-gesture-sender'
import type { EmulatorSessionInfo } from './emulator-types'
import type { SimulatorDevice } from './simctl-simulator-devices'

// Why: the runtime drives iOS (EmulatorBridge) and Android (AndroidBridge) as
// sibling bridges. This captures the exact method surface the runtime + index
// already call on EmulatorBridge so both bridges are interchangeable behind one
// type. Type-only (.ts, not .d.ts) — no behavioral contract beyond signatures.
export type MobileDeviceTargetOptions = {
  device?: string
  worktreeId?: string
}

export type MobileDeviceExecOptions = {
  device?: string
  emulator?: string
  worktreeId?: string
}

export type MobileDeviceBridge = {
  startHelperForDevice(device: string): Promise<EmulatorSessionInfo>

  tap(x: number, y: number, opts?: MobileDeviceTargetOptions): Promise<void>
  gesture(points: EmulatorGesturePoint[], opts?: MobileDeviceTargetOptions): Promise<void>
  type(text: string, opts?: MobileDeviceTargetOptions): Promise<void>
  button(name: string, opts?: MobileDeviceTargetOptions): Promise<void>
  rotate(orientation: string, opts?: MobileDeviceTargetOptions): Promise<void>
  exec(command: string, opts?: MobileDeviceExecOptions): Promise<unknown>

  listSimulators(): Promise<SimulatorDevice[]>
  listRunningHelpers(): Promise<unknown>

  registerActiveEmulator(
    worktreeId: string,
    info: EmulatorSessionInfo,
    options?: { managed?: boolean }
  ): void
  unregisterActiveEmulator(worktreeId: string): void
  getActiveForWorktree(worktreeId?: string): EmulatorSessionInfo | null
  getReusableActiveForWorktree(
    worktreeId: string,
    device?: string
  ): Promise<EmulatorSessionInfo | null>
  stopActiveForWorktree(
    worktreeId: string,
    options?: { shutdownDevice?: boolean }
  ): Promise<string | null>
  stopActiveManagedForWorktree(
    worktreeId: string,
    options?: { shutdownDevice?: boolean }
  ): Promise<string | null>
  shutdownActiveManagedForWorktree(worktreeId: string): Promise<string | null>
  kill(device?: string, worktreeId?: string): Promise<string>
  shutdown(device?: string, worktreeId?: string): Promise<string>
  destroyAllSessions(): Promise<void>
  onAppQuit(): Promise<void>
}
