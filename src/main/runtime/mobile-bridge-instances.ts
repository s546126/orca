import { EmulatorError } from '../emulator/emulator-errors'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import type { MobileDeviceBridge } from '../emulator/mobile-device-bridge'

// Process-wide active mobile bridge instances. Extracted from
// orca-runtime-emulator so that command surface stays under its line cap: the
// runtime wires the instances here and RuntimeEmulatorCommands reads them back.

// Singleton accessor pattern (mirror requireAgentBrowserBridge).
let emulatorBridgeInstance: EmulatorBridge | null = null

export function setEmulatorBridge(bridge: EmulatorBridge | null): void {
  emulatorBridgeInstance = bridge
}

export function getEmulatorBridge(): EmulatorBridge | null {
  return emulatorBridgeInstance
}

export function requireEmulatorBridge(): EmulatorBridge {
  if (!emulatorBridgeInstance) {
    throw new EmulatorError('emulator_no_active', 'Emulator bridge not initialized')
  }
  return emulatorBridgeInstance
}

// Why: Android is a sibling MobileDeviceBridge. Null until index wires it, so
// resolveBridge falls back to the iOS bridge and behaves exactly as today.
let androidBridgeInstance: MobileDeviceBridge | null = null

export function setAndroidBridge(bridge: MobileDeviceBridge | null): void {
  androidBridgeInstance = bridge
}

export function getAndroidBridge(): MobileDeviceBridge | null {
  return androidBridgeInstance
}
