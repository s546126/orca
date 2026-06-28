import type { AdbCommandExecutor, AdbCommandResult } from './adb-command-execution'

// Pure parsers + thin executor calls for adb device discovery and boot waiting.
// Nothing here spawns; the executor is injected so tests run on fixture output.

export const ADB_PROGRAM = 'adb'
// Default redroid endpoint on the host where adb runs (local or, over SSH, the
// remote host) — adb-server speaks to redroid over loopback TCP.
export const DEFAULT_REDROID_SERIAL = '127.0.0.1:5555'

export type AdbDeviceState =
  | 'device'
  | 'offline'
  | 'unauthorized'
  | 'bootloader'
  | 'recovery'
  | 'authorizing'
  | 'sideload'
  | 'no permissions'
  | 'unknown'

export type AdbDevice = {
  serial: string
  state: AdbDeviceState
  product?: string
  model?: string
  device?: string
  transportId?: string
}

const KNOWN_STATES: ReadonlySet<string> = new Set([
  'device',
  'offline',
  'unauthorized',
  'bootloader',
  'recovery',
  'authorizing',
  'sideload'
])

// Pure: parse `adb devices -l` stdout into structured rows. Skips the header and
// daemon chatter; `no permissions` (which contains a space) is special-cased.
export function parseAdbDevices(stdout: string): AdbDevice[] {
  const devices: AdbDevice[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) {
      continue
    }
    if (line.startsWith('adb server') || line.startsWith('error:')) {
      continue
    }
    const tokens = line.split(/\s+/)
    const serial = tokens[0]
    if (!serial) {
      continue
    }
    if (/\bno permissions\b/.test(line)) {
      devices.push({ serial, state: 'no permissions' })
      continue
    }
    const rawState = tokens[1] ?? 'unknown'
    const state: AdbDeviceState = KNOWN_STATES.has(rawState)
      ? (rawState as AdbDeviceState)
      : 'unknown'
    const descriptors: Record<string, string> = {}
    for (const token of tokens.slice(2)) {
      const idx = token.indexOf(':')
      if (idx > 0) {
        descriptors[token.slice(0, idx)] = token.slice(idx + 1)
      }
    }
    devices.push({
      serial,
      state,
      product: descriptors.product,
      model: descriptors.model,
      device: descriptors.device,
      transportId: descriptors.transport_id
    })
  }
  return devices
}

// Pure: getprop sys.boot_completed prints exactly `1` once Android finished boot.
export function parseBootCompleted(stdout: string): boolean {
  return stdout.trim() === '1'
}

// Pick the serial to drive: an explicit one wins, else the first fully-online
// device, else the redroid default so `adb connect` can bring it up.
export function resolveSerial(devices: AdbDevice[], preferred?: string): string {
  if (preferred) {
    return preferred
  }
  const online = devices.find((entry) => entry.state === 'device')
  return online ? online.serial : DEFAULT_REDROID_SERIAL
}

export function buildDevicesArgs(): string[] {
  return ['devices', '-l']
}

export function buildConnectArgs(serial: string): string[] {
  return ['connect', serial]
}

export function buildBootCompletedArgs(serial: string): string[] {
  return ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']
}

export async function listAdbDevices(executor: AdbCommandExecutor): Promise<AdbDevice[]> {
  const result = await executor.exec(ADB_PROGRAM, buildDevicesArgs())
  return parseAdbDevices(result.stdout)
}

export async function adbConnect(
  executor: AdbCommandExecutor,
  serial: string
): Promise<AdbCommandResult> {
  return executor.exec(ADB_PROGRAM, buildConnectArgs(serial))
}

export async function getBootCompleted(
  executor: AdbCommandExecutor,
  serial: string
): Promise<boolean> {
  const result = await executor.exec(ADB_PROGRAM, buildBootCompletedArgs(serial))
  return parseBootCompleted(result.stdout)
}

// Injected clock/sleep so the boot-wait poll is testable without real time.
export type WaitClock = {
  now(): number
  sleep(ms: number): Promise<void>
}

export type BootWaitOptions = {
  executor: AdbCommandExecutor
  serial: string
  timeoutMs: number
  pollIntervalMs: number
  clock: WaitClock
}

// Poll getprop sys.boot_completed until it reads `1` or the timeout elapses.
// Probes at least once; returns true on boot, false on timeout. The Android
// analogue of waitForServeSimEndpointReady.
export async function waitForBootCompleted(options: BootWaitOptions): Promise<boolean> {
  const { executor, serial, timeoutMs, pollIntervalMs, clock } = options
  const start = clock.now()
  for (;;) {
    if (await getBootCompleted(executor, serial)) {
      return true
    }
    if (clock.now() - start >= timeoutMs) {
      return false
    }
    await clock.sleep(pollIntervalMs)
  }
}
