// The default device selector is a UDID/serial the user chose deliberately (an
// Android AVD serial, an iOS Simulator UDID, or a still-connected ADB network
// serial). Reassigning the ADB address must only invalidate a default that
// specifically pointed at the ADB device that just went away — everything
// else (an unrelated Android emulator-* serial, an iOS UDID, or nothing
// selected) must survive untouched.
export function shouldClearAdbDefaultDevice(
  defaultDeviceUdid: string | null | undefined,
  previousRuntimeSerial: string | null | undefined
): boolean {
  if (!previousRuntimeSerial) {
    return false
  }
  return defaultDeviceUdid === previousRuntimeSerial
}
